// Unauthenticated live checks for talvi learn (PR7 / NID-415).
//
//   node scripts/verify-learn.mjs https://app.ygdcbtmc4u.uk
//
// The XP round-trip needs a Clerk session — that stays a manual RUNBOOK step.
const originArg = process.argv[2];
if (!originArg) {
  console.error("usage: node scripts/verify-learn.mjs https://app.ygdcbtmc4u.uk");
  process.exit(2);
}

const origin = originArg.replace(/\/$/, "");
const appHost = new URL(origin).host;
const apex = appHost.replace(/^app\./, "");
const threeD = `https://3d.${apex}/`;

const rows = [];

function record(check, want, got, ok) {
  rows.push({ check, want, got: String(got), ok: !!ok });
}

async function probe(url) {
  return fetch(url, { redirect: "manual" });
}

function csp(res) {
  return res.headers.get("content-security-policy") || "";
}

function cspOk(res) {
  return csp(res).startsWith("default-src 'none'");
}

function locationOf(res) {
  return res.headers.get("location") || "";
}

// ---- learn surface ----
const healthz = await probe(origin + "/learn/healthz");
record("/learn/healthz", "200", healthz.status, healthz.status === 200);
record("/learn/healthz CSP", "default-src 'none'…", csp(healthz).slice(0, 40) || "(missing)", cspOk(healthz));

const root = await probe(origin + "/learn/");
const rootLoc = locationOf(root);
let rootUrl;
try {
  rootUrl = new URL(rootLoc, origin);
} catch {
  rootUrl = null;
}
const rootRedirectOk =
  root.status === 302 &&
  rootUrl &&
  rootUrl.pathname === "/sign-in" &&
  rootUrl.searchParams.get("redirect") === "/learn/";
record("/learn/", "302 → /sign-in?redirect=%2Flearn%2F", `${root.status} ${rootLoc}`, rootRedirectOk);
record("/learn/ CSP", "default-src 'none'…", csp(root).slice(0, 40) || "(missing)", cspOk(root));

const state = await probe(origin + "/learn/api/state");
record("/learn/api/state", "401", state.status, state.status === 401);
record("/learn/api/state CSP", "default-src 'none'…", csp(state).slice(0, 40) || "(missing)", cspOk(state));

const css = await probe(origin + "/learn/s.css");
record(
  "/learn/s.css",
  "200 text/css immutable",
  `${css.status} ${css.headers.get("content-type") || ""} ${css.headers.get("cache-control") || ""}`,
  css.status === 200 &&
    (css.headers.get("content-type") || "").includes("text/css") &&
    (css.headers.get("cache-control") || "").includes("immutable"),
);
record("/learn/s.css CSP", "default-src 'none'…", csp(css).slice(0, 40) || "(missing)", cspOk(css));

const js = await probe(origin + "/learn/s.js");
record(
  "/learn/s.js",
  "200 javascript immutable",
  `${js.status} ${js.headers.get("content-type") || ""} ${js.headers.get("cache-control") || ""}`,
  js.status === 200 &&
    (js.headers.get("content-type") || "").includes("javascript") &&
    (js.headers.get("cache-control") || "").includes("immutable"),
);
record("/learn/s.js CSP", "default-src 'none'…", csp(js).slice(0, 40) || "(missing)", cspOk(js));

const fav = await probe(origin + "/learn/favicon.ico");
record("/learn/favicon.ico", "not 404", fav.status, fav.status !== 404);
record("/learn/favicon.ico CSP", "default-src 'none'…", csp(fav).slice(0, 40) || "(missing)", cspOk(fav));

// Sibling apps — one probe each, taken from the sibling main.tf route blocks
// (relay, chat, leoncito/cinto, hub /*, 3d on its own host). non-5xx is the bar.
const siblings = [
  ["/relay", origin + "/relay"],
  ["/chat", origin + "/chat"],
  ["/leoncito", origin + "/leoncito"],
  ["/", origin + "/"],
  ["3d.ygdcbtmc4u.uk/", threeD],
];

for (const [name, url] of siblings) {
  try {
    const res = await probe(url);
    record(`sibling ${name}`, "non-5xx", res.status, res.status < 500);
  } catch (err) {
    record(`sibling ${name}`, "non-5xx", err.message, false);
  }
}

const checkW = Math.max(5, ...rows.map((r) => r.check.length));
const wantW = Math.max(4, ...rows.map((r) => r.want.length));
const gotW = Math.max(3, ...rows.map((r) => r.got.length));
const line = (a, b, c, d) =>
  `${a.padEnd(checkW)}  ${b.padEnd(wantW)}  ${c.padEnd(gotW)}  ${d}`;
console.log(line("CHECK", "WANT", "GOT", "RESULT"));
console.log(`${"-".repeat(checkW)}  ${"-".repeat(wantW)}  ${"-".repeat(gotW)}  ------`);
for (const r of rows) {
  console.log(line(r.check, r.want, r.got, r.ok ? "PASS" : "FAIL"));
}
const failed = rows.filter((r) => !r.ok).length;
console.log("");
console.log(`${rows.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
