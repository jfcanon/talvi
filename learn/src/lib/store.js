// talvi-learn D1 layer (blueprint B.4 / decision 3). The tribunal's
// files-as-ledger doctrine mirrored: xp_events is the append-only source of
// truth; lesson_progress and player_state are DERIVED tables, rebuildable from
// the ledger by re-running the reduction. The checkpoint gate records the
// verdicts that unlock the next unit.
//
// CREATE TABLE IF NOT EXISTS at the top of any handler touching D1 — talvi's
// idiom, no migration tooling. ISO timestamps are always computed in JS
// (new Date().toISOString()), never SQL datetime() (blueprint B.4).
//
// Single-owner by design (decision 2 / Part D non-goals): player_id is the
// fixed key "owner".

// The B.4 DDL. Idempotent: CREATE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS,
// safe to run on every request that touches D1.
export async function ensureSchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS xp_events (
        id         TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        lesson_id  TEXT NOT NULL,
        skill      TEXT NOT NULL,
        xp         INTEGER NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_xp_events_ts     ON xp_events(ts)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_xp_events_lesson ON xp_events(lesson_id)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS lesson_progress (
        lesson_id    TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        mastered_at  TEXT,
        legendary_at TEXT
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_state (
        player_id  TEXT PRIMARY KEY,
        streak     INTEGER NOT NULL DEFAULT 0,
        hearts     INTEGER NOT NULL DEFAULT 0,
        last_seen  TEXT,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS checkpoint_verdicts (
        checkpoint_id TEXT PRIMARY KEY,
        verdict       TEXT NOT NULL,
        submitted_at  TEXT NOT NULL
      )`,
    ),
  ]);
}

// The append-only event insert. Completion idempotency: xp_events.id is the
// client-generated event id; INSERT OR IGNORE makes a duplicate completion a
// no-op instead of a double award (risk row: "completion idempotency via
// server-checked unique xp_events.id").
//
// Returns true when a new row was actually written, false when it was a
// duplicate.
export async function recordXp(db, { id, ts, lessonId, skill, xp }) {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO xp_events (id, ts, lesson_id, skill, xp)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, ts, lessonId, skill, xp)
    .run();
  return res.meta.changes > 0;
}

// The checkpoint gate: a freeform verdict the player writes and submits
// (mirror hub gate). Auto-pass on submission for MVP (converged plan §9.2) —
// the verdict is stored in the gate record for later review.
export async function recordCheckpoint(db, checkpointId, verdict) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO checkpoint_verdicts (checkpoint_id, verdict, submitted_at)
       VALUES (?, ?, ?)`,
    )
    .bind(checkpointId, verdict, new Date().toISOString())
    .run();
}

// The reduction. Reads the whole ledger (a single human playing: thousands of
// rows at most) and rebuilds the derived state in JS — the files-as-ledger
// doctrine, and the exact thing that makes state rebuildable from the ledger
// alone (blueprint B.4, PR4 verify).
//
//   lessons[lessonId] = {
//     passes,            // number of completed sittings (xp events)
//     status,            // not_started | mastered | legendary
//     masteredAt,
//     legendaryAt,
//   }
//   player = { streak, hearts, lastSeen }
//
// Legendary = the >=3 validated sittings rule (skills compounding,
// _claims-schema.md:Lifecycle); mastered = a claim with >=1 real re-check
// (replaying a mastered node advances it). Concretely: 1 pass = mastered,
// >=3 passes = legendary. Streak counts consecutive UTC days with a pass,
// computed on the UTC day boundary (blueprint A3 note).
export function reduceState(events) {
  const byLesson = new Map();
  const days = new Set();

  for (const ev of events) {
    const l = byLesson.get(ev.lesson_id) || { passes: 0, masteredAt: null, legendaryAt: null };
    l.passes += 1;
    const day = ev.ts.slice(0, 10);
    days.add(day);
    if (l.masteredAt === null) l.masteredAt = ev.ts;
    if (l.passes >= 3 && l.legendaryAt === null) l.legendaryAt = ev.ts;
    byLesson.set(ev.lesson_id, l);
  }

  const lessons = {};
  for (const [lessonId, l] of byLesson) {
    lessons[lessonId] = {
      passes: l.passes,
      status: l.passes >= 3 ? "legendary" : l.passes >= 1 ? "mastered" : "not_started",
      masteredAt: l.masteredAt,
      legendaryAt: l.legendaryAt,
    };
  }

  // Streak: consecutive UTC days ending today or yesterday (a missed day
  // resets the streak). Yesterday is still "alive" — the player hasn't lost
  // the streak until the current UTC day has ended without a pass.
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }

  return { lessons, player: { streak, hearts: 0, lastSeen: days.size ? maxDay(days) : null } };
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

// Persist the reduced lesson_progress rows. The ledger remains authoritative;
// these tables are the rebuildable materialisation the blueprint specifies.
export async function syncProgress(db, lessons) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO lesson_progress
       (lesson_id, status, attempts, mastered_at, legendary_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const batch = [];
  for (const [lessonId, l] of Object.entries(lessons)) {
    batch.push(
      stmt.bind(
        lessonId,
        l.status,
        l.passes,
        l.masteredAt,
        l.legendaryAt,
      ),
    );
  }
  if (batch.length) await db.batch(batch);
}

// Persist the reduced player_state row.
export async function syncPlayer(db, player) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO player_state
         (player_id, streak, hearts, last_seen, updated_at)
       VALUES ('owner', ?, ?, ?, ?)`,
    )
    .bind(player.streak, player.hearts, player.lastSeen, new Date().toISOString())
    .run();
}

// Read the whole reduced state: rebuild it from the ledger (the source of
// truth), then sync the derived tables so they never drift.
export async function readState(db) {
  const rows = await db.prepare(`SELECT id, ts, lesson_id, skill, xp FROM xp_events ORDER BY ts`).all();
  const { lessons, player } = reduceState(rows.results || []);
  await syncProgress(db, lessons);
  await syncPlayer(db, player);
  return { lessons, player };
}

// Which checkpoint gates are open (a verdict exists for them).
export async function readOpenGates(db) {
  const rows = await db
    .prepare(`SELECT checkpoint_id, verdict, submitted_at FROM checkpoint_verdicts`)
    .all();
  const gates = {};
  for (const r of rows.results || []) gates[r.checkpoint_id] = r;
  return gates;
}
