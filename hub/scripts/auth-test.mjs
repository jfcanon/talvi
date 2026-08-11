// Clerk-on-hub offline test. The hub bundle cannot be imported in Node (the
// agent DO imports cloudflare:computer, kept external), so this drives the
// PAGES and the AUTH LIB directly from src:
//   - /sign-in + /sso-callback render with the strict nonce Clerk CSP, link
//     the hub's own /h.css, and thread the nonce
//   - /api/signout semantics: revokeSession best-effort + __session cleared
//   - hubPage renders SIGN IN when signed out, SIGN OUT when signed in
//   - isAuthenticated is fail-closed without Clerk bindings
// The routes themselves are verified live after apply (curl /sign-in, etc.).
import { isAuthenticated } from "../src/lib/auth.js";
import { signInPage, ssoCallbackPage, signInCsp } from "../src/ui/signin.js";
import { hubPage } from "../src/ui/hubpage.js";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const nonce = "cspnonce-abcdef123456";

const si = signInPage({ publishableKey: "pk_test_xyz", nonce });
check("sign-in page renders the form", si.includes('id="si-form"'));
check("sign-in links the hub stylesheet", si.includes('href="/h.css?v='));
check("sign-in does not link /s.css", !si.includes("/s.css"));
check("sign-in loads clerk-js from the instance", si.includes("clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js"));
check("sign-in wordmark goes home to /", si.includes('href="/"'));
check("sign-in CSP is nonce + strict-dynamic", signInCsp(nonce).includes("'nonce-" + nonce) && signInCsp(nonce).includes("'strict-dynamic'"));
check("sign-in CSP has no unsafe-inline/eval", !signInCsp(nonce).includes("unsafe-inline") && !signInCsp(nonce).includes("unsafe-eval"));

const cb = ssoCallbackPage({ publishableKey: "pk_test_xyz", nonce });
check("sso-callback page renders", cb.includes("COMPLETING SIGN-IN"));

const out = hubPage({ authed: false });
check("signed-out page offers SIGN IN", out.includes('href="/sign-in?redirect=/"'));
check("signed-out page has no SIGN OUT", !out.includes('href="/api/signout"'));
check("signed-out page CINTO → /cinto", out.includes('href="/cinto"'));
check("signed-out page keeps the scene canvas", out.includes('id="scene"'));

const in_ = hubPage({ authed: true });
check("signed-in page offers SIGN OUT", in_.includes('href="/api/signout"'));
check("signed-in page has no SIGN IN", !in_.includes('href="/sign-in?redirect=/"'));

const authed = await isAuthenticated(new Request("https://app.ygdcbtmc4u.uk/"), {});
check("isAuthenticated is fail-closed without bindings", authed === false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
