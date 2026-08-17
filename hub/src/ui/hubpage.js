// talvi hub — the constellation front door (v7.0).
//
// Server-rendered markup; the world boots from /h.js (scene modules bundled by
// build-assets.mjs) and /h.css is linked, never inlined — CSP default-src
// 'none', no inline styles or scripts.
//
// The page is a fixed WebGL canvas — a small world you move through like
// Google Earth — plus:
//   - the blade: flat chrome rail, always visible, keyboard-first — the
//     instant switcher, and the navigation fallback if WebGL is absent.
//   - four CUBES (relay, chat, cinto, learn). Click a cube (raycast) to open
//     its app. The blade is the keyboard
//     path; there are no DOM app labels (the names live in the world).
//   - the HUD: the `>_` prompt (which echoes a hovered cube as
//     "> open relay") and a one-line hint of the controls.
//   - the .leak/.grain/.wear film overlays, above the canvas (A5c).
import { ASSET_VERSION } from "../generated/assets.js";

const v = encodeURIComponent(ASSET_VERSION);

// Blade items — data, not markup scattered through the template. `href` null
// renders a disabled future-slot.
const APPS = [
  {
    glyph: "▣",
    label: "RELAY",
    href: "https://app.ygdcbtmc4u.uk/relay",
    title: "Talvi — file share (relay)",
  },
  {
    glyph: "▤",
    label: "CHAT",
    href: "https://app.ygdcbtmc4u.uk/chat",
    title: "Chat",
  },
  {
    glyph: "◈",
    label: "CINTO",
    href: "/cinto",
    title: "Cinto — compliance",
  },
  {
    glyph: "◆",
    label: "LEARN",
    href: "/learn",
    title: "Tribunal Learn — the machinery",
  },
  {
    glyph: "＋",
    label: "MORE",
    href: null,
    title: "Agent",
  },
];

// The world cubes — the apps you can open — live in scene/world.js (their
// keys, nameplates and hrefs). The blade below covers keyboard navigation;
// the raycast covers clicking a cube. No DOM app labels.
//
// The MORE slot is a REAL <button> — it toggles the agent panel (PR2), not a
// link. No inline handler (CSP: script-src 'self' — which is WHY the toggle
// is a button + addEventListener in client.js, never an onclick attribute).
function bladeItems() {
  return APPS.map((app) =>
    app.href
      ? '<a class="blade__item" href="' +
        app.href +
        '" title="' +
        app.title +
        '"><span class="blade__glyph" aria-hidden="true">' +
        app.glyph +
        '</span><span class="blade__label">' +
        app.label +
        "</span></a>"
      : '<button class="blade__item is-slot" id="agent-toggle" type="button" title="' +
        app.title +
        '" aria-haspopup="true" aria-expanded="false" aria-controls="agent-panel">' +
        '<span class="blade__glyph" aria-hidden="true">' +
        app.glyph +
        '</span><span class="blade__label">' +
        app.label +
        "</span></button>",
  ).join("");
}

export function hubPage({ authed } = {}) {
  // The login control — an ICON link, keeping the blade's icon-only chrome
  // (the collapsed rail is pure glyphs; text would overflow it). The glyph is
  // ⏻ either way; signed in it is lit (is-in) and the aria-label + href flip
  // to sign-out. A plain link so it works with no JS.
  const login = authed
    ? '<a class="blade__login is-in" href="/api/signout" aria-label="sign out">⏻</a>'
    : '<a class="blade__login" href="/sign-in?redirect=/" aria-label="sign in">⏻</a>';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>talvi</title>" +
    '<link rel="stylesheet" href="/h.css?v=' +
    v +
    '">' +
    '<script src="/h.js?v=' +
    v +
    '" defer></script>' +
    "</head><body>" +
    // The fixed WebGL world sits beneath everything; the film overlays above
    // it, exactly as they sit above talvi's page (A5c). aria-hidden throughout.
    '<canvas id="scene" aria-hidden="true"></canvas>' +
    '<nav class="blade" aria-label="apps">' +
    '<div class="blade__nav">' +
    bladeItems() +
    "</div>" +
    // Icon-only toggle: the glyph says what the NEXT click does (» = expand,
    // « = collapse). client.js keeps the aria-label and aria-pressed honest.
    '<button class="blade__toggle" type="button" aria-pressed="false" aria-controls="blade" aria-label="expand rail">' +
    "»" +
    "</button>" +
    // Login control at the bottom — SIGN IN / SIGN OUT depending on the
    // host-wide __session cookie (the auth state the worker passed in).
    login +
    "</nav>" +
    // The HUD: the terminal prompt (echoes a hovered cube) and the hint.
    '<div class="hud">' +
    '<p class="prompt" aria-live="polite">' +
    '<span class="prompt__gt" aria-hidden="true">&gt;</span>' +
    '<span class="prompt__text"> </span>' +
    '<span class="prompt__caret" aria-hidden="true">_</span>' +
    "</p>" +
    '<p class="hint" aria-hidden="true">drag to look · scroll to zoom · click a star</p>' +
    "</div>" +
    // The agent panel (PR2) — the agent's chat front door. Hidden by default;
    // the MORE blade button toggles it (client.js). Sits above the world but
    // below the film overlays, same stacking as the HUD. The panel is real
    // markup, the log is written by client.js, and the input is a plain
    // <input> + <button> — no form (CSP form-action 'none').
    '<section class="agent" id="agent-panel" hidden aria-label="agent">' +
    '<header class="agent__head"><span class="agent__title">AGENT</span>' +
    '<span class="agent__status" id="agent-status">offline</span></header>' +
    '<div class="agent__log" id="agent-log" role="log" aria-live="polite"></div>' +
    '<div class="agent__compose">' +
    '<input class="agent__input" id="agent-input" type="text" autocomplete="off" spellcheck="false" aria-label="command" placeholder="chat … · write/read/ls/rm … · pr <branch> <title>">' +
    '<button class="agent__send" id="agent-send" type="button" aria-label="send">▸</button>' +
    "</div>" +
    "</section>" +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    "</body></html>"
  );
}
