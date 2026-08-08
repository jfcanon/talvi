// Full chat journey in a REAL browser, against the live Worker.
//
//   node scripts/chat-browser-test.mjs [base-url]
//
// Everything else in scripts/ tests the protocol: chat-gate-test.mjs proves the
// key derivation, chat-channel-test.mjs drives the Durable Object, and
// chat-ws-smoke.mjs speaks the wire. None of them execute src/ui/chat.js. That
// file is the part a person actually touches — the landing form, the
// sessionStorage handoff, the WebSocket wiring, PBKDF2 in a real engine, the
// reconnect button — and the only way to exercise it is a browser.
//
// It also checks the one thing nothing else can: that the page raises NO CSP
// violations. The CSP has never been weakened in this project, and "never
// weakened" is a claim about what the browser does, not about what the header
// says.
//
// PLAYWRIGHT IS NOT A DEPENDENCY OF THIS REPO, deliberately. talvi keeps its
// supply chain small and this is a manual pre-merge check, not a CI gate, so
// paying a browser-automation dependency in package.json to run it occasionally
// is the wrong trade. Install it ad hoc when you want to run this:
//
//   npm i --no-save playwright-core
//   npx playwright install chromium     # only if no browser is cached yet
//   node scripts/chat-browser-test.mjs
//
// The script exits 2 with instructions if playwright-core is absent, so a
// missing dependency reads as "not installed", never as a failing test.

const BASE = process.argv[2] ?? "https://talvi-web.ygdcbtmc4u.workers.dev";
const PIN = "Correct-Horse-9!";
const SECRET = "meet at the north pier at 0300";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error(
    "playwright-core is not installed (it is deliberately not a dependency).\n" +
      "  npm i --no-save playwright-core\n" +
      "  npx playwright install chromium   # if no browser is cached\n" +
      "then re-run this script.",
  );
  process.exit(2);
}

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? " → " + detail : ""}`);
  if (ok) passed += 1;
  else failures.push(name);
}

// playwright-core pins an exact browser revision and refuses anything else, so
// a cached build from a different Playwright version makes launch() fail even
// though a perfectly usable Chromium is sitting on disk. Fall back to whatever
// Chrome-for-Testing is cached rather than forcing a fresh several-hundred-MB
// download for a handful of assertions.
async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir, platform } = await import("node:os");
    const cache =
      platform() === "darwin"
        ? join(homedir(), "Library/Caches/ms-playwright")
        : join(homedir(), ".cache/ms-playwright");
    let entries = [];
    try {
      entries = (await readdir(cache)).filter((d) => d.startsWith("chromium-"));
    } catch {
      throw err; // no cache either; the original message is the useful one
    }
    for (const dir of entries.sort().reverse()) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux/chrome",
      ]) {
        try {
          return await chromium.launch({ executablePath: join(cache, dir, rel) });
        } catch {
          /* try the next candidate */
        }
      }
    }
    throw err;
  }
}

const browser = await launch();
const violations = [];
const injected = [];

// Cloudflare injects its Browser Insights beacon into HTML at the edge on the
// proxied zone — but only for requests that look like real browser navigations
// (`Sec-Fetch-Dest: document`), which is why curl sees nothing and this test
// does. The CSP blocks it, correctly.
//
// It is reported SEPARATELY from our own violations because the two demand
// opposite responses. A violation from our own page is a bug in our page. This
// is a third-party script the site never asked for, arriving from the edge, and
// the fix is to turn the zone feature off — NEVER to add the host to
// `script-src`. Conflating them is how a CSP that has never been weakened gets
// weakened, by someone making a red line go green.
const EDGE_INJECTED = /cloudflareinsights\.com|\/cdn-cgi\/(scripts|challenge-platform)/i;

// Separate CONTEXTS, not tabs: sessionStorage is per-context, and each member
// has to go through the landing to get their own nick and derived key.
async function openContext(label) {
  const ctx = await browser.newContext();
  // Capture the page's own socket so a drop can be forced later. setOffline
  // leaves an established WebSocket up in Chromium, so it proves nothing about
  // the reconnect path; closing the real instance runs the real handler.
  await ctx.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(target, args) {
        const sock = new target(...args);
        window.__ws = sock;
        return sock;
      },
    });
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect)/i.test(t)) {
      (EDGE_INJECTED.test(t) ? injected : violations).push(`[${label}] ${t}`);
    }
  });
  page.on("pageerror", (e) => violations.push(`[${label}] pageerror: ${e.message}`));
  return { ctx, page };
}

const sendable = () =>
  document.querySelector("#send") && !document.querySelector("#send").disabled;

const A = await openContext("A");
const B = await openContext("B");

// ---- A creates a gated channel through the real landing form --------------

await A.page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await A.page.click("#create");
const channel = await A.page.inputValue("#channel");
check("NEW NAME generates a slug", /^[a-z0-9-]{1,64}$/.test(channel), channel);

await A.page.fill("#nick", "alice");
await A.page.fill("#pin", "weak"); // must trip the D5 entropy floor
await A.page.click("#join");
await A.page.waitForTimeout(400);
check("weak PIN refused (D5)", /PIN —/.test((await A.page.textContent("#msg")) ?? ""));
check("weak PIN does not navigate", A.page.url().endsWith("/chat"));

await A.page.fill("#pin", PIN);
await A.page.click("#join");
await A.page.waitForURL(`**/chat/${channel}`, { timeout: 20000 });
await A.page.waitForFunction(sendable, { timeout: 30000 });
check("strong PIN admits the creator", true);
check("room reports ENCRYPTED",
  /^ENCRYPTED/.test(((await A.page.textContent("#mode")) ?? "").trim()));

// The PIN must never be persisted — only the value derived from it.
const stored = await A.page.evaluate(() => ({
  gate: sessionStorage.getItem("talvi.chat.gate"),
  nick: sessionStorage.getItem("talvi.chat.nick"),
}));
check("PIN is never stored", !(stored.gate ?? "").includes(PIN));
check("only derived key material is stored", /"master":"[0-9a-f]{64}"/.test(stored.gate ?? ""));
check("nick is stored", stored.nick === "alice");

// ---- B joins with the same PIN --------------------------------------------

await B.page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await B.page.fill("#channel", channel);
await B.page.fill("#nick", "bob");
await B.page.fill("#pin", PIN);
await B.page.click("#join");
await B.page.waitForURL(`**/chat/${channel}`, { timeout: 20000 });
await B.page.waitForFunction(sendable, { timeout: 30000 });
check("correct PIN admits a second member", true);
check("B's room also reports ENCRYPTED",
  /^ENCRYPTED/.test(((await B.page.textContent("#mode")) ?? "").trim()));

await A.page.waitForFunction(() => document.body.innerText.includes("bob"), { timeout: 15000 });
check("A sees bob arrive", true);
check("member list names the other member",
  /bob/.test((await A.page.textContent("#members")) ?? ""));

// ---- the conversation ------------------------------------------------------

await A.page.fill("#text", SECRET);
await A.page.click("#send");
await B.page.waitForFunction(
  (s) => document.querySelector("#msgs")?.innerText.includes(s),
  SECRET,
  { timeout: 15000 },
);
check("B decrypts and reads A's message", true);
check("message is attributed to alice", ((await B.page.textContent("#msgs")) ?? "").includes("alice"));

// ---- a wrong PIN is refused at the gate ------------------------------------

const C = await openContext("C");
await C.page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
await C.page.fill("#channel", channel);
await C.page.fill("#nick", "mallory");
await C.page.fill("#pin", "Wrong-Horse-9!");
await C.page.click("#join");
await C.page.waitForURL(`**/chat/${channel}`, { timeout: 20000 });
await C.page.waitForFunction(
  () => /REFUSED|LOCKED/.test(document.querySelector("#msg")?.textContent ?? ""),
  { timeout: 30000 },
);
check("wrong PIN is refused", /REFUSED/.test((await C.page.textContent("#msg")) ?? ""));
check("refused member cannot send", await C.page.isDisabled("#send"));
check("refused member saw no messages",
  !((await C.page.textContent("#msgs")) ?? "").includes(SECRET));

// ---- the shared-link flow (PR9) -------------------------------------------

// The way people actually arrive: someone sends you a link, you click it. A
// fresh context has no sessionStorage, so this is the cold path — and it used
// to bounce to /chat and demand you retype a 20-character random channel name
// you had just clicked.
const D = await openContext("D");
await D.page.goto(`${BASE}/chat/${channel}`, { waitUntil: "domcontentloaded" });
await D.page.waitForFunction(
  () => { const j = document.querySelector("#joinbox"); return j && !j.hidden; },
  { timeout: 20000 },
);
check("shared link stays on the room page", D.page.url().includes(`/chat/${channel}`));
check("shared link shows a join form", true);
check("join form does NOT ask for the channel name again",
  (await D.page.locator("#joinbox #channel").count()) === 0);

await D.page.fill("#roomnick", "carol");
await D.page.fill("#roompin", PIN);
await D.page.click("#roomjoin");
await D.page.waitForFunction(sendable, { timeout: 30000 });
check("joins straight from the shared link", true);
check("join form is dismissed once in", await D.page.isHidden("#joinbox"));
check("URL never bounced", D.page.url().includes(`/chat/${channel}`));
check("shared-link joiner sees ENCRYPTED",
  /^ENCRYPTED/.test(((await D.page.textContent("#mode")) ?? "").trim()));

// And they can actually talk.
const REPLY = "carol got here from the link";
await D.page.fill("#text", REPLY);
await D.page.click("#send");
await B.page.waitForFunction(
  (s) => document.querySelector("#msgs")?.innerText.includes(s),
  REPLY,
  { timeout: 15000 },
);
check("shared-link joiner can send to the room", true);

// A wrong PIN from a shared link must re-offer the form, not a dead end.
const E = await openContext("E");
await E.page.goto(`${BASE}/chat/${channel}`, { waitUntil: "domcontentloaded" });
await E.page.waitForFunction(
  () => { const j = document.querySelector("#joinbox"); return j && !j.hidden; },
  { timeout: 20000 },
);
await E.page.fill("#roomnick", "trudy");
await E.page.fill("#roompin", "Wrong-Horse-9!");
await E.page.click("#roomjoin");
await E.page.waitForFunction(
  () => /REFUSED|LOCKED/.test(document.querySelector("#msg")?.textContent ?? ""),
  { timeout: 30000 },
);
check("wrong PIN from a link is refused", true);
check("form is re-offered so the PIN can be corrected",
  await E.page.isVisible("#joinbox"));
check("refused joiner cannot send", await E.page.isDisabled("#send"));

// ---- reconnect (PR5) -------------------------------------------------------

await A.page.evaluate(() => window.__ws.close());
await A.page.waitForFunction(
  () => { const r = document.querySelector("#reconnect"); return r && !r.hidden; },
  { timeout: 20000 },
);
check("a dropped socket offers RECONNECT", true);
check("send is disabled while disconnected", await A.page.isDisabled("#send"));
check("transcript survives the drop", ((await A.page.textContent("#msgs")) ?? "").includes(SECRET));

await A.page.click("#reconnect");
await A.page.waitForFunction(sendable, { timeout: 30000 });
const after = (await A.page.textContent("#msgs")) ?? "";
check("reconnect rejoins the room", true);
check("a rule marks the seam", after.includes("reconnected"));
check("the old transcript is kept, not cleared", after.includes(SECRET));
check("roster is rebuilt after reconnect",
  /bob/.test((await A.page.textContent("#members")) ?? ""));

// ---- the CSP has still never been weakened ---------------------------------

check("no CSP violations or page errors from the page itself", violations.length === 0,
  violations.length ? violations.slice(0, 2).join(" | ") : "clean");

// Separate check, separate fix. This one is about the edge, not the page.
check("no third-party script injected by the edge", injected.length === 0,
  injected.length
    ? "Cloudflare Browser Insights beacon injected on this zone and blocked by " +
      "CSP (correctly). Fix by DISABLING the zone feature — Web Analytics / " +
      "Browser Insights — never by adding the host to script-src."
    : "clean");

await browser.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
