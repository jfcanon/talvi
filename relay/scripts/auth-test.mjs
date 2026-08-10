// Clerk auth gate — offline protocol test (the swap's verify clauses).
//
// Drives the REAL worker from the bundle (dist/index.js) with a mock D1/R2
// and NO Clerk bindings, proving the fail-closed half of the contract without
// touching production or needing a live session:
//   - POST /api/upload → 401 when the Clerk bindings are absent (fail-closed:
//     a misconfigured deploy must refuse uploads loudly, not accept them)
//   - GET / and the public read paths still render for everyone
//   - GET /sign-in and /sso-callback render with the strict nonce CSP
//   - GET /api/signout drops the __session cookie and redirects home
//
// The authenticated half (real __session cookie → 200) needs a live Clerk
// session and is covered by the browser test / the live E2E after deploy.
import { createHash } from "node:crypto";

const { default: worker } = await import("../dist/index.js");
const base = "https://app.ygdcbtmc4u.uk";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// The smallest env the router needs for these routes: a mock D1 (empty — no
// drop lookups here) and a BUCKET placeholder. NO CLERK_* bindings, on
// purpose: that is the fail-closed configuration under test.
const DB = {
  batch: async (stmts) => stmts,
  prepare() {
    const q = {
      bind() { return q; },
      async first() { return null; },
      async all() { return { results: [] }; },
      run() { return Promise.resolve({ results: [] }); },
    };
    q.run = () => Promise.resolve({ results: [] });
    return q;
  },
};
const BUCKET = { get: async () => null, delete: async () => {}, put: async () => null };
const env = { DB, BUCKET, ctx: { waitUntil: () => {} } };

async function get(path) {
  const r = await worker.fetch(new Request(base + path), env, { waitUntil: () => {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

async function post(path) {
  const r = await worker.fetch(
    new Request(base + path, { method: "POST", body: "hello" }),
    env,
    { waitUntil: () => {} },
  );
  return { status: r.status, headers: r.headers, text: await r.text() };
}

// 1. Fail-closed upload gate: no Clerk bindings → every upload is 401, and the
//    body says where to sign in.
{
  const u = await post("/relay/api/upload");
  check("upload without Clerk bindings → 401", u.status === 401, "status=" + u.status);
  check("401 names the sign-in path", u.text.includes("/relay/sign-in"), u.text);
}

// 2. Public read paths still render for everyone (no session required).
{
  const root = await get("/relay/");
  check("upload page renders 200", root.status === 200);
  check("upload page shows SESSION CLOSED when signed out", root.text.includes("SESSION CLOSED"), root.text.slice(0, 200));
  check("upload page offers SIGN IN", root.text.includes("/relay/sign-in"));

  const assets = await get("/relay/s.css");
  check("stylesheet renders", assets.status === 200 && assets.headers.get("content-type").includes("text/css"));
}

// 3. Sign-in + sso-callback pages: 200, the strict nonce Clerk CSP, no
//    unsafe-inline, and the PREFIX-aware form/link paths.
{
  const si = await get("/relay/sign-in");
  check("sign-in page renders 200", si.status === 200, "status=" + si.status);
  const csp = si.headers.get("content-security-policy") || "";
  check("sign-in CSP is nonce + strict-dynamic", csp.includes("'nonce-") && csp.includes("'strict-dynamic'"), csp);
  check("sign-in CSP has no unsafe-inline/eval", !csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  check("sign-in form present", si.text.includes('id="si-form"'));
  check("sign-in points clerk-js at the instance", si.text.includes("clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js"));
  check("sign-in stylesheet is PREFIX-pathed", si.text.includes('href="/relay/s.css'));

  const cb = await get("/relay/sso-callback");
  check("sso-callback renders 200", cb.status === 200, "status=" + cb.status);
  const cbCsp = cb.headers.get("content-security-policy") || "";
  check("sso-callback CSP is nonce + strict-dynamic", cbCsp.includes("'nonce-") && cbCsp.includes("'strict-dynamic'"));
}

// 4. Signout: even without a session, GET /api/signout clears the __session
//    cookie and redirects home (the revoke step is best-effort).
{
  const so = await get("/relay/api/signout");
  check("signout → 302", so.status === 302, "status=" + so.status);
  check("signout redirects to /relay/", (so.headers.get("location") || "").endsWith("/relay/"), so.headers.get("location"));
  check("signout clears __session", (so.headers.get("set-cookie") || "").includes("__session=; Max-Age=0"), so.headers.get("set-cookie"));
}

// 5. The healthz/robots endpoints are untouched by the gate.
{
  const h = await get("/relay/healthz");
  check("healthz still 200", h.status === 200);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
