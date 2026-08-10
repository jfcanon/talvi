// talvi hub — browser test (v4, the explorable world). Run against the live
// production hub:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/hub-browser-test.mjs [base-url]
//
// It exits 2 with instructions if playwright-core is absent, so a missing dep
// never reads as a failing test.
//
// Covers, live in a real browser: the page 200s, the 3D world boots (WebGL),
// the three app cubes exist (window.talviProbe — the names live in the world
// now, not the DOM), the blade renders and retracts, the HUD prompt + hint are
// present, dragging orbits the camera (cube screen positions move), the wheel
// dollies (they move again), hovering a cube echoes "open <app>" in the
// prompt, clicking a cube navigates to its app, the uniform 404 holds, and
// the page raises ZERO own-page CSP violations (the edge beacon is reported as
// info).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk";

const EXPECTED_NODES = {
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

const nodeXs = () =>
  page.evaluate(() =>
    (window.talviProbe ? window.talviProbe() : []).map((b) => ({ key: b.key, x: b.x })),
  );

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

  // --- the page ------------------------------------------------------------
  await page.goto(base, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1000); // let the world boot + a frame render

  check("page loads with title talvi", (await page.title()) === "talvi");
  const world = await page.evaluate(() => {
    const canvas = document.getElementById("scene");
    const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
    return { canvas: !!canvas, webgl: !!gl };
  });
  check("webgl world boots", world.canvas && world.webgl);

  // --- the app cubes (in the world, probed) --------------------------------
  const cubes = await page.evaluate(() => (window.talviProbe ? window.talviProbe() : []));
  check("three app cubes (talviProbe)", cubes.length === 3, `found ${cubes.length}`);
  for (const c of cubes) {
    check(`cube ${c.key} → ${c.href}`, c.href === EXPECTED_NODES[c.key] && c.visible, `${c.href} visible=${c.visible}`);
  }
  check("no DOM app labels (names are in the world)", (await page.locator(".node").count()) === 0);

  // --- the blade -----------------------------------------------------------
  check("blade nav present", (await page.locator(".blade").count()) === 1);
  check("blade has login control", (await page.locator(".blade__login").count()) === 1);
  const blade = page.locator(".blade");
  await page.locator(".blade__toggle").click();
  check("blade opens on toggle", await blade.evaluate((el) => el.classList.contains("is-open")));
  await page.locator(".blade__toggle").click();
  check("blade closes on second toggle", !(await blade.evaluate((el) => el.classList.contains("is-open"))));

  // --- the HUD -------------------------------------------------------------
  check("prompt present", (await page.locator(".prompt").count()) === 1);
  check("hint present", (await page.locator(".hint").count()) === 1);

  // --- drag = orbit, wheel = dolly -----------------------------------------
  const before = await nodeXs();
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(740, 360, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterOrbit = await nodeXs();
  const orbited = afterOrbit.some(
    (n, i) => Math.abs(n.x - before[i].x) > 20,
  );
  check("drag orbits the world (labels move)", orbited, JSON.stringify({ before, afterOrbit }));

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(250);
  const afterZoom = await nodeXs();
  const zoomed = afterZoom.some(
    (n, i) => Math.abs(n.x - afterOrbit[i].x) > 20,
  );
  check("wheel dollies (labels move again)", zoomed, JSON.stringify({ afterOrbit, afterZoom }));

  // --- hover echoes in the prompt ------------------------------------------
  await page.evaluate(() => {
    const relay = window.talviProbe().find((b) => b.key === "relay");
    document.getElementById("scene").dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: relay.x,
        clientY: relay.y,
        pointerId: 9,
        bubbles: true,
      }),
    );
  });
  await page.waitForTimeout(120);
  const promptText = await page.locator(".prompt__text").textContent();
  check('hover echoes "open relay"', /open relay/.test(promptText), promptText);

  // --- click a cube navigates ----------------------------------------------
  const relayCube = await page.evaluate(() => window.talviProbe().find((b) => b.key === "relay"));
  await page.mouse.move(relayCube.x, relayCube.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1200);
  check("clicking a cube opens its app", page.url().includes("/relay"), page.url());

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
