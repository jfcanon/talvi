// Page shell.
//
// Step 5 changed one load-bearing thing: the CSS is LINKED, not inlined.
// Step 2's shell wrote <style>STYLE_CSS</style>, which the CSP (`style-src
// 'self'`, no 'unsafe-inline') blocks in the browser — invisible while the
// stylesheet was an empty stub, fatal the moment it carries the design.
//
// Assets carry a ?v=<hash> built from their own content (see
// scripts/build-assets.mjs). The paths stay /s.css and /s.js as the blueprint
// specifies; the query changes whenever the content does. That is what makes
// the year-long immutable cache in index.js safe on a fixed URL — without it a
// Step 6 CSS edit would never reach anyone who had loaded a page before.
//
// Every page is the same three blocks: the lit sign and its one line of
// explanation, the machine, the small print. On a phone they stack in that
// order; on a wide screen the sign and small print hold the left column while
// the machine takes the right (see .wrap in style.css). The DOM order is the
// reading order in both cases — the grid never reorders content.
import { ASSET_VERSION } from "../generated/assets.js";
import { escapeHtml } from "../sanitise.js";
import { PREFIX } from "../prefix.js";
import { shell } from "./blade.js";

// `title` and `lede` are RAW text: escaping happens here so it cannot be
// forgotten at a call site, and so nothing is ever escaped twice. `content` is
// already-built markup and is the caller's responsibility.
//
// Chat pages always get the shared shell (the persistent blade + this content
// as the panel) — chat is an app, and the blade is what makes switching apps
// read as one app. `shell: false` is not used here.
export function renderPage(title, { lede, content, script = false }) {
  const v = encodeURIComponent(ASSET_VERSION);

  // The instrument: the framed readout that is the chat panel.
  const instrument =
    '<div class="frame"><div class="wrap">' +
    '<header class="head">' +
    '<h1 class="sign glitch"><a class="sign__link" href="' + PREFIX + '/">talvi</a></h1>' +
    '<div class="tagline"><span class="tagline__box">status</span></div>' +
    '<div class="box">' +
    '<p class="lede glitch" data-type>' +
    escapeHtml(lede) +
    "</p>" +
    "</div>" +
    "</header>" +
    '<main class="stack">' +
    content +
    "</main>" +
    "</div></div>";

  // The body: ambient layers, then the shell (blade + panel).
  const body =
    '<div class="scan" aria-hidden="true"></div>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    shell("chat", instrument);

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>" +
    escapeHtml(title) +
    "</title>" +
    '<link rel="stylesheet" href="' + PREFIX + '/s.css?v=' +
    v +
    '">' +
    (script ? '<script src="' + PREFIX + '/s.js?v=' + v + '" defer></script>' : "") +
    "</head><body>" +
    body +
    "</body></html>"
  );
}
