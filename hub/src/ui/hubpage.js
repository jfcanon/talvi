// talvi hub — the 2D front door (v5).
//
// Server-rendered markup; /h.css and /h.js are linked, never inlined — CSP
// default-src 'none'. The 3D world is gone; this is a 2D composition in the
// prompt12 design language with the cyberpunk palette (deep midnight purple,
// royal blue, magenta, soft pink, pale lavender):
//   - a full-viewport procedural atmosphere (CSS gradients + the film wear
//     stack — no external images, no CSP change),
//   - the blade as the slim sidebar (the persistent rail, keyboard-first),
//   - a hero: the promise, big, in the display face,
//   - a glass board: a front-door status card plus one glass card per app
//     (relay, chat, cinto) — real anchors, prompt12's liquid-glass language.
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

// The glass board cards — the apps you can open.
const CARDS = [
  {
    glyph: "▣",
    name: "relay",
    sub: "drop a file, share a link",
    href: "https://app.ygdcbtmc4u.uk/relay",
    title: "Open relay",
  },
  {
    glyph: "▤",
    name: "chat",
    sub: "a room is an invitation already sent",
    href: "https://app.ygdcbtmc4u.uk/chat",
    title: "Open chat",
  },
  {
    glyph: "◈",
    name: "cinto",
    sub: "compliance",
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

function appCards() {
  return CARDS.map(
    (c) =>
      '<a class="card card--app" href="' +
      c.href +
      '" title="' +
      c.title +
      '">' +
      '<span class="card__glyph" aria-hidden="true">' +
      c.glyph +
      "</span>" +
      '<span class="card__body">' +
      '<span class="card__name">' +
      c.name +
      "</span>" +
      '<span class="card__sub">' +
      c.sub +
      "</span>" +
      "</span>" +
      '<span class="card__open" aria-hidden="true">open →</span>' +
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
    // The atmosphere: a fixed procedural sky (gradients) beneath everything,
    // then the film wear stack above it (A5c, recoloured for v5). aria-hidden.
    '<div class="atmos" aria-hidden="true"></div>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    // The slim sidebar rail — flat chrome, keyboard-first, the instant
    // switcher.
    '<nav class="blade" aria-label="apps">' +
    '<div class="blade__nav">' +
    bladeItems() +
    "</div>" +
    '<button class="blade__toggle" type="button" aria-pressed="false" aria-controls="blade" aria-label="expand rail">' +
    "»" +
    "</button>" +
    '<button class="blade__login" type="button" aria-label="sign in">' +
    "⏻" +
    "</button>" +
    "</nav>" +
    // The 2D composition.
    '<main class="front">' +
    '<header class="front__head">' +
    '<a class="front__word" href="/">talvi</a>' +
    '<p class="prompt" aria-live="polite">' +
    '<span class="prompt__gt" aria-hidden="true">&gt;</span>' +
    '<span class="prompt__caret" aria-hidden="true">_</span>' +
    "</p>" +
    "</header>" +
    '<section class="hero">' +
    '<h1 class="hero__title">one front door.</h1>' +
    '<p class="hero__lede">file share, chat, cinto — and whatever comes next, behind one quiet door.</p>' +
    "</section>" +
    '<div class="board">' +
    // The front-door readout (prompt12's primary card): the big state, then
    // label/value rows.
    '<a class="card card--status" href="https://app.ygdcbtmc4u.uk/relay" title="enter the power app">' +
    '<span class="card__tag">front door</span>' +
    '<span class="card__big">ready</span>' +
    '<span class="card__row"><span>apps</span><b>3</b></span>' +
    '<span class="card__row"><span>mode</span><b>private</b></span>' +
    '<span class="card__row"><span>host</span><b>app.ygdcbtmc4u.uk</b></span>' +
    "</a>" +
    appCards() +
    "</div>" +
    "</main>" +
    "</body></html>"
  );
}
