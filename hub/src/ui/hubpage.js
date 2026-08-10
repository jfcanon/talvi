// talvi hub — the explorable front door (v4, ideas #1 + #2).
//
// Server-rendered markup; the world boots from /h.js (scene modules bundled by
// build-assets.mjs) and /h.css is linked, never inlined — CSP default-src
// 'none', no inline styles or scripts.
//
// The page is a fixed WebGL canvas — a small world you move through like
// Google Earth — plus:
//   - the blade: flat chrome rail, always visible, keyboard-first — the
//     instant switcher, and the navigation fallback if WebGL is absent.
//   - three CUBES (relay, chat, cinto), each with a fixed 3D nameplate above
//     it. Click a cube (raycast) to open its app. The blade is the keyboard
//     path; there are no DOM app labels (v4.1 — the names live in the world).
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
    href: "https://cinto.ygdcbtmc4u.uk",
    title: "Cinto — compliance",
  },
  {
    glyph: "＋",
    label: "MORE",
    href: null,
    title: "Future app",
  },
];

// The world cubes — the apps you can open — live in scene/world.js (their
// keys, nameplates and hrefs). The blade below covers keyboard navigation;
// the raycast covers clicking a cube. No DOM app labels (v4.1 — the names
// are fixed 3D nameplates in the world).
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
      : '<span class="blade__item is-slot" title="' +
        app.title +
        '"><span class="blade__glyph" aria-hidden="true">' +
        app.glyph +
        '</span><span class="blade__label">' +
        app.label +
        "</span></span>",
  ).join("");
}

export function hubPage() {
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
    // Login control at the bottom (placeholder — auth on app.* is Cloudflare
    // Access at the edge; when Clerk lands this becomes the real gate).
    '<button class="blade__login" type="button" aria-label="sign in">' +
    "⏻" +
    "</button>" +
    "</nav>" +
    // The HUD: the terminal prompt (echoes a hovered cube) and the hint.
    '<div class="hud">' +
    '<p class="prompt" aria-live="polite">' +
    '<span class="prompt__gt" aria-hidden="true">&gt;</span>' +
    '<span class="prompt__text"> </span>' +
    '<span class="prompt__caret" aria-hidden="true">_</span>' +
    "</p>" +
    '<p class="hint" aria-hidden="true">drag to look · scroll to zoom · click a node</p>' +
    "</div>" +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    "</body></html>"
  );
}
