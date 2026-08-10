// talvi hub — the 3D front door (blueprint A1–A4).
//
// Server-rendered markup; the world boots from /h.js (scene modules bundled by
// build-assets.mjs) and /h.css is linked, never inlined — CSP default-src
// 'none', no inline styles or scripts (A11 unchanged).
//
// The page is a fixed WebGL canvas (the talvi world) plus:
//   - the blade: flat chrome rail, always visible, keyboard-first — the
//     instant switcher (A2). Icons are text glyphs, no external images.
//   - five scroll sections, one instrument per app. Each app section carries a
//     real <a> control plate (glyph + name + one line + open arrow) — the 3D
//     panel behind it is atmosphere, this anchor is the control (A3).
//   - the END section: a cinematic closing CTA in talvi's language (A4) — the
//     one salvageable idea from the library's prompt12, rebuilt here.
//   - the .leak/.grain/.wear film overlays, above the canvas (A5c).
import { ASSET_VERSION } from "../generated/assets.js";

const v = encodeURIComponent(ASSET_VERSION);

// Blade items — data, not markup scattered through the template. `href` null
// renders a disabled future-slot. Same targets as before P1 (app.* hosts).
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

// The world instruments, one per scroll section. Order must match the camera
// path in scene/scroll.js (RELAY, CHAT, CINTO) and the panel positions in
// scene/world.js (-16, -34, -52).
const INSTRUMENTS = [
  {
    glyph: "▣",
    label: "RELAY",
    sub: "file share",
    line: "drop a file, share a link, it expires.",
    href: "https://app.ygdcbtmc4u.uk/relay",
    title: "Open relay",
  },
  {
    glyph: "▤",
    label: "CHAT",
    sub: "rooms",
    line: "a room is an invitation already sent.",
    href: "https://app.ygdcbtmc4u.uk/chat",
    title: "Open chat",
  },
  {
    glyph: "◈",
    label: "CINTO",
    sub: "compliance",
    line: "cinto.ygdcbtmc4u.uk",
    href: "https://cinto.ygdcbtmc4u.uk",
    title: "Open cinto",
  },
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

function instrumentPlate(inst) {
  return (
    '<section class="chapter" id="' +
    inst.label.toLowerCase() +
    '">' +
    '<a class="plate" href="' +
    inst.href +
    '" title="' +
    inst.title +
    '">' +
    '<span class="plate__glyph" aria-hidden="true">' +
    inst.glyph +
    "</span>" +
    '<span class="plate__body">' +
    '<span class="plate__label">' +
    inst.label +
    " · " +
    inst.sub +
    "</span>" +
    '<span class="plate__line">' +
    inst.line +
    "</span>" +
    "</span>" +
    '<span class="plate__open" aria-hidden="true">open →</span>' +
    "</a>" +
    "</section>"
  );
}

export function hubPage() {
  const instruments = INSTRUMENTS.map(instrumentPlate).join("");
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
    '<span class="blade__tag">apps</span>' +
    '<div class="blade__nav">' +
    bladeItems() +
    "</div>" +
    '<button class="blade__toggle" type="button" aria-pressed="false" aria-controls="blade">' +
    "expand" +
    "</button>" +
    "</nav>" +
    '<main class="chapters">' +
    // 01 / SIGN — hero
    '<section class="chapter" id="sign">' +
    '<p class="chapter__label">01 / sign</p>' +
    '<p class="chapter__line">one front door for what comes next.</p>' +
    "</section>" +
    // one instrument per app
    instruments +
    // 05 / END — the closing CTA
    '<section class="chapter" id="end">' +
    '<p class="chapter__label">05 / end</p>' +
    '<h2 class="chapter__display">one front door.</h2>' +
    '<a class="btn" href="https://app.ygdcbtmc4u.uk/relay">enter →</a>' +
    "</section>" +
    "</main>" +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    "</body></html>"
  );
}
