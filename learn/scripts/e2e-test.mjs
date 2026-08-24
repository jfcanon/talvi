// Headless-browser e2e for the lesson flow (NID-414).
// Playwright chromium, headless. Exercises the real client.js via a
// local http server that forwards to the built Worker (see dev-serve.mjs).
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   - ${name}`);
  else { console.error(`FAIL - ${name} ${extra}`); failures += 1; }
}

const { startServer } = await import(join(root, "scripts/dev-serve.mjs"));
const { server, url: baseUrl, close } = await startServer(0);
console.log(`e2e dev-serve at ${baseUrl}`);

const { chromium } = await import("playwright");
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
function findChromiumFallback() {
  const candidates = [];
  // Darwin arm64 / x64 caches for various revisions
  const cacheBase = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cacheBase)) {
    for (const entry of readdirSync(cacheBase)) {
      if (!entry.startsWith("chromium-")) continue;
      const p1 = join(cacheBase, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium");
      const p2 = join(cacheBase, entry, "chrome-mac-arm64", "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium");
      const p3 = join(cacheBase, entry, "chrome-linux", "chrome");
      const p4 = join(cacheBase, entry, "chrome-linux", "chrome-linux", "chrome");
      for (const p of [p1, p2, p3, p4]) if (existsSync(p)) candidates.push(p);
    }
  }
  const linuxBase = join(homedir(), ".cache/ms-playwright");
  if (existsSync(linuxBase)) {
    for (const entry of existsSync(linuxBase) ? readdirSync(linuxBase) : []) {
      if (!entry.startsWith("chromium-")) continue;
      const p = join(linuxBase, entry, "chrome-linux", "chrome");
      if (existsSync(p)) candidates.push(p);
    }
  }
  // Also try playwright's own reported path if it exists
  try { const ep = chromium.executablePath(); if (existsSync(ep)) candidates.push(ep); } catch {}
  return candidates[0] || null;
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (e) {
  const fallback = findChromiumFallback();
  if (fallback) {
    console.log(`chromium launch fallback to ${fallback}: ${e.message}`);
    browser = await chromium.launch({ headless: true, executablePath: fallback, args: ["--no-sandbox"] });
  } else throw e;
}
const context = await browser.newContext();
const page = await context.newPage();

let pageErrors = [];
let consoleErrors = [];
page.on("pageerror", (e) => { pageErrors.push(String(e)); console.error("pageerror:", e); });
page.on("console", (msg) => {
  if (msg.type() === "error") {
    const text = msg.text();
    // Ignore the favicon 404 until PR7 fixes it.
    if (text.includes("favicon.ico") || text.includes("/favicon")) return;
    // Chromium logs 404s as console errors for favicon; also ignore network 404 for favicon
    consoleErrors.push(text);
    console.error("console error:", text);
  }
});
page.on("response", (resp) => {
  const u = resp.url();
  if (u.endsWith("/favicon.ico") && resp.status() === 404) {
    // expected until PR7
  }
});
page.on("requestfailed", (req) => {
  const u = req.url();
  if (u.endsWith("/favicon.ico")) return;
});

try {
  const base = baseUrl;

  // 1. Open lesson u1l1
  await page.goto(`${base}/learn/lesson/u1l1`, { waitUntil: "domcontentloaded" });

  // Assert gate visible and exercises locked
  const gate = page.locator(".preread-gate");
  await gate.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const gateVisible = await gate.isVisible().catch(() => false);
  check("preread-gate visible", gateVisible);
  const gateHiddenAttr = await page.locator(".preread-gate").getAttribute("hidden").catch(() => null);
  check("preread-gate not hidden", gateHiddenAttr === null);

  const exercisesEl = page.locator(".exercises");
  const locked = await exercisesEl.getAttribute("data-locked");
  check('exercises[data-locked="true"] ships locked', locked === "true");

  // Also ensure gate precedes exercises in DOM (visual overlap guard)
  const gateAndExercisesOrder = await page.evaluate(() => {
    const g = document.querySelector(".preread-gate");
    const e = document.querySelector(".exercises");
    if (!g || !e) return false;
    return (g.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  check("preread gate precedes exercises section", gateAndExercisesOrder);

  // 2. Click I'm Ready
  const readyBtn = page.locator('[data-action="ready"]');
  await readyBtn.waitFor({ state: "visible", timeout: 5000 });
  await readyBtn.click();
  // After click gate hidden, exercises unlocked
  await page.waitForTimeout(300);
  const gateHidden = await page.locator(".preread-gate").isHidden().catch(() => false);
  // Alternative: check hidden attribute
  const gateNowHidden = await page.evaluate(() => {
    const g = document.querySelector(".preread-gate");
    return !g || g.hidden === true || getComputedStyle(g).display === "none" || g.hasAttribute("hidden");
  });
  check("after Ready gate hidden", gateNowHidden);
  const lockedAfter = await page.locator(".exercises").getAttribute("data-locked").catch(() => null);
  check("after Ready exercises unlocked (no data-locked)", lockedAfter === null);

  // 3. Answer exercises 1 and 2 (select type)
  // Each exercise carries data-ex JSON; read answer index and click .choice[data-i="<answer>"]
  const exerciseHandles = await page.$$(".exercise");
  check("lesson has at least 3 exercises", exerciseHandles.length >= 3, `found ${exerciseHandles.length}`);

  // Parse data-ex for first two exercises
  for (let idx = 0; idx < 2; idx++) {
    const exEl = page.locator(".exercise").nth(idx);
    const dataExRaw = await exEl.getAttribute("data-ex");
    if (!dataExRaw) { check(`exercise ${idx} has data-ex`, false); continue; }
    // Browser decodes &quot; already; page.getAttribute returns decoded.
    let ex;
    try { ex = JSON.parse(dataExRaw); } catch (e) {
      // Fallback: unescape &quot;
      try { ex = JSON.parse(dataExRaw.replace(/&quot;/g, '"').replace(/&amp;/g, "&")); } catch { ex = null; }
    }
    if (!ex || typeof ex.answer !== "number") {
      check(`exercise ${idx} answer index parsable`, false, String(dataExRaw).slice(0, 200));
      continue;
    }
    const choiceSel = `.choice[data-i="${ex.answer}"]`;
    const btn = exEl.locator(choiceSel);
    await btn.waitFor({ state: "visible", timeout: 3000 });
    await btn.click();
    await page.waitForTimeout(200);
  }

  // 4. Pair the match exercise (third exercise, type match)
  // Match is expected to be the last exercise for u1l1
  const matchIdx = 2; // zero-based third
  const matchEx = page.locator(".exercise").nth(matchIdx);
  const matchDataRaw = await matchEx.getAttribute("data-ex");
  let matchExJson = null;
  try { matchExJson = JSON.parse(matchDataRaw); } catch {
    try { matchExJson = JSON.parse(matchDataRaw.replace(/&quot;/g, '"').replace(/&amp;/g, "&")); } catch {}
  }
  check("match exercise has pairs", !!(matchExJson && Array.isArray(matchExJson.pairs) && matchExJson.pairs.length > 0), JSON.stringify(matchExJson)?.slice(0, 200));

  if (matchExJson && Array.isArray(matchExJson.pairs)) {
    for (let i = 0; i < matchExJson.pairs.length; i++) {
      const leftSel = `.match__item--left[data-key="${i}"]`;
      const left = matchEx.locator(leftSel);
      await left.waitFor({ state: "visible", timeout: 3000 });
      await left.click();
      await page.waitForTimeout(150);
      const rightVal = matchExJson.pairs[i].right;
      // Escape for attribute selector: rightVal may contain quotes; use evaluate click by data-match
      const rightClicked = await matchEx.evaluate((el, rv) => {
        const btn = el.querySelector(`.match__item--right[data-match="${CSS.escape(rv)}"]`);
        // fallback manual scan if CSS.escape not matching due to attr encoding
        if (btn) { btn.click(); return true; }
        // brute search
        for (const b of el.querySelectorAll(".match__item--right")) {
          if (b.getAttribute("data-match") === rv) { b.click(); return true; }
        }
        return false;
      }, rightVal);
      if (!rightClicked) {
        // Try alternative selector via page locator with attribute value search
        const candidates = matchEx.locator(".match__item--right");
        const count = await candidates.count();
        let found = false;
        for (let c = 0; c < count; c++) {
          const dm = await candidates.nth(c).getAttribute("data-match");
          if (dm === rightVal) { await candidates.nth(c).click(); found = true; break; }
        }
        check(`match right ${i} (${rightVal}) clicked`, found);
      }
      await page.waitForTimeout(150);
    }
    // Click check
    const checkBtn = matchEx.locator('[data-action="check"]');
    await checkBtn.waitFor({ state: "visible", timeout: 3000 });
    // Ensure enabled
    const disabled = await checkBtn.isDisabled().catch(() => true);
    check("match check button enabled after pairing", !disabled);
    await checkBtn.click();
    await page.waitForTimeout(400);
  }

  // 5. Assert every exercise correct, continue visible, complete flow
  const states = await page.$$eval(".exercise", (els) => els.map((e) => e.getAttribute("data-state")));
  check("every .exercise[data-state=\"correct\"]", states.every((s) => s === "correct"), JSON.stringify(states));

  const continueBtn = page.locator('[data-action="continue"]');
  await continueBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const contVisible = await continueBtn.isVisible().catch(() => false);
  check('[data-action="continue"] visible after all correct', contVisible);
  await continueBtn.click();
  await page.waitForTimeout(800);

  const completeEl = page.locator(".complete");
  await completeEl.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const completeVisible = await completeEl.isVisible().catch(() => false);
  check(".complete visible after continue", completeVisible);

  // Pill XP should be 10 (server idempotent completion). The HUD pill is .pill--xp strong
  const xpText = await page.locator(".pill--xp strong").textContent().catch(() => null);
  check(".pill--xp strong = 10", (xpText || "").trim() === "10", `got ${xpText}`);

  // #next-btn href should be /learn/lesson/u1l2
  const nextHref = await page.locator("#next-btn").getAttribute("href").catch(() => null);
  check('#next-btn[href="/learn/lesson/u1l2"]', nextHref === "/learn/lesson/u1l2", `got ${nextHref}`);

  // Click next, assert URL ends /lesson/u1l2
  if (nextHref) {
    await page.locator("#next-btn").click();
    await page.waitForURL((u) => u.pathname.endsWith("/lesson/u1l2"), { timeout: 5000 }).catch(() => {});
    const urlAfter = page.url();
    check("after Next URL ends /lesson/u1l2", urlAfter.includes("/lesson/u1l2"), urlAfter);
  }

  // 6. Open /learn/ and check nodes
  await page.goto(`${base}/learn/`, { waitUntil: "domcontentloaded" });
  // Wait for rail
  await page.locator(".rail").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const masteredSel = '.node--mastered[href="/learn/lesson/u1l1"]';
  const activeSel = '.node--active[href="/learn/lesson/u1l2"]';
  // Some CSS may use node--mastered vs node--front; check both but spec says --mastered/--active
  const masteredVis = await page.locator(masteredSel).count().then((c) => c > 0).catch(() => false);
  check('.node--mastered[href="/learn/lesson/u1l1"]', masteredVis);
  const activeVis = await page.locator(activeSel).count().then((c) => c > 0).catch(() => false);
  check('.node--active[href="/learn/lesson/u1l2"]', activeVis);

  // Fail on any pageerror or console error (ignoring favicon)
  check("no pageerror", pageErrors.length === 0, pageErrors.join("; ").slice(0, 500));
  check("no console error (except favicon)", consoleErrors.length === 0, consoleErrors.join("; ").slice(0, 500));

} catch (e) {
  console.error("e2e exception:", e?.stack || e);
  failures += 1;
} finally {
  // Save full-page screenshot to dist/e2e-after.png
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await page.screenshot({ path: join(root, "dist/e2e-after.png"), fullPage: true });
    console.log("screenshot saved to dist/e2e-after.png");
  } catch (e) { console.error("screenshot failed", e); }
  await browser.close().catch(() => {});
  await close().catch(() => {});
}

console.log(failures ? `\n${failures} failure(s)` : "\nall e2e tests passed");
process.exit(failures ? 1 : 0);
