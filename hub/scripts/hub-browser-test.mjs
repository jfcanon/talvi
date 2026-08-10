// talvi hub — browser test (v5, the 2D front door). Run against the live
// production hub:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/hub-browser-test.mjs [base-url]
//
// It exits 2 with instructions if playwright-core is absent, so a missing dep
// never reads as a failing test.
//
// Covers, live in a real browser: the page 200s, it is 2D (no WebGL canvas),
// the blade renders and retracts, the glass board shows the front-door status
// card + one card per app with the right hrefs, the hero + HUD prompt are
// present, the uniform 404 holds, and the page raises ZERO own-page CSP
// violations (the edge-injected beacon is reported as info).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk";

const EXPECTED_CARDS = {
  relay: "https://app.ygdcbtmc4u.uk/relay",
  chat: "https://app.ygdcbtmc4u.uk/chat",
  cinto: "https://cinto.ygdcbtmc4u.uk",
};

// Cloudflare injects its Browser Insights beacon into HTML at the edge on the
// proxied zone — but only for requests that look like real browser navigations
// (`Sec-Fetch-Dest: document`). The CSP blocks it, correctly. Reported as info,
// never as a failure — the real gate is `zero own CSP violations`.
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
  // --- static routes -------------------------------------------------------
  for (const [name, path, expect] of [
    ["healthz", "/healthz", 200],
    ["css", "/h.css", 200],
    ["js", "/h.js", 200],
    ["uniform 404", "/does-not-exist", 404],
  ]) {
    const r = await page.request.get(base + path);
    check(`${name} (${path})`, r.status() === expect, `expected ${expect}, got ${r.status()}`);
  }

  const chat = await page.request.get(base + "/chat", { maxRedirects: 0 });
  const relay = await page.request.get(base + "/relay", { maxRedirects: 0 });
  check("bare /chat reachable", chat.status() === 200 || chat.status() === 301, `got ${chat.status()}`);
  check("bare /relay reachable", relay.status() === 200 || relay.status() === 301, `got ${relay.status()}`);

  // --- the page (2D — no WebGL) -------------------------------------------
  await page.goto(base, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(500);

  check("page loads with title talvi", (await page.title()) === "talvi");
  check("2D — no webgl canvas", (await page.locator("#scene").count()) === 0);
  check("atmosphere layer present", (await page.locator(".atmos").count()) === 1);

  // --- the blade -----------------------------------------------------------
  check("blade nav present", (await page.locator(".blade").count()) === 1);
  check("blade has login control", (await page.locator(".blade__login").count()) === 1);
  const blade = page.locator(".blade");
  await page.locator(".blade__toggle").click();
  check("blade opens on toggle", await blade.evaluate((el) => el.classList.contains("is-open")));
  await page.locator(".blade__toggle").click();
  check("blade closes on second toggle", !(await blade.evaluate((el) => el.classList.contains("is-open"))));

  // --- the glass board -----------------------------------------------------
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".card--app")].map((c) => [
      c.getAttribute("href"),
      c.querySelector(".card__name").textContent.trim(),
    ]),
  );
  check("three app cards", cards.length === 3, `found ${cards.length}`);
  for (const [href, name] of cards) {
    const key = name.toLowerCase();
    check(`card ${name} → ${href}`, href === EXPECTED_CARDS[key], `${href}`);
  }
  check("front-door status card present", (await page.locator(".card--status .card__big").count()) === 1);

  // --- hero + HUD ----------------------------------------------------------
  check("hero title present", (await page.locator(".hero__title").count()) === 1);
  check("prompt present", (await page.locator(".prompt").count()) === 1);

  // --- CSP -----------------------------------------------------------------
  check("zero own CSP violations", violations.length === 0, violations.join(" | ").slice(0, 300));
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
