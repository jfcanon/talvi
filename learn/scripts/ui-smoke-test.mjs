// UI smoke test for talvi learn PR6. Drives the REAL built bundle (the exact
// artifact CI uploads) with a stubbed auth (a real __session JWT cannot be
// produced in a unit test) and an in-memory D1 stub, verifying the PR6
// surface:
//   - healthz stays public (200, no auth)
//   - /learn/s.css and /learn/s.js serve PUBLIC with the year-long immutable
//     cache header and the strict-CSP-safety (never inlined)
//   - signed-out /learn/ redirects to the hub's /sign-in (302); APIs 401
//   - signed-in /learn/ renders the path-graph page (unit banners, lesson
//     nodes, the active frontier, progress bar) with the strict CSP header
//   - signed-in /learn/lesson/u1l1 renders the lesson player (facts + first
//     exercise); u1l5 (locked) redirects to the path; unknown lesson 404s
//   - lesson completion through /learn/api/complete flips the node to mastered
//   - every HTML page carries the strict CSP (default-src 'none') header
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDb } from "./lib/db-stub.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  outfile: join(root, "dist/index-ui-test.mjs"),
  logLevel: "silent",
});

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   - ${name}`);
  else {
    console.error(`FAIL - ${name} ${extra}`);
    failures += 1;
  }
}

const mod = await import(join(root, "dist/index-ui-test.mjs"));
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

// ---- public surface ----
const hz = await worker.fetch(req(BASE + "/learn/healthz"), env);
check("healthz 200", hz.status === 200, String(hz.status));

const css = await worker.fetch(req(BASE + "/learn/s.css?v=abc"), env);
check("s.css 200 public", css.status === 200, String(css.status));
check("s.css immutable cache", (css.headers.get("cache-control") || "").includes("immutable"), css.headers.get("cache-control"));
check("s.css is css", (css.headers.get("content-type") || "").includes("text/css"), css.headers.get("content-type"));

const js = await worker.fetch(req(BASE + "/learn/s.js?v=abc"), env);
check("s.js 200 public", js.status === 200, String(js.status));
check("s.js immutable cache", (js.headers.get("cache-control") || "").includes("immutable"), js.headers.get("cache-control"));
check("s.js is js", (js.headers.get("content-type") || "").includes("javascript"), js.headers.get("content-type"));

// ---- deny-by-default ----
const unauthPage = await worker.fetch(req(BASE + "/learn/"), env);
check("unauth /learn/ → 302", unauthPage.status === 302, String(unauthPage.status));
check("redirect to hub sign-in", (unauthPage.headers.get("location") || "").includes("/sign-in"), unauthPage.headers.get("location"));
const unauthLesson = await worker.fetch(req(BASE + "/learn/lesson/u1l1"), env);
check("unauth /lesson/ → 302", unauthLesson.status === 302, String(unauthLesson.status));
const unauthState = await worker.fetch(req(BASE + "/learn/api/state"), env);
check("unauth api/state → 401", unauthState.status === 401, String(unauthState.status));

// ---- path page ----
const path = await worker.fetch(req(BASE + "/learn/", { auth: true }), env);
const pathBody = await path.text();
check("auth /learn/ → 200", path.status === 200, String(path.status));
check("path carries strict CSP", (path.headers.get("content-security-policy") || "").includes("default-src 'none'"), path.headers.get("content-security-policy"));
check("path shows the rail", pathBody.includes('class="rail"'), "");
check("path shows unit banner", pathBody.includes("UNIT"), "");
check("path links the first lesson", pathBody.includes('/learn/lesson/u1l1"'), "");
check("path shows the frontier", pathBody.includes('node--active'), "");
check("path loads versioned css", pathBody.includes("/learn/s.css?v="), "");
check("path loads versioned js", pathBody.includes("/learn/s.js?v="), "");
check("path has no inline style", !/style="/.test(pathBody), "");
check("path has no inline script", !/<script>/.test(pathBody), "");
check("path has no inline handler", !/onclick=/i.test(pathBody), "");

// ---- lesson player ----
const lesson = await worker.fetch(req(BASE + "/learn/lesson/u1l1", { auth: true }), env);
const lessonBody = await lesson.text();
check("auth /lesson/u1l1 → 200", lesson.status === 200, String(lesson.status));
check("lesson carries strict CSP", (lesson.headers.get("content-security-policy") || "").includes("default-src 'none'"), lesson.headers.get("content-security-policy"));
check("lesson renders facts", lessonBody.includes('class="fact"'), "");
check("lesson renders exercises", lessonBody.includes('class="exercise"'), "");
check("lesson has data-ex answers", lessonBody.includes("data-ex="), "");
check("lesson has HUD pills", lessonBody.includes("pill--xp") && lessonBody.includes("pill--streak"), "");
check("lesson loads versioned css", lessonBody.includes("/learn/s.css?v="), "");
check("lesson has no inline style", !/style="/.test(lessonBody), "");
// Pre-read gate regression (NID-100 "I'm Ready unclickable"): the gate must
// sit OUTSIDE the locked exercises section, the section must ship locked, and
// the fact text must be readable (bold markers rendered, not raw asterisks).
const gateIdx = lessonBody.indexOf('class="preread-gate"');
const exIdx = lessonBody.indexOf('class="exercises"');
check("preread gate rendered visible (no hidden attr)", gateIdx > 0 && !/class="preread-gate" hidden/.test(lessonBody), "");
check("preread gate precedes the exercises section", gateIdx > 0 && exIdx > gateIdx, gateIdx + " vs " + exIdx);
check("exercises section ships locked", /class="exercises"[^>]*data-locked="true"/.test(lessonBody), "");
check("fact renders **bold** as <strong>", lessonBody.includes("<strong>the Living Tribunal</strong>"), "");
check("fact does not leak raw ** markers", !/class="fact"><p>[^<]*\*\*/.test(lessonBody), "");
const cssText = await (await worker.fetch(req(BASE + "/learn/s.css?v=abc"), env)).text();
check("css sizes the progress ring", /\.progress-ring\s*\{[^}]*width:/.test(cssText), "");
check("css locks exercises via data-locked", cssText.includes('.exercises[data-locked="true"]'), "");
// Select exercises must ship their options in data-ex: client grade() reads
// ex.options[ex.answer]; without it every select click threw (NID-100).
const selectEx = [...lessonBody.matchAll(/data-ex="([^"]+)"/g)]
  .map((m) => JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")))
  .filter((e) => e.type === "select" || e.type === "spot");
check("select exercises present in u1l1", selectEx.length > 0, "");
check("select data-ex carries options array", selectEx.every((e) => Array.isArray(e.options) && e.options.length > 0), JSON.stringify(selectEx[0]));
check("lesson has no inline script", !/<script>/.test(lessonBody), "");

// ---- locked lesson redirects to the path ----
const locked = await worker.fetch(req(BASE + "/learn/lesson/u1l5", { auth: true }), env);
check("locked u1l5 → 302 to path", locked.status === 302 && (locked.headers.get("location") || "").includes("/learn/"), locked.status + " " + (locked.headers.get("location") || ""));

// ---- unknown lesson is the uniform 404 ----
const unknown = await worker.fetch(req(BASE + "/learn/lesson/zzz", { auth: true }), env);
check("unknown lesson 404", unknown.status === 404, String(unknown.status));

// ---- gate page (unit 1 gate is locked until all u1 lessons done) ----
const lockedGate = await worker.fetch(req(BASE + "/learn/gate/c1", { auth: true }), env);
check("locked gate c1 → 302 to path", lockedGate.status === 302 && (lockedGate.headers.get("location") || "").includes("/learn/"), lockedGate.status + " " + (lockedGate.headers.get("location") || ""));

// ---- complete through the API then re-check the path ----
async function complete(lessonId, skill, auth = true) {
  const r = await worker.fetch(req(BASE + "/learn/api/complete", { method: "POST", auth, body: JSON.stringify({ lesson_id: lessonId, skill }) }), env);
  return r.json();
}
await complete("u1l1", "vocabulary");
const path2 = await worker.fetch(req(BASE + "/learn/", { auth: true }), env);
const path2Body = await path2.text();
const masteredNode = /<a class="node node--mastered" href="\/learn\/lesson\/u1l1"/.test(path2Body);
const frontierNode = /<a class="node node--active[^"]*" href="\/learn\/lesson\/u1l2"/.test(path2Body);
check("after u1l1, u1l1 node is mastered", masteredNode, "");
check("after u1l1, u1l2 becomes the frontier", frontierNode, "");
const u1l2 = await worker.fetch(req(BASE + "/learn/lesson/u1l2", { auth: true }), env);
check("u1l2 now reachable (200)", u1l2.status === 200, String(u1l2.status));

console.log(failures ? `\n${failures} failure(s)` : "\nall PR6 UI smoke tests passed");
process.exit(failures ? 1 : 0);
