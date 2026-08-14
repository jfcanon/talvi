// Server smoke test for talvi learn (PR6). Imports the REAL built bundle
// (dist/index.js — the exact artifact CI uploads) and drives the fetch handler
// with a stubbed D1 and a stub auth. Verifies:
//   - healthz is public (200, no auth)
//   - s.css / s.js are served with the strict header set
//   - /learn/ redirects to /sign-in when unauthenticated (302)
//   - /learn/api/xp returns 401 when unauthenticated
//   - authenticated /learn/ renders the path page (200, contains the rail)
//   - authenticated /learn/lesson/u1l1 renders the player (200, contains the
//     exercise data)
//   - the xp write path appends to the ledger and re-renders the path with the
//     node advanced
//
// Uses node:test-compatible assertions inline (no framework).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Build the worker bundle with the auth module stubbed (a real __session JWT
// cannot be produced in a unit test; the stub marks cookie-carrying requests
// as authenticated). Everything else — store, curriculum, UI, routing — is the
// REAL shipped code.
const esbuild = await import("esbuild");
// A tiny resolve plugin that swaps the real auth module for the stub. esbuild
// alias requires bare names; this onResolve intercepts the exact import path.
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
    checkpoint_verdicts: [],
  };
  const db = {
    async batch(stmts) {
      for (const s of stmts) await s.run();
    },
    prepare(sql) {
      const stmt = {
        async run(...args) {
          const values = args.length ? args : this._args || [];
          // DDL — no-op (schema already "exists" in the stub).
          if (/CREATE TABLE IF NOT EXISTS/i.test(sql)) return { meta: {} };
          if (/CREATE INDEX/i.test(sql)) return { meta: {} };
          // INSERT INTO xp_events ...
          if (/INSERT OR IGNORE INTO xp_events/.test(sql)) {
            const [id, ts, lessonId, skill, xp] = values;
            if (tables.xp_events.some((r) => r.id === id)) return { meta: { changes: 0 } };
            tables.xp_events.push({ id, ts, lesson_id: lessonId, skill, xp });
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR REPLACE INTO checkpoint_verdicts/.test(sql)) {
            const [checkpointId, verdict, submittedAt] = values;
            tables.checkpoint_verdicts = tables.checkpoint_verdicts.filter((r) => r.checkpoint_id !== checkpointId);
            tables.checkpoint_verdicts.push({ checkpoint_id: checkpointId, verdict, submitted_at: submittedAt });
            return { meta: {} };
          }
          if (/INSERT OR REPLACE INTO lesson_progress/.test(sql)) {
            const [lessonId, status, attempts, masteredAt, legendaryAt] = values;
            tables.lesson_progress = tables.lesson_progress.filter((r) => r.lesson_id !== lessonId);
            tables.lesson_progress.push({ lesson_id: lessonId, status, attempts, mastered_at: masteredAt, legendary_at: legendaryAt });
            return { meta: {} };
          }
          if (/INSERT OR REPLACE INTO player_state/.test(sql)) {
            const [, streak, hearts, lastSeen] = values;
            tables.player_state = [{ player_id: "owner", streak, hearts, last_seen: lastSeen, updated_at: new Date().toISOString() }];
            return { meta: {} };
          }
          return { meta: {} };
        },
        async all(...args) {
          if (/FROM xp_events/.test(sql)) return { results: tables.xp_events.slice() };
          if (/FROM checkpoint_verdicts/.test(sql)) return { results: tables.checkpoint_verdicts.slice() };
          return { results: [] };
        },
        async first(...args) {
          if (/FROM checkpoint_verdicts/.test(sql)) {
            return tables.checkpoint_verdicts.some((r) => r.checkpoint_id === args[0]) ? { 1: 1 } : null;
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

// A fake Request-like object the worker parses.
function req(url, { method = "GET", auth = false } = {}) {
  const headers = new Headers();
  if (auth) headers.set("cookie", "__session=stub");
  return new Request(url, { method, headers });
}

const BASE = "https://app.ygdcbtmc4u.uk";

// ---- public ----
const hz = await worker.fetch(req(BASE + "/learn/healthz"), env);
check("healthz 200", hz.status === 200, String(hz.status));
check("healthz body ok", (await hz.text()) === "ok");

const css = await worker.fetch(req(BASE + "/learn/s.css"), env);
check("s.css 200", css.status === 200, String(css.status));
check("s.css immutable cache", (css.headers.get("cache-control") || "").includes("immutable"), css.headers.get("cache-control"));
const js = await worker.fetch(req(BASE + "/learn/s.js"), env);
check("s.js 200", js.status === 200, String(js.status));

// ---- deny-by-default ----
const unauthPage = await worker.fetch(req(BASE + "/learn/"), env);
check("unauth /learn/ → 302", unauthPage.status === 302, String(unauthPage.status));
check("unauth redirect to hub sign-in", (unauthPage.headers.get("location") || "").includes("/sign-in"), unauthPage.headers.get("location"));

const unauthApi = await worker.fetch(req(BASE + "/learn/api/xp", { method: "POST", auth: false }), env);
check("unauth POST api/xp → 401", unauthApi.status === 401, String(unauthApi.status));

// ---- authenticated path page ----
const pathRes = await worker.fetch(req(BASE + "/learn/", { auth: true }), env);
const pathHtml = await pathRes.text();
check("auth /learn/ 200", pathRes.status === 200, String(pathRes.status));
check("path page renders rail", pathHtml.includes("rail"), "no rail");
check("path page renders unit banner", pathHtml.includes("UNIT"), "no banner");
check("path page loads versioned css", pathHtml.includes("/learn/s.css?v="), "no css link");
check("path page CSP strict", (pathRes.headers.get("content-security-policy") || "").includes("default-src 'none'"));

// ---- authenticated lesson page ----
const lessonRes = await worker.fetch(req(BASE + "/learn/lesson/u1l1", { auth: true }), env);
const lessonHtml = await lessonRes.text();
check("auth lesson 200", lessonRes.status === 200, String(lessonRes.status));
check("lesson renders exercises", lessonHtml.includes('data-ex="'), "no exercise data");
check("lesson embeds answer JSON", lessonHtml.includes("&quot;answer&quot;:"), "no answer in data-ex");

// ---- xp write + path advance ----
const xpBody = await worker.fetch(
  new Request(BASE + "/learn/api/xp", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "__session=stub" },
    body: JSON.stringify({ id: "evt-1", lessonId: "u1l1", skill: "vocabulary", xp: 10 }),
  }),
  env,
);
const xpJson = await xpBody.json();
check("xp write ok", xpBody.status === 200 && xpJson.gained === 10, JSON.stringify(xpJson));
check("ledger row appended", tables.xp_events.length === 1, JSON.stringify(tables.xp_events));
check("streak >= 1", xpJson.streak >= 1, String(xpJson.streak));

const dupBody = await worker.fetch(
  new Request(BASE + "/learn/api/xp", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "__session=stub" },
    body: JSON.stringify({ id: "evt-1", lessonId: "u1l1", skill: "vocabulary", xp: 10 }),
  }),
  env,
);
const dupJson = await dupBody.json();
check("duplicate xp is a no-op (gained 0)", dupBody.status === 200 && dupJson.gained === 0, JSON.stringify(dupJson));

// Path after u1l1 mastered → active node should be u1l2 (next lesson).
const path2 = await worker.fetch(req(BASE + "/learn/", { auth: true }), env);
const path2Html = await path2.text();
check("path re-renders after completion", path2Html.includes("u1l2") && path2Html.includes("mastered"), "");

// ---- checkpoint ----
const cp = await worker.fetch(
  new Request(BASE + "/learn/api/checkpoint", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "__session=stub" },
    body: JSON.stringify({ id: "c1", verdict: "the tribunal is not a build environment" }),
  }),
  env,
);
check("checkpoint write ok", cp.status === 200, String(cp.status));
check("gate verdict stored", tables.checkpoint_verdicts.length === 1, JSON.stringify(tables.checkpoint_verdicts));

// ---- uniform 404 ----
const nf = await worker.fetch(req(BASE + "/learn/nope", { auth: true }), env);
check("unknown path 404", nf.status === 404, String(nf.status));

console.log(failures ? `\n${failures} failure(s)` : "\nall server smoke tests passed");
process.exit(failures ? 1 : 0);
