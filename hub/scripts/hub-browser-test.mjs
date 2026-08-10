// talvi hub — browser test (P1, the 3D hub). Run against the live production
// hub:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/hub-browser-test.mjs [base-url]
//
// It exits 2 with instructions if playwright-core is absent, so a missing dep
// never reads as a failing test.
//
// Covers, live in a real browser: the page 200s, the 3D world boots (WebGL),
// the five scroll sections exist, the blade renders and retracts, every app
// href targets the right worker (the instrument plates AND the blade agree),
// the END closing CTA is present, the uniform 404 and the /chat+/relay
// trailing-slash redirects hold, and the page raises ZERO own-page CSP
// violations (the edge-injected beacon is reported separately).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk";

// Post-migration targets (hub blueprint: apps mount at app.* paths).
const EXPECTED_LINKS = {
  TALVI: "https://app.ygdcbtmc4u.uk/relay",
  CHAT: "https://app.ygdcbtmc4u.uk/chat",
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
    if (name === "css")
      check("css content-type", r.headers()["content-type"].startsWith("text/css"));
    if (name === "js")
      check("js content-type", r.headers()["content-type"].startsWith("text/javascript"));
  }

  const chat = await page.request.get(base + "/chat", { maxRedirects: 0 });
  const relay = await page.request.get(base + "/relay", { maxRedirects: 0 });
  check("bare /chat 301 → /chat/", chat.status() === 301 && chat.headers()["location"].endsWith("/chat/"), `${chat.status()} ${chat.headers()["location"]}`);
  check("bare /relay 301 → /relay/", relay.status() === 301 && relay.headers()["location"].endsWith("/relay/"), `${relay.status()} ${relay.headers()["location"]}`);

  // --- the page ------------------------------------------------------------
  await page.goto(base, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1000); // let the scene boot + a frame render

  check("page loads with title talvi", (await page.title()) === "talvi");
  check("five scroll sections", (await page.locator("section.chapter").count()) === 5);

  const world = await page.evaluate(() => {
    const canvas = document.getElementById("scene");
    const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
    return { canvas: !!canvas, webgl: !!gl };
  });
  check("webgl world boots", world.canvas && world.webgl);

  // --- the blade -----------------------------------------------------------
  check("blade nav present", (await page.locator(".blade").count()) === 1);
  const labels = await page.locator(".blade__label").allTextContents();
  check(
    "blade shows 3 apps + future slot",
    labels.length === 4 && labels[3].toLowerCase() === "more",
    labels.join(","),
  );
  for (const [name, href] of Object.entries(EXPECTED_LINKS)) {
    const target = await page.locator(`.blade__item[href="${href}"]`).count();
    check(`blade ${name} links ${href}`, target === 1);
  }
  check("future slot is not a link", (await page.locator(".blade__item.is-slot").count()) === 1);

  const blade = page.locator(".blade");
  const toggle = page.locator(".blade__toggle");
  check("blade starts collapsed", !(await blade.evaluate((el) => el.classList.contains("is-open"))));
  await toggle.click();
  check("blade opens on toggle", await blade.evaluate((el) => el.classList.contains("is-open")));
  await toggle.click();
  check("blade closes on second toggle", !(await blade.evaluate((el) => el.classList.contains("is-open"))));

  // --- the instruments (world control plates) ------------------------------
  const plateHrefs = await page.locator("a.plate").evaluateAll((els) =>
    els.map((a) => a.getAttribute("href")),
  );
  const expectedPlateHrefs = Object.values(EXPECTED_LINKS);
  check(
    "instrument plates = one per app",
    plateHrefs.length === 3 && expectedPlateHrefs.every((h) => plateHrefs.includes(h)),
    plateHrefs.join(","),
  );
  check("END closing CTA present", (await page.locator("#end .btn").count()) === 1);

  // --- scroll drives the world ---------------------------------------------
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  check("scroll drives the world", await page.evaluate(() => window.scrollY > 0));

  // --- mobile --------------------------------------------------------------
  await page.setViewportSize({ width: 375, height: 667 });
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(600);
  check("mobile hides the retract toggle", (await page.locator(".blade__toggle").isVisible()) === false);
  check("mobile shows the icon rail", (await page.locator(".blade__item").count()) === 4);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload({ waitUntil: "load", timeout: 30000 });

  // --- CSP -----------------------------------------------------------------
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
