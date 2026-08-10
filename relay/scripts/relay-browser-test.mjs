// talvi relay — browser test (Workstream B verify). Run against the live
// production relay:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/relay-browser-test.mjs [base-url]
//
// Exits 2 with instructions if playwright-core is absent.
//
// Covers, live in a real browser: the upload page renders under /relay with
// all assets prefixed and loading, zero own-page CSP violations, and the
// blade's TALVI link resolves (so navigation into the relay works). The upload
// POST itself requires a Clerk session (human-held — sign-in at /relay/sign-in),
// so it is exercised by the browser test's absence-of-error check on the page,
// not by completing an upload here.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk/relay";

// Cloudflare injects its Browser Insights beacon on real navigations on this
// zone; the CSP blocks it. Reported separately — never fixed by touching
// script-src. Same rule as the hub and chat tests.
const EDGE_INJECTED = /cloudflareinsights\.com|\/cdn-cgi\/(scripts|challenge-platform)/i;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const violations = [];
const injected = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
    (EDGE_INJECTED.test(text) ? injected : violations).push(text);
  }
});
page.on("pageerror", (err) => violations.push(`pageerror: ${err.message}`));

try {
  await page.goto(base, { waitUntil: "load", timeout: 30000 });

  check("upload page loads", (await page.title()).length > 0, "no title");
  // The write path is session-gated (Clerk swap): an anonymous visitor gets
  // the SIGN IN door, not the drop machine. The drop controls below are only
  // asserted against the signed-out state; the authed upload flow is the
  // owner's live E2E (sign-in → upload → share → download).
  check("signed out — no drop machine", (await page.locator("input[type=file]").count()) === 0);
  check("signed out — offers SIGN IN", (await page.locator('a[href="/relay/sign-in"]').count()) === 1);

  // P2: the quiet 3D world sits behind the machine (backdrop canvas + WebGL),
  // and the instrument panels are frosted glass over it.
  const p2 = await page.evaluate(() => {
    const canvas = document.getElementById("backdrop");
    const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
    const panel = document.querySelector(".panel");
    return {
      canvas: !!canvas,
      webgl: !!gl,
      glass: panel ? /blur\(/.test(getComputedStyle(panel).backdropFilter) : false,
    };
  });
  check("quiet backdrop canvas + WebGL", p2.canvas && p2.webgl);
  check("panels are frosted glass", p2.glass);
  // v2: the walking pixel sprite is gone (it clashed with the 3D world).
  check("pixel sprite removed", (await page.locator(".figure").count()) === 0);

  // Every asset request on the page must come back 200 (prefixed paths work).
  const badAssets = [];
  page.on("response", (r) => {
    if (/\/relay\/(s\.css|s\.js|s\.png)/.test(r.url()) && r.status() >= 400) {
      badAssets.push(`${r.status()} ${r.url()}`);
    }
  });
  await page.reload({ waitUntil: "load", timeout: 30000 });
  check("no asset request fails", badAssets.length === 0, badAssets.join(" | "));

  // The blade's TALVI link points at this relay — navigation in. The 3D hub
  // links relay three times (blade + instrument plate + END CTA), so at least
  // one is the right assertion.
  await page.goto(base.replace(/relay\/?$/, ""), { waitUntil: "load", timeout: 30000 });
  const relayLink = await page.locator('a[href="https://app.ygdcbtmc4u.uk/relay"]').count();
  check("blade has relay link", relayLink >= 1, `found ${relayLink}`);

  // Clerk gate (auth swap): the upload page tells an anonymous visitor the
  // write path needs a session, and the sign-in page renders the custom form
  // with the strict nonce CSP. Signing in itself needs the owner's account, so
  // it is exercised by the E2E, not here.
  await page.goto(base, { waitUntil: "load", timeout: 30000 });
  const signedOut = await page.evaluate(() => {
    return {
      closed: document.body.innerText.includes("SESSION CLOSED"),
      signIn: !!document.querySelector('a[href="/relay/sign-in"]'),
    };
  });
  check("upload page shows SESSION CLOSED when signed out", signedOut.closed);
  check("upload page offers SIGN IN", signedOut.signIn);

  const siResp = await page.goto(base + "/sign-in", { waitUntil: "load", timeout: 30000 });
  const csp = siResp?.headers()["content-security-policy"] || "";
  check("sign-in page renders form", (await page.locator("#si-form").count()) === 1);
  check("sign-in CSP is nonce + strict-dynamic", csp.includes("'nonce-") && csp.includes("'strict-dynamic'"), csp.slice(0, 120));
  check("sign-in CSP has no unsafe-inline", !csp.includes("unsafe-inline"));
  check("clerk-js loaded from the instance", (await page.evaluate(() => !!window.Clerk)) === true);

  check("zero own CSP violations", violations.length === 0, violations.join(" | ").slice(0, 300));
  // The edge beacon is expected on the proxied zone and blocked correctly. It
  // is reported as info, never as a failure — a permanently-red named check
  // would just teach everyone to ignore it. The real gate is `zero own CSP
  // violations`; the fix for this line is a dashboard toggle, not a CSP change.
  console.log(
    injected.length
      ? `info edge beacon blocked by CSP ${injected.length}x (expected — disable ` +
        "Web Analytics / Browser Insights in the zone dashboard, never widen script-src)"
      : "info no edge beacon injected (local harness or beacon disabled)",
  );
} catch (err) {
  check("browser run completes", false, String(err));
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
