// talvi hub — welcome page (A1). Server-rendered markup; behaviour lives in
// /h.js (blade retraction) and /h.css is linked, never inlined — CSP
// default-src 'none', no inline styles or scripts (A11).
//
// The blade is a plain <a> list. Each item is one mini icon + a label. The
// collapsed rail shows icons; expanding shows labels. Icons are text glyphs —
// no external images, no SVG files, nothing that needs img-src beyond 'self'
// and data: (the CSP already allows both).
//
// For now (temporary state, A3): the hrefs point at each app's current home
// host. When an app migrates to app.ygdcbtmc4u.uk/<path>, its href updates in
// the same PR as the migration.
import { ASSET_VERSION } from "../generated/assets.js";

const v = encodeURIComponent(ASSET_VERSION);

// Blade items are data, not markup scattered through the template — adding an
// app later is one row here plus its migration. `href` null renders a disabled
// future-slot.
const APPS = [
  {
    glyph: "▣",
    label: "TALVI",
    href: "https://talvi.ygdcbtmc4u.uk",
    title: "Talvi — file share",
  },
  {
    glyph: "▤",
    label: "CHAT",
    href: "https://talvi.ygdcbtmc4u.uk/chat",
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

export function welcomePage() {
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
    '<div class="hub" id="hub">' +
    '<nav class="blade" aria-label="apps">' +
    '<span class="blade__tag">apps</span>' +
    '<div class="blade__nav">' +
    bladeItems() +
    "</div>" +
    '<button class="blade__toggle" type="button" aria-pressed="false" aria-controls="hub">' +
    "retract" +
    "</button>" +
    "</nav>" +
    '<main class="welcome">' +
    '<h1 class="welcome__wordmark">talvi</h1>' +
    '<p class="welcome__lede">The talvi power app. One front door for file ' +
    "share, chat, cinto and whatever comes next.</p>" +
    '<div class="welcome__status">' +
    "<span>node</span><b>app.ygdcbtmc4u.uk</b>" +
    "<span>mode</span><b>ready</b>" +
    "</div>" +
    "</main>" +
    "</div></body></html>"
  );
}
