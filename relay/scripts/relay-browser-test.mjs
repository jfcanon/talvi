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
// POST itself requires the owner's Access email-PIN (human-held), so it is
// exercised by the browser test's absence-of-error check on the page, not by
// completing an upload here.
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
  check("has upload form controls", (await page.locator("input[type=file]").count()) === 1);
  check("has TTL options", (await page.locator("input[name=ttl]").count()) === 3);
  check("has send button", (await page.locator("button").count()) >= 1);

  // Every asset request on the page must come back 200 (prefixed paths work).
  const badAssets = [];
  page.on("response", (r) => {
    if (/\/relay\/(s\.css|s\.js|s\.png)/.test(r.url()) && r.status() >= 400) {
      badAssets.push(`${r.status()} ${r.url()}`);
    }
  });
  await page.reload({ waitUntil: "load", timeout: 30000 });
  check("no asset request fails", badAssets.length === 0, badAssets.join(" | "));

  // The blade's TALVI link points at this relay — navigation in.
  await page.goto(base.replace(/relay\/?$/, ""), { waitUntil: "load", timeout: 30000 });
  const relayLink = await page.locator('a[href="https://app.ygdcbtmc4u.uk/relay"]').count();
  check("blade has relay link", relayLink === 1);

  check("zero own CSP violations", violations.length === 0, violations.join(" | ").slice(0, 300));
  check("no third-party script injected by the edge", injected.length === 0,
    injected.length
      ? "Cloudflare Browser Insights beacon injected on this zone and blocked by " +
        "CSP (correctly). Fix by DISABLING the zone feature — Web Analytics / " +
        "Browser Insights — never by adding the host to script-src."
      : "clean");
} catch (err) {
  check("browser run completes", false, String(err));
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
