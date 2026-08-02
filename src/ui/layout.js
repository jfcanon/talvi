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

const FOOT =
  "Files are deleted when they expire. Anyone with the link can download — " +
  "there is no sign-in, so treat a link like the file itself.";

// `title` and `lede` are RAW text: escaping happens here so it cannot be
// forgotten at a call site, and so nothing is ever escaped twice. `content` is
// already-built markup and is the caller's responsibility.
export function renderPage(title, { lede, content, foot = "", script = false }) {
  const v = encodeURIComponent(ASSET_VERSION);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>" +
    escapeHtml(title) +
    "</title>" +
    '<link rel="stylesheet" href="/s.css?v=' +
    v +
    '">' +
    (script ? '<script src="/s.js?v=' + v + '" defer></script>' : "") +
    "</head><body>" +
    // The moving scan band (A.5a). A real element rather than a third
    // pseudo-element, because html has only ::before and ::after and both are
    // spoken for — rain and static scanlines. Empty, decorative, aria-hidden.
    '<div class="scan" aria-hidden="true"></div>' +
    '<div class="wrap">' +
    '<header class="head">' +
    '<h1 class="sign">talvi<span class="sign__mark">drop</span></h1>' +
    // data-type marks this for the typed reveal. The text is PLAIN — the
    // typewriter writes with textContent, so any markup inside would be
    // silently flattened. Emphasis in a console voice comes from the words,
    // not from bold.
    '<p class="lede" data-type>' +
    escapeHtml(lede) +
    "</p>" +
    "</header>" +
    '<main class="stack">' +
    content +
    "</main>" +
    '<footer class="foot">' +
    FOOT +
    (foot ? " " + foot : "") +
    "</footer>" +
    "</div></body></html>"
  );
}
