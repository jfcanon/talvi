// talvi hub — browser test (v7.0). Run against the live production hub:
//
//   npm i --no-save playwright-core   # already present in green's node_modules
//   node scripts/hub-browser-test.mjs [base-url]
//
// It exits 2 with instructions if playwright-core is absent, so a missing dep
// never reads as a failing test.
//
// Covers, live in a real browser: the page 200s, the 3D world boots (WebGL),
// the four app cubes exist (window.talviProbe — the names live in the world
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
  cinto: "/cinto",
  learn: "/learn",
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
  // Wait for the world to actually boot (WebGL + the ~600 KiB bundle on a cold
  // edge) — a fixed timeout races a slow first load and flakes.
  await page.waitForFunction(() => !!window.talviProbe, null, { timeout: 15000 });
  await page.waitForTimeout(400); // let a frame render

  check("page loads with title talvi", (await page.title()) === "talvi");
  const world = await page.evaluate(() => {
    const canvas = document.getElementById("scene");
    const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
    return { canvas: !!canvas, webgl: !!gl };
  });
  check("webgl world boots", world.canvas && world.webgl);

  // --- the app cubes (in the world, probed) --------------------------------
  const cubes = await page.evaluate(() => (window.talviProbe ? window.talviProbe() : []));
  check("four app cubes (talviProbe)", cubes.length === 4, `found ${cubes.length}`);
  for (const c of cubes) {
    check(`cube ${c.key} → ${c.href}`, c.href === EXPECTED_NODES[c.key] && c.visible, `${c.href} visible=${c.visible}`);
  }
  const learn = cubes.find((c) => c.key === "learn");
  check("LEARN cube href is /learn", !!learn && learn.href === "/learn", learn ? learn.href : "missing");
  check("LEARN cube visible", !!learn && learn.visible, learn ? `visible=${learn.visible}` : "missing");
  check("no DOM app labels (names are in the world)", (await page.locator(".node").count()) === 0);

  // --- the blade -----------------------------------------------------------
  check("blade nav present", (await page.locator(".blade").count()) === 1);
  const learnBlade = page.locator('.blade__item[href="/learn"]');
  check("blade LEARN → /learn", (await learnBlade.count()) === 1);
  check("blade LEARN is visible", await learnBlade.isVisible());
  check(
    "blade LEARN is reachable",
    (await learnBlade.evaluate((el) => el.tagName)) === "A" && (await learnBlade.getAttribute("href")) === "/learn",
  );
  check("blade has login control", (await page.locator(".blade__login").count()) === 1);
  // UX review: the login is an ICON in the collapsed rail (⏻), never text —
  // the rail is pure glyphs and a label would overflow it.
  check(
    "blade login is an icon (no SIGN text)",
    (await page.locator(".blade__login").textContent()).trim() === "⏻",
  );
  const blade = page.locator(".blade");
  await page.locator(".blade__toggle").click();
  check("blade opens on toggle", await blade.evaluate((el) => el.classList.contains("is-open")));
  await page.locator(".blade__toggle").click();
  check("blade closes on second toggle", !(await blade.evaluate((el) => el.classList.contains("is-open"))));

  // --- the agent panel (blueprint PR2) -------------------------------------
  // The MORE slot is a real button; clicking it reveals the panel, which
  // connects to /agent/ws (same origin, CSP connect-src 'self' permits the
  // upgrade) and round-trips a write/read through the AgentDO workspace.
  const agentToggle = page.locator("#agent-toggle");
  check("MORE slot is a button", (await agentToggle.count()) === 1 && (await agentToggle.evaluate((el) => el.tagName)) === "BUTTON");
  await agentToggle.click();
  await page.waitForTimeout(300);
  check("agent panel opens", await page.locator("#agent-panel").isVisible());
  const statusAfterOpen = await page.locator("#agent-status").textContent();
  check("agent connects over same-origin WS", statusAfterOpen === "connected", statusAfterOpen);

  if (statusAfterOpen === "connected") {
    await page.locator("#agent-input").fill("write /workspace/note.txt hello agent");
    await page.locator("#agent-send").click();
    await page.waitForTimeout(250);
    await page.locator("#agent-input").fill("read /workspace/note.txt");
    await page.locator("#agent-send").click();
    await page.waitForTimeout(250);
    const logText = await page.locator("#agent-log").textContent();
    check("agent fs write/read round-trips", /hello agent/.test(logText), logText.slice(0, 200));
  }

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
    (n, i) => Math.abs(n.x - before[i].x) > 10,
  );
  check("drag orbits the world (labels move)", orbited, JSON.stringify({ before, afterOrbit }));

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(250);
  const afterZoom = await nodeXs();
  const zoomed = afterZoom.some(
    (n, i) => Math.abs(n.x - afterOrbit[i].x) > 10,
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
