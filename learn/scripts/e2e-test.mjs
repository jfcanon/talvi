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

  // 1. Open lesson u1l1 - should show first card
  await page.goto(`${base}/learn/lesson/u1l1`, { waitUntil: "domcontentloaded" });

  // Assert cards container visible, exercises hidden
  const cardsContainer = page.locator(".cards");
  await cardsContainer.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const cardsVisible = await cardsContainer.isVisible().catch(() => false);
  check("cards container visible", cardsVisible);

  const exercisesEl = page.locator(".exercises");
  await exercisesEl.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
  const exercisesHidden = await exercisesEl.isHidden().catch(() => true);
  check("exercises section hidden initially", exercisesHidden);

  const locked = await exercisesEl.getAttribute("data-locked");
  check('exercises[data-locked="true"] ships locked', locked === "true");

  // 2. Click through cards using Next buttons
  // u1l1 has 4 facts, so 4 cards (last one is "I'm Ready")
  for (let cardIdx = 0; cardIdx < 4; cardIdx++) {
    const card = page.locator(`.card[data-index="${cardIdx}"]`);
    await card.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    const cardVisible = await card.isVisible().catch(() => false);
    check(`card ${cardIdx} visible`, cardVisible);

    const btnAction = cardIdx === 3 ? "ready" : "card-next";
    const btn = card.locator(`[data-action="${btnAction}"]`);
    await btn.waitFor({ state: "visible", timeout: 3000 });
    await btn.click();
    await page.waitForTimeout(300);
  }

  // After last card (I'm Ready), exercises section should be visible and unlocked
  const exercisesVisible = await exercisesEl.isVisible().catch(() => false);
  check("exercises section visible after I'm Ready", exercisesVisible);
  const lockedAfter = await exercisesEl.getAttribute("data-locked").catch(() => null);
  check("after I'm Ready exercises unlocked (no data-locked)", lockedAfter === null);

  // 3. Answer exercises one at a time
  // Each exercise carries data-ex JSON; read answer index and click .choice[data-i="<answer>"]
  const exerciseHandles = await page.$$(".exercise");
  check("lesson has at least 3 exercises", exerciseHandles.length >= 3, `found ${exerciseHandles.length}`);

  // Exercise 0: select type
  for (let idx = 0; idx < 3; idx++) {
    // Wait for current exercise to be visible
    const exEl = page.locator(`.exercise[data-index="${idx}"]`);
    await exEl.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

    const dataExRaw = await exEl.getAttribute("data-ex");
    if (!dataExRaw) { check(`exercise ${idx} has data-ex`, false); continue; }
    // Browser decodes " already; page.getAttribute returns decoded.
    let ex;
    try { ex = JSON.parse(dataExRaw); } catch (e) {
      // Fallback: unescape "
      try { ex = JSON.parse(dataExRaw.replace(/"/g, '"').replace(/&/g, "&")); } catch { ex = null; }
    }
    if (!ex) {
      check(`exercise ${idx} data-ex parsable`, false, String(dataExRaw).slice(0, 200));
      continue;
    }

    if (ex.type === "select" || ex.type === "spot") {
      if (typeof ex.answer !== "number") {
        check(`exercise ${idx} answer index parsable`, false, String(dataExRaw).slice(0, 200));
        continue;
      }
      const choiceSel = `.choice[data-i="${ex.answer}"]`;
      const btn = exEl.locator(choiceSel);
      await btn.waitFor({ state: "visible", timeout: 3000 });
      await btn.click();
    } else if (ex.type === "match") {
      // Pair the match exercise
      if (!Array.isArray(ex.pairs) || ex.pairs.length === 0) {
        check("match exercise has pairs", false, JSON.stringify(ex)?.slice(0, 200));
        continue;
      }
      for (let i = 0; i < ex.pairs.length; i++) {
        const leftSel = `.match__item--left[data-key="${i}"]`;
        const left = exEl.locator(leftSel);
        await left.waitFor({ state: "visible", timeout: 3000 });
        await left.click();
        await page.waitForTimeout(150);
        const rightVal = ex.pairs[i].right;
        // Escape for attribute selector: rightVal may contain quotes; use evaluate click by data-match
        const rightClicked = await exEl.evaluate((el, rv) => {
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
          const candidates = exEl.locator(".match__item--right");
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
      const checkBtn = exEl.locator('[data-action="check"]');
      await checkBtn.waitFor({ state: "visible", timeout: 3000 });
      const disabled = await checkBtn.isDisabled().catch(() => true);
      check("match check button enabled after pairing", !disabled);
      await checkBtn.click();
    }
    await page.waitForTimeout(400);

    // After answering, Continue button should appear
    const continueBtn = page.locator('[data-action="continue"]');
    await continueBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    const contVisible = await continueBtn.isVisible().catch(() => false);
    check(`[data-action="continue"] visible after exercise ${idx}`, contVisible);

    // If not last exercise, click Continue to advance
    if (idx < 2) {
      await continueBtn.click();
      await page.waitForTimeout(300);
    }
  }

  // 4. After last exercise, click Continue to complete
  const continueBtn = page.locator('[data-action="continue"]');
  await continueBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
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

  // 5. Open /learn/ and check nodes
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