// talvi-learn D1 layer (decision 3 / PR4 converged schema). The tribunal's
// files-as-ledger doctrine mirrored: xp_events is the append-only source of
// truth; lesson_progress and player_state are DERIVED tables, rebuildable from
// the ledger by re-running the reduction. player_state.xp is a CACHE of
// SUM(xp_events.xp) — never a second store of truth.
//
// CREATE TABLE IF NOT EXISTS at the top of any handler touching D1 — talvi's
// idiom, no migration tooling. ISO timestamps are always computed in JS
// (new Date().toISOString()), never SQL datetime().
//
// Schema is the converged PR4 shape (per-user derived tables):
//   xp_events(id INTEGER PK AUTOINCREMENT, ts, lesson_id, skill, xp)
//   lesson_progress(user_id, lesson_id, state, best_score, attempts, last_completed_at, PK(user_id, lesson_id))
//   player_state(user_id PK, xp, streak_days, last_day, hearts, level, updated_at)

// Server-side award policy (the client never sends an XP amount — the server
// evaluates, decision "evaluates server-side" in the PR4 brief). MVP: a flat
// 10 XP per completed lesson; PR6 refines per-exercise scoring.
export const XP_PER_LESSON = 10;

// Level curve: 100 XP per level. levelFor() is the single place a level is
// computed; player_state.level is derived from xp on every reduction.
export function levelFor(xp) {
  return Math.floor(xp / 100) + 1;
}

// The B.4-derived DDL. Idempotent: CREATE IF NOT EXISTS + CREATE INDEX IF NOT
// EXISTS, safe to run on every request that touches D1.
export async function ensureSchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS xp_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        lesson_id  TEXT NOT NULL,
        skill      TEXT NOT NULL,
        xp         INTEGER NOT NULL
      )`,
    ),
    // One event per lesson (single-owner): the DB-level backstop that makes
    // "double-POST does not double-XP" true even under a concurrent duplicate,
    // not just in the app-layer read check.
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_xp_events_lesson ON xp_events(lesson_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_xp_events_ts ON xp_events(ts)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS lesson_progress (
        user_id           TEXT NOT NULL,
        lesson_id         TEXT NOT NULL,
        state             TEXT NOT NULL,
        best_score        INTEGER NOT NULL DEFAULT 0,
        attempts          INTEGER NOT NULL DEFAULT 0,
        last_completed_at TEXT,
        PRIMARY KEY (user_id, lesson_id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_state (
        user_id    TEXT PRIMARY KEY,
        xp         INTEGER NOT NULL DEFAULT 0,
        streak_days INTEGER NOT NULL DEFAULT 0,
        last_day   TEXT,
        hearts     INTEGER NOT NULL DEFAULT 0,
        level      INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )`,
    ),
  ]);
}

// Reduce the ledger (the source of truth) to derived state. The ledger is
// app-wide (xp_events has no user_id column — single-owner MVP); the derived
// tables are per-user for forward-compat.
//
//   lessons[lessonId] = { state, bestScore, attempts, lastCompletedAt }
//   player = { xp, streakDays, lastDay }
//
// Idempotency + mastery are both ledger-derived: a lesson with an event is
// 'mastered'; with >=3 events it is 'legendary' (the >=3 validated sittings
// rule, _claims-schema.md:Lifecycle). Because /api/complete awards exactly one
// event per lesson, MVP lessons land at 'mastered'.
export function reduceLedger(events) {
  const byLesson = new Map();
  const days = new Set();
  let xp = 0;

  for (const ev of events) {
    xp += Number(ev.xp || 0);
    const day = String(ev.ts || "").slice(0, 10);
    if (day) days.add(day);
    const l = byLesson.get(ev.lesson_id) || { bestScore: 0, attempts: 0, lastCompletedAt: null };
    l.attempts += 1;
    l.bestScore = Math.max(l.bestScore, Number(ev.xp || 0));
    if (l.lastCompletedAt === null || ev.ts > l.lastCompletedAt) l.lastCompletedAt = ev.ts;
    byLesson.set(ev.lesson_id, l);
  }

  const lessons = {};
  for (const [lessonId, l] of byLesson) {
    lessons[lessonId] = {
      state: l.attempts >= 3 ? "legendary" : "mastered",
      bestScore: l.bestScore,
      attempts: l.attempts,
      lastCompletedAt: l.lastCompletedAt,
    };
  }

  // Streak: consecutive UTC days ending today or yesterday (a missed day
  // resets the streak). Yesterday is still "alive" — the player hasn't lost
  // the streak until the current UTC day has ended without a completion.
  let streakDays = 0;
  const today = new Date().toISOString().slice(0, 10);
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  while (days.has(cursor)) {
    streakDays += 1;
    cursor = shiftDay(cursor, -1);
  }

  return {
    lessons,
    player: { xp, streakDays, lastDay: days.size ? maxDay(days) : null },
  };
}

// Sync the derived tables from the reduced state so they never drift. The
// ledger remains authoritative; these are the rebuildable materialisation.
// `hearts` (optional-off feature, decision 6) is passed through untouched.
export async function syncDerived(db, userId, { lessons, player }, hearts = 0) {
  const now = new Date().toISOString();
  const batch = [];

  for (const [lessonId, l] of Object.entries(lessons)) {
    batch.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO lesson_progress
             (user_id, lesson_id, state, best_score, attempts, last_completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, lessonId, l.state, l.bestScore, l.attempts, l.lastCompletedAt),
    );
  }

  batch.push(
    db
      .prepare(
        `INSERT OR REPLACE INTO player_state
           (user_id, xp, streak_days, last_day, hearts, level, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        player.xp,
        player.streakDays,
        player.lastDay,
        hearts,
        levelFor(player.xp),
        now,
      ),
  );

  if (batch.length) await db.batch(batch);
}

// The aggregated player state for the API: rebuilds everything from the
// ledger, refreshes the derived tables (so player_state.xp is a truthful
// cache of SUM(xp_events.xp)), then preserves stored hearts across the sync.
export async function readState(db, userId) {
  await ensureSchema(db);

  const rows = await db.prepare(`SELECT id, ts, lesson_id, skill, xp FROM xp_events ORDER BY ts`).all();
  const { lessons, player } = reduceLedger(rows.results || []);

  // Preserve stored hearts (optional-off feature, decision 6) across the
  // derived-table refresh — a value is never clobbered to 0 on read.
  let hearts = 0;
  const stored = await db
    .prepare(`SELECT hearts FROM player_state WHERE user_id = ?`)
    .bind(userId)
    .first();
  if (stored && Number.isFinite(Number(stored.hearts))) hearts = Number(stored.hearts);

  await syncDerived(db, userId, { lessons, player }, hearts);

  return {
    player: {
      xp: player.xp,
      streakDays: player.streakDays,
      lastDay: player.lastDay,
      hearts,
      level: levelFor(player.xp),
      updatedAt: new Date().toISOString(),
    },
    lessons,
  };
}

// Append one xp_events row and refresh the derived tables. Idempotent per
// lesson: a lesson already 'mastered'/'legendary' (has a ledger event) is a
// no-op — double-POST does not double-XP. The unique index on
// xp_events(lesson_id) backs this up at the storage layer.
//
// Returns { gained, alreadyCompleted, player }.
export async function recordCompletion(db, userId, { lessonId, skill, ts }) {
  await ensureSchema(db);

  // The idempotency gate: a completed lesson is never re-awarded.
  const existing = await db
    .prepare(`SELECT state FROM lesson_progress WHERE user_id = ? AND lesson_id = ?`)
    .bind(userId, lessonId)
    .first();
  if (existing && (existing.state === "mastered" || existing.state === "legendary")) {
    const state = await readState(db, userId);
    return { gained: 0, alreadyCompleted: true, player: state.player };
  }

  // Evaluate server-side: the award is fixed by policy, never client-supplied.
  const xp = XP_PER_LESSON;

  // Streak update (once per day): a second completion today must not double
  // the streak. Basis is the stored last_day.
  const prev = await db
    .prepare(`SELECT streak_days, last_day, hearts FROM player_state WHERE user_id = ?`)
    .bind(userId)
    .first();
  const today = ts.slice(0, 10);
  const prevStreak = Number(prev?.streak_days || 0);
  const prevLastDay = prev?.last_day || null;
  const hearts = Number(prev?.hearts || 0);
  let streakDays;
  if (prevLastDay === today) streakDays = prevStreak;
  else if (prevLastDay === shiftDay(today, -1)) streakDays = prevStreak + 1;
  else streakDays = 1;

  // New cache values. xp starts from the ledger sum (never trusts the cache).
  const sumRow = await db.prepare(`SELECT COALESCE(SUM(xp), 0) AS total FROM xp_events`).first();
  const newXp = Number(sumRow?.total || 0) + xp;

  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO xp_events (ts, lesson_id, skill, xp) VALUES (?, ?, ?, ?)`)
      .bind(ts, lessonId, skill, xp),
    db
      .prepare(
        `INSERT OR REPLACE INTO lesson_progress
           (user_id, lesson_id, state, best_score, attempts, last_completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, lessonId, "mastered", xp, 1, ts),
    db
      .prepare(
        `INSERT OR REPLACE INTO player_state
           (user_id, xp, streak_days, last_day, hearts, level, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, newXp, streakDays, today, hearts, levelFor(newXp), ts),
  ]);

  return {
    gained: xp,
    alreadyCompleted: false,
    player: { xp: newXp, streakDays, lastDay: today, hearts, level: levelFor(newXp), updatedAt: ts },
  };
}

function shiftDay(isoDay, deltaDays) {
  const d = new Date(isoDay + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function maxDay(days) {
  let max = "";
  for (const d of days) if (d > max) max = d;
  return max;
}
