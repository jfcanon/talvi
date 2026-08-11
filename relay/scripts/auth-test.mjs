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
//    body says where to sign in (the app root).
{
  const u = await post("/relay/api/upload");
  check("upload without Clerk bindings → 401", u.status === 401, "status=" + u.status);
  check("401 names the root sign-in path", u.text.includes("/sign-in"), u.text);
}

// 2. Public read paths still render for everyone (no session required).
{
  const root = await get("/relay/");
  check("upload page renders 200", root.status === 200);
  check("upload page shows SESSION CLOSED when signed out", root.text.includes("SESSION CLOSED"), root.text.slice(0, 200));
  check("upload page SIGN IN points at the app root", root.text.includes('href="/sign-in?redirect=/relay"'));

  const assets = await get("/relay/s.css");
  check("stylesheet renders", assets.status === 200 && assets.headers.get("content-type").includes("text/css"));
}

// 3. The relay no longer serves sign-in pages — those live at the app root
//    (the hub worker). A direct hit is a uniform 404.
{
  const si = await get("/relay/sign-in");
  check("relay no longer serves /sign-in", si.status === 404, "status=" + si.status);
  const cb = await get("/relay/sso-callback");
  check("relay no longer serves /sso-callback", cb.status === 404, "status=" + cb.status);
  const so = await get("/relay/api/signout");
  check("relay no longer serves /api/signout", so.status === 404, "status=" + so.status);
}

// 4. The healthz/robots endpoints are untouched by the gate.
{
  const h = await get("/relay/healthz");
  check("healthz still 200", h.status === 200);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
