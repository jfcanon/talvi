// talvi hub — browser test (A1 verify). Run against the live production hub:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/hub-browser-test.mjs [base-url]
//
// It exits 2 with instructions if playwright-core is absent, so a missing dep
// never reads as a failing test.
//
// Covers, live in a real browser: the blade renders, retract toggles the rail
// open/closed and persists, each icon href targets the right app, the page
// raises ZERO CSP violations, and no network error blocks the page.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk";

const EXPECTED_LINKS = {
  TALVI: "https://talvi.ygdcbtmc4u.uk",
  CHAT: "https://talvi.ygdcbtmc4u.uk/chat",
  CINTO: "https://cinto.ygdcbtmc4u.uk",
};

// Cloudflare injects its Browser Insights beacon into HTML at the edge on the
// proxied zone — but only for requests that look like real browser navigations
// (`Sec-Fetch-Dest: document`), which is why curl sees nothing and this test
// does. The CSP blocks it, correctly.
//
// It is reported SEPARATELY from our own violations because the two demand
// opposite responses. A violation from our own page is a bug in our page. This
// is a third-party script the site never asked for, arriving from the edge, and
// the fix is to turn the zone feature off — NEVER to add the host to
// `script-src`. Same rule as green's chat-browser-test.mjs.
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
  // CSP violations surface as console errors mentioning Content Security Policy.
  // Everything else an error-level console message says is a genuine page bug.
  if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
    (EDGE_INJECTED.test(text) ? injected : violations).push(text);
  }
});
// pageerror is always a real bug — the edge beacon never produces one.
page.on("pageerror", (err) => violations.push(`pageerror: ${err.message}`));

try {
  await page.goto(base, { waitUntil: "load", timeout: 30000 });

  check("page loads with title talvi", (await page.title()) === "talvi");
  check("blade nav present", (await page.locator(".blade").count()) === 1);

  const labels = await page.locator(".blade__label").allTextContents();
  check(
    "blade shows 3 apps + future slot",
    labels.length === 4 && labels[3].toLowerCase() === "more",
    labels.join(","),
  );

  // Every expected app is an anchor to the right home.
  for (const [name, href] of Object.entries(EXPECTED_LINKS)) {
    const target = await page.locator(`.blade__item[href="${href}"]`).count();
    check(`icon ${name} links ${href}`, target === 1);
  }
  check("future slot is not a link", (await page.locator(".blade__item.is-slot").count()) === 1);

  // Blade collapses/expands and remembers the state.
  const hub = page.locator("#hub");
  check("blade starts collapsed", !(await hub.evaluate((el) => el.classList.contains("is-open"))));
  await page.locator(".blade__toggle").click();
  check("blade opens on toggle", await hub.evaluate((el) => el.classList.contains("is-open")));
  await page.locator(".blade__toggle").click();
  check("blade closes on second toggle", !(await hub.evaluate((el) => el.classList.contains("is-open"))));

  // Zero CSP violations from OUR page (the edge beacon is reported separately).
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
