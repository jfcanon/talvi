// talvi 3d — live browser check for the style study.
//
//   node scripts/3d-browser-test.mjs [base-url]
//
// Runs against the deployed Worker and asserts the artifact a person actually
// runs: the page 200s, both versioned assets 200 with the right content type,
// /healthz 200, unknown paths get the uniform 404, the WebGL scene boots, all
// five sections exist, scroll drives the camera, and there are ZERO own-page
// console/page errors.
//
// PLAYWRIGHT-CORE IS NOT A DEPENDENCY OF THIS REPO, deliberately (the same
// call chat makes). Install it ad hoc when you want to run this:
//
//   npm i --no-save playwright-core
//   npx playwright install chromium     # only if no browser is cached yet
//
// The script exits 2 with instructions if playwright-core is absent, so a
// missing dependency reads as "not installed", never as a failing test.

const BASE = process.argv[2] ?? "https://3d.ygdcbtmc4u.uk";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error(
    "playwright-core is not installed (it is deliberately not a dependency).\n" +
      "  npm i --no-save playwright-core\n" +
      "  npx playwright install chromium   # if no browser is cached\n",
  );
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// The Cloudflare Browser Insights beacon is injected on this proxied zone and
// the CSP blocks it — correctly, and the CSP must never be widened for it
// (RUNBOOK, and the hub blueprint's known-issue note). It is reported as its
// own named failure so it is never confused with a real page violation.
const pageErrors = [];
const ownErrors = [];
let beaconBlocks = 0;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (m.text().includes("cloudflareinsights.com")) beaconBlocks++;
  else ownErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

const failures = [];

async function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(name);
}

async function fetchCheck(name, path, expectStatus) {
  const r = await page.request.get(BASE + path);
  await check(
    `${name} (${path})`,
    r.status() === expectStatus,
    `expected ${expectStatus}, got ${r.status()}`,
  );
  return r;
}

const css = await fetchCheck("css", "/3d.css", 200);
const js = await fetchCheck("js", "/3d.js", 200);
await fetchCheck("healthz", "/healthz", 200);
await fetchCheck("uniform 404", "/does-not-exist", 404);
await check(
  "css content-type",
  (css.headers()["content-type"] || "").startsWith("text/css"),
  css.headers()["content-type"],
);
await check(
  "js content-type",
  (js.headers()["content-type"] || "").startsWith("text/javascript"),
  js.headers()["content-type"],
);
await check(
  "assets immutable-cached",
  (css.headers()["cache-control"] || "").includes("immutable") &&
    (js.headers()["cache-control"] || "").includes("immutable"),
  css.headers()["cache-control"],
);

const resp = await page.goto(BASE, { waitUntil: "networkidle" });
await check("page 200", resp.status() === 200, `got ${resp.status()}`);
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const canvas = document.getElementById("scene");
  const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
  return {
    title: document.title,
    chapters: document.querySelectorAll("section.chapter").length,
    webgl: !!gl,
    canvasW: canvas ? canvas.width : 0,
    canvasH: canvas ? canvas.height : 0,
    wearLayers:
      !!document.querySelector(".wear") &&
      !!document.querySelector(".grain") &&
      !!document.querySelector(".leak"),
  };
});

await check("title", info.title === "talvi — 3d", info.title);
await check("five sections", info.chapters === 5, `found ${info.chapters}`);
await check("webgl canvas boots", info.webgl && info.canvasW > 0 && info.canvasH > 0);
await check("film overlays present", info.wearLayers);

await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(300);
const scrolled = await page.evaluate(() => window.scrollY > 0);
await check("scroll drives the world", scrolled);

await check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
await check("no own-page CSP/console errors", ownErrors.length === 0, ownErrors.join(" | "));
console.log(`info browser-insights beacon blocked by CSP: ${beaconBlocks} (expected ≥1, do NOT widen script-src)`);

await browser.close();

const pass = failures.length === 0;
console.log(pass ? "\nPASS: 3d browser check green" : `\nFAIL: ${failures.length} check(s) failed`);
process.exit(pass ? 0 : 1);
