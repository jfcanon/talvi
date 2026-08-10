// talvi shared shell — the blade (A1, extended for the power-app shell).
//
// The blade is the PERSISTENT left rail, embedded in EVERY worker's layout
// (hub, relay, chat) so it stays put while switching apps — the X/Twitter
// model, done server-rendered: each app page carries the same shell and only
// the content panel changes. Same-origin links: app.ygdcbtmc4u.uk/relay and
// /chat are the same host, so navigation is instant and the blade reads as
// constant.
//
// This file is COPIED byte-identical into hub/src/ui, relay/src/ui, and
// chat/src/ui (a moved shared component, like gate.js/chatcrypto.js). If it
// changes, all three copies change together — the blade must render the same
// in every app or the "one app" illusion breaks.
//
// `active` is the current app's key: "relay", "chat", "cinto", or null for the
// hub home. The active item gets an aria-current marker and a lit state.
//
// Markup only; behaviour (retract toggle) lives in the client.js of each
// worker, and the styles in each worker's style.css.

// One row per app. href is a SAME-ORIGIN path for apps mounted on app.*, and
// an absolute URL for cinto (still on its own host until the D migration).
// null renders the disabled future-slot.
export const BLADE_APPS = [
  {
    key: "relay",
    glyph: "▣",
    label: "RELAY",
    href: "/relay",
    title: "Talvi — file share (relay)",
  },
  {
    key: "chat",
    glyph: "▤",
    label: "CHAT",
    href: "/chat",
    title: "Chat",
  },
  {
    key: "cinto",
    glyph: "◈",
    label: "CINTO",
    href: "https://cinto.ygdcbtmc4u.uk",
    title: "Cinto — compliance",
  },
  {
    key: null,
    glyph: "＋",
    label: "MORE",
    href: null,
    title: "Future app",
  },
];

// Server-rendered blade markup. Items are a plain <a> list (keyboard-reachable
// for free); the toggle and the login control are real <button>s driven by
// client.js (no inline handlers, CSP). Active item is marked with aria-current
// and the lit class. The "apps" tag label is gone (v2) — the blade is soft
// chrome over the world, not a framed instrument panel.
export function bladeNav(active) {
  const items = BLADE_APPS.map((app) => {
    const isActive = app.key !== null && app.key === active;
    const cls = "blade__item" + (isActive ? " is-active" : "");
    const current = isActive ? ' aria-current="page"' : "";
    const inner =
      '<span class="blade__glyph" aria-hidden="true">' +
      app.glyph +
      '</span><span class="blade__label">' +
      app.label +
      "</span>";
    if (app.href) {
      return (
        '<a class="' +
        cls +
        '" href="' +
        app.href +
        '" title="' +
        app.title +
        '"' +
        current +
        ">" +
        inner +
        "</a>"
      );
    }
    return (
      '<span class="' +
      cls +
      ' is-slot" title="' +
      app.title +
      '">' +
      inner +
      "</span>"
    );
  });

  return (
    '<nav class="blade" aria-label="apps">' +
    '<div class="blade__nav">' +
    items.join("") +
    "</div>" +
    // Icon-only toggle: the glyph says what the NEXT click does (» = expand,
    // « = collapse). client.js keeps the aria-label and aria-pressed honest.
    '<button class="blade__toggle" type="button" aria-pressed="false" aria-controls="shell" aria-label="expand rail">' +
    "»" +
    "</button>" +
    // Login control at the bottom. A placeholder for now: auth on app.* is
    // Cloudflare Access at the edge (no in-app session); when Clerk lands
    // (backlog B3) this becomes the real gate.
    '<button class="blade__login" type="button" aria-label="sign in">' +
    "⏻" +
    "</button>" +
    "</nav>"
  );
}

// The page frame: the blade + the content panel. Every worker wraps its page
// in this so the shell is identical. `panel` is already-built content markup.
export function shell(active, panel) {
  return (
    '<div class="shell" id="shell">' + bladeNav(active) + '<main class="panel">' + panel + "</main></div>"
  );
}
