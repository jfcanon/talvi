// talvi shared shell — browser test (power-app shell verify).
//
// Run against live production:
//   npm i --no-save playwright-core
//   node scripts/shell-browser-test.mjs [base-url]
//
// Proves the owner-facing claim: the blade is the PERSISTENT shell on every
// app page. For each of /, /relay, /chat: the blade renders, the correct item
// is marked active (aria-current), the content lives in a .panel, and the
// page raises zero own-page CSP violations. Also checks the blade retraction
// persists across a navigation (same localStorage key).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://app.ygdcbtmc4u.uk";

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
const context = await browser.newContext();
const page = await context.newPage();

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
  // The blade appears on every app page, with the right item active.
  const cases = [
    { path: "/", active: null },
    { path: "/relay", active: "relay" },
    { path: "/chat", active: "chat" },
  ];

  for (const { path, active } of cases) {
    await page.goto(base + path, { waitUntil: "load", timeout: 30000 });
    const label = path === "/" ? "home" : path.slice(1);
    check(`${label}: shell present`, (await page.locator("#shell").count()) === 1);
    check(`${label}: blade present`, (await page.locator(".blade").count()) === 1);
    check(`${label}: content in a panel`, (await page.locator("main.panel").count()) === 1);

    if (active) {
      const activeItem = await page
        .locator(`.blade__item.is-active[aria-current="page"]`)
        .allTextContents();
      check(
        `${label}: ${active} item is active`,
        activeItem.length === 1 && activeItem[0].trim().toLowerCase() === active,
        JSON.stringify(activeItem),
      );
    } else {
      check(`${label}: no item active on home`, (await page.locator(".blade__item.is-active").count()) === 0);
    }
  }

  // Blade state persists across navigation (same localStorage key): open the
  // rail on the hub, navigate to relay, and the rail is still open.
  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  const shell = page.locator("#shell");
  const toggle = page.locator(".blade__toggle");
  await toggle.click();
  check("rail opened on hub", await shell.evaluate((el) => el.classList.contains("is-open")));
  await page.goto(base + "/relay", { waitUntil: "load", timeout: 30000 });
  const relayShell = page.locator("#shell");
  check(
    "rail stays open after navigating to relay",
    await relayShell.evaluate((el) => el.classList.contains("is-open")),
  );

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
