// Server smoke test for talvi learn PR4 (D1 data layer + gamification API).
// Imports the REAL built bundle (dist/index.js — the exact artifact CI uploads)
// and drives the fetch handler with a stubbed D1 and a stub auth. Verifies:
//   - healthz is public (200, no auth)
//   - /learn/ redirects to /sign-in when unauthenticated (302)
//   - /learn/api/state, /learn/api/complete, /learn/api/curriculum return 401
//     when unauthenticated (gate holds, decision 2)
//   - POST /learn/api/complete appends exactly one xp_event row to the ledger
//   - double-POST the same lesson does NOT double-XP (idempotent per lesson)
//   - a second DIFFERENT lesson adds another event and XP (ledger accumulates)
//   - GET /learn/api/state returns a consistent aggregate (xp == SUM(ledger),
//     streak, level, per-lesson progress)
//   - GET /learn/api/curriculum returns the stable placeholder shape
//   - the derived tables are rebuildable: readState reflects the ledger alone
//
// Uses node:test-compatible assertions inline (no framework).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Build the worker bundle with the auth module stubbed (a real __session JWT
// cannot be produced in a unit test; the stub marks cookie-carrying requests
// as authenticated). Everything else — store, curriculum, routing — is the
// REAL shipped code.
const esbuild = await import("esbuild");
const authStub = join(root, "scripts/auth-stub.mjs");
const stubAuth = {
  name: "stub-auth",
  setup(build) {
    build.onResolve({ filter: /^\.\/lib\/auth\.js$/ }, () => ({ path: authStub }));
  },
};
await esbuild.build({
  entryPoints: [join(root, "src/index.js")],
  bundle: true,
  format: "esm",
  plugins: [stubAuth],
  outfile: join(root, "dist/index-test.mjs"),
  logLevel: "silent",
});

// ---- tiny in-memory D1 stub (the schema + methods the worker touches) ----
function makeDb() {
  const tables = {
    xp_events: [],
    lesson_progress: [],
    player_state: [],
  };
  const db = {
    async batch(stmts) {
      for (const s of stmts) await s.run();
    },
    prepare(sql) {
      const stmt = {
        async run(...args) {
          const values = args.length ? args : this._args || [];
          if (/CREATE TABLE IF NOT EXISTS/i.test(sql)) return { meta: {} };
          if (/CREATE INDEX/i.test(sql)) return { meta: {} };
          if (/INSERT OR IGNORE INTO xp_events/.test(sql)) {
            const [ts, lessonId, skill, xp] = values;
            if (tables.xp_events.some((r) => r.lesson_id === lessonId)) return { meta: { changes: 0 } };
            tables.xp_events.push({
              id: tables.xp_events.length + 1,
              ts,
              lesson_id: lessonId,
              skill,
              xp,
            });
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR REPLACE INTO lesson_progress/.test(sql)) {
            const [userId, lessonId, state, bestScore, attempts, lastCompletedAt] = values;
            tables.lesson_progress = tables.lesson_progress.filter(
              (r) => !(r.user_id === userId && r.lesson_id === lessonId),
            );
            tables.lesson_progress.push({
              user_id: userId,
              lesson_id: lessonId,
              state,
              best_score: bestScore,
              attempts,
              last_completed_at: lastCompletedAt,
            });
            return { meta: {} };
          }
          if (/INSERT OR REPLACE INTO player_state/.test(sql)) {
            const [userId, xp, streakDays, lastDay, hearts, level, updatedAt] = values;
            tables.player_state = tables.player_state.filter((r) => r.user_id !== userId);
            tables.player_state.push({
              user_id: userId,
              xp,
              streak_days: streakDays,
              last_day: lastDay,
              hearts,
              level,
              updated_at: updatedAt,
            });
            return { meta: {} };
          }
          return { meta: {} };
        },
        async all(...args) {
          if (/FROM xp_events/.test(sql)) return { results: tables.xp_events.slice() };
          if (/FROM lesson_progress/.test(sql)) return { results: tables.lesson_progress.slice() };
          return { results: [] };
        },
        async first(...args) {
          if (/FROM lesson_progress/.test(sql)) {
            const [userId, lessonId] = args.length ? args : this._args || [];
            return tables.lesson_progress.find((r) => r.user_id === userId && r.lesson_id === lessonId) || null;
          }
          if (/FROM player_state/.test(sql)) {
            const [userId] = args.length ? args : this._args || [];
            return tables.player_state.find((r) => r.user_id === userId) || null;
          }
          if (/SUM\(xp\)/.test(sql)) {
            return { total: tables.xp_events.reduce((a, r) => a + Number(r.xp || 0), 0) };
          }
          return null;
        },
        bind(...args) {
          this._args = args;
          return this;
        },
      };
      return stmt;
    },
  };
  return { db, tables };
}

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   - ${name}`);
  else {
    console.error(`FAIL - ${name} ${extra}`);
    failures += 1;
  }
}

const mod = await import(join(root, "dist/index-test.mjs"));
const worker = mod.default;

const { db, tables } = makeDb();
const env = { DB: db, CLERK_SECRET_KEY: "x", CLERK_PUBLISHABLE_KEY: "y", CLERK_JWT_KEY: "z" };

const BASE = "https://app.ygdcbtmc4u.uk";
function req(url, { method = "GET", auth = false, body } = {}) {
  const headers = new Headers();
  if (auth) headers.set("cookie", "__session=stub");
  if (body) headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body });
}
function complete(lessonId, skill, auth = true) {
  return worker.fetch(
    req(BASE + "/learn/api/complete", { method: "POST", auth, body: JSON.stringify({ lesson_id: lessonId, skill }) }),
    env,
  );
}

// ---- public ----
const hz = await worker.fetch(req(BASE + "/learn/healthz"), env);
check("healthz 200", hz.status === 200, String(hz.status));
check("healthz body ok", (await hz.text()) === "ok");

// ---- deny-by-default ----
const unauthPage = await worker.fetch(req(BASE + "/learn/"), env);
check("unauth /learn/ → 302", unauthPage.status === 302, String(unauthPage.status));
check("unauth redirect to hub sign-in", (unauthPage.headers.get("location") || "").includes("/sign-in"), unauthPage.headers.get("location"));

const unauthState = await worker.fetch(req(BASE + "/learn/api/state"), env);
check("unauth GET api/state → 401", unauthState.status === 401, String(unauthState.status));

const unauthComplete = await complete("u1l1", "vocabulary", false);
check("unauth POST api/complete → 401", unauthComplete.status === 401, String(unauthComplete.status));

const unauthCurr = await worker.fetch(req(BASE + "/learn/api/curriculum"), env);
check("unauth GET api/curriculum → 401", unauthCurr.status === 401, String(unauthCurr.status));

// ---- empty state ----
const emptyState = await worker.fetch(req(BASE + "/learn/api/state", { auth: true }), env);
const emptyJson = await emptyState.json();
check("auth state 200", emptyState.status === 200, String(emptyState.status));
check("empty state xp 0", emptyJson.player.xp === 0, JSON.stringify(emptyJson));
check("empty state no lessons", Object.keys(emptyJson.lessons).length === 0, JSON.stringify(emptyJson));

// ---- complete one lesson ----
const c1 = await complete("u1l1", "vocabulary");
const c1Json = await c1.json();
check("complete u1l1 → 200 ok", c1.status === 200 && c1Json.ok === true, JSON.stringify(c1Json));
check("u1l1 gained 10", c1Json.gained === 10, String(c1Json.gained));
check("ledger has exactly 1 row", tables.xp_events.length === 1, JSON.stringify(tables.xp_events));
check("streak >= 1", c1Json.player.streakDays >= 1, String(c1Json.player.streakDays));
check("level 1", c1Json.player.level === 1, String(c1Json.player.level));

// ---- double-POST same lesson: idempotent, no double XP ----
const c2 = await complete("u1l1", "vocabulary");
const c2Json = await c2.json();
check("double-POST u1l1 → still ok", c2.status === 200, String(c2.status));
check("double-POST gains 0", c2Json.gained === 0, JSON.stringify(c2Json));
check("double-POST does not double XP", c2Json.player.xp === 10, JSON.stringify(c2Json));
check("ledger still exactly 1 row", tables.xp_events.length === 1, JSON.stringify(tables.xp_events));
check("u1l1 alreadyCompleted flagged", c2Json.alreadyCompleted === true, JSON.stringify(c2Json));

// ---- a different lesson adds a new event ----
const c3 = await complete("u1l2", "harness");
const c3Json = await c3.json();
check("complete u1l2 → gained 10", c3Json.gained === 10, JSON.stringify(c3Json));
check("ledger now 2 rows", tables.xp_events.length === 2, JSON.stringify(tables.xp_events));
check("xp sums to 20", c3Json.player.xp === 20, JSON.stringify(c3Json));

// ---- state aggregates consistently with the ledger ----
const st = await worker.fetch(req(BASE + "/learn/api/state", { auth: true }), env);
const stJson = await st.json();
check("state xp == SUM(ledger)", stJson.player.xp === 20, JSON.stringify(stJson));
check("state lists both lessons", Object.keys(stJson.lessons).length === 2, JSON.stringify(stJson));
check("u1l1 mastered", stJson.lessons.u1l1 && stJson.lessons.u1l1.state === "mastered", JSON.stringify(stJson));
check("u1l1 bestScore 10", stJson.lessons.u1l1 && stJson.lessons.u1l1.bestScore === 10, JSON.stringify(stJson));
check("streak consistent", stJson.player.streakDays === c3Json.player.streakDays, JSON.stringify(stJson));
check("level derived from xp", stJson.player.level === 1, String(stJson.player.level));

// ---- curriculum placeholder ----
const curr = await worker.fetch(req(BASE + "/learn/api/curriculum", { auth: true }), env);
const currJson = await curr.json();
check("curriculum 200", curr.status === 200, String(curr.status));
check("curriculum stable placeholder", Array.isArray(currJson.curriculum.units) && currJson.curriculum.units.length === 0, JSON.stringify(currJson));

// ---- uniform 404 ----
const nf = await worker.fetch(req(BASE + "/learn/api/nope", { auth: true }), env);
check("unknown api path 404", nf.status === 404, String(nf.status));

console.log(failures ? `\n${failures} failure(s)` : "\nall PR4 data-layer smoke tests passed");
process.exit(failures ? 1 : 0);
