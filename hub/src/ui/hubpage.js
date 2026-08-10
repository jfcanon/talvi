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
//   - one building per app (relay, chat, cinto). Each carries a floating
//     <a class="node"> label, parked on its building every frame by
//     scene/labels.js. Click the building OR its label → open the app.
//     The labels are real anchors: keyboard-reachable, and the guaranteed
//     path even before the first frame or if the raycast misses.
//   - the HUD: the `>_` prompt (which echoes a hovered building as
//     "> open relay") and a one-line hint of the controls.
//   - the .leak/.grain/.wear film overlays, above the canvas (A5c).
import { ASSET_VERSION } from "../generated/assets.js";

const v = encodeURIComponent(ASSET_VERSION);

// Blade items — data, not markup scattered through the template. `href` null
// renders a disabled future-slot.
const APPS = [
  {
    glyph: "▣",
    label: "TALVI",
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

// The world buildings — the apps you can open. data-key must match the
// building key in scene/world.js so scene/labels.js can find each anchor.
const NODES = [
  { key: "relay", label: "TALVI", href: "https://app.ygdcbtmc4u.uk/relay", title: "Open relay" },
  { key: "chat", label: "CHAT", href: "https://app.ygdcbtmc4u.uk/chat", title: "Open chat" },
  { key: "cinto", label: "CINTO", href: "https://cinto.ygdcbtmc4u.uk", title: "Open cinto" },
];

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

function nodeItems() {
  return NODES.map(
    (node) =>
      '<a class="node is-off" data-key="' +
      node.key +
      '" href="' +
      node.href +
      '" title="' +
      node.title +
      '">' +
      node.label +
      "</a>",
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
    // The building labels, parked on their buildings by scene/labels.js.
    '<main class="world">' +
    nodeItems() +
    "</main>" +
    // The HUD: the terminal prompt (echoes a hovered building) and the hint.
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
