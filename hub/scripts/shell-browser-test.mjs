// talvi shared shell — browser test (power-app shell verify).
//
// Run against live production:
//   npm i --no-save playwright-core
//   node scripts/shell-browser-test.mjs [base-url]
//
// Proves the owner-facing claim: the blade is the PERSISTENT shell on the app
// pages. The relay and chat pages render the shared shell (blade + panel, the
// correct item active). The hub home is the 3D world page — it also carries
// the blade (same rail, same links) but its content is a WebGL canvas, not a
// .panel; assert the blade + links there, not the panel shape. Also checks
// the blade retraction persists across a navigation (same localStorage key).
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
  // The blade appears on every page; the app pages carry the shared shell
  // (panel) and mark their item active.
  const cases = [
    { path: "/", active: null, hasPanel: false },
    { path: "/relay", active: "TALVI", hasPanel: true },
    { path: "/chat", active: "CHAT", hasPanel: true },
  ];

  for (const { path, active, hasPanel } of cases) {
    await page.goto(base + path, { waitUntil: "load", timeout: 30000 });
    const label = path === "/" ? "home" : path.slice(1);
    check(`${label}: blade present`, (await page.locator(".blade").count()) === 1);
    if (hasPanel) {
      check(`${label}: content in a panel`, (await page.locator("main.panel").count()) === 1);
    }

    if (active) {
      // The active item's LABEL (the text-only span, not the glyph+label
      // concatenation) must read the app name and carry aria-current.
      const activeLabels = await page
        .locator('.blade__item.is-active[aria-current="page"] .blade__label')
        .allTextContents();
      check(
        `${label}: ${active} item is active`,
        activeLabels.length === 1 && activeLabels[0].trim().toUpperCase() === active,
        JSON.stringify(activeLabels),
      );
    } else {
      check(
        `${label}: no item active on home`,
        (await page.locator(".blade__item.is-active").count()) === 0,
      );
    }

    // The blade links to the app paths on every page. The hub's 3D page uses
    // absolute URLs (https://app…/relay); the app shells use relative (/relay).
    // Either is correct — assert the path, not the form.
    for (const href of ["/relay", "/chat"]) {
      const exact = await page.locator(`.blade__item[href="${href}"]`).count();
      const absolute = await page
        .locator(`.blade__item[href="${base + href}"], .blade__item[href="${base + href + "/"}"]`)
        .count();
      check(`${label}: blade links ${href}`, exact + absolute >= 1);
    }
  }

  // Blade state persists across navigation: open the rail on relay, navigate
  // to chat, and the rail is still open (same localStorage key).
  await page.goto(base + "/relay", { waitUntil: "load", timeout: 30000 });
  const shell = page.locator("#shell");
  const toggle = page.locator(".blade__toggle");
  await toggle.click();
  check("rail opened on relay", await shell.evaluate((el) => el.classList.contains("is-open")));
  await page.goto(base + "/chat", { waitUntil: "load", timeout: 30000 });
  const chatShell = page.locator("#shell");
  check(
    "rail stays open after navigating to chat",
    await chatShell.evaluate((el) => el.classList.contains("is-open")),
  );

  check("zero own CSP violations", violations.length === 0, violations.join(" | ").slice(0, 300));
  // The edge beacon is expected on the proxied zone and blocked correctly. It
  // is reported as info, never as a failure — a permanently-red named check
  // would just teach everyone to ignore it (webapp-factory: normalising a red
  // check is worse than none). The real gate is `zero own CSP violations`
  // above; the fix for this line is a dashboard toggle, not a CSP change.
  console.log(
    injected.length
      ? "info: Cloudflare Browser Insights beacon blocked by CSP (correctly). Fix by " +
        "DISABLING the zone feature — Web Analytics / Browser Insights — never by " +
        "adding the host to script-src."
      : "info: no edge-injected third-party script detected",
  );
} catch (err) {
  check("browser run completes", false, String(err));
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
