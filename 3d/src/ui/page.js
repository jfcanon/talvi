// talvi 3d — page shell (blueprint A5/A6).
//
// The whole page is a fixed canvas plus five 100vh scroll sections whose
// captions are static server-rendered text in the console register. Nothing is
// inlined: /3d.css and /3d.js are linked with ?v=<hash> (the immutable-cache
// contract from green/hub — the URL changes when the bytes do).
import { ASSET_VERSION } from "../generated/assets.js";

const CHAPTERS = [
  { label: "01 / SIGN", line: "the sign holds the dark." },
  { label: "02 / INSTRUMENT", line: "every run of text sits on a line." },
  { label: "03 / ATMOSPHERE", line: "one register, executed well." },
  { label: "04 / STATUS", line: "hierarchy from fill, not a second colour." },
  { label: "05 / END", line: "a fault, not a palette." },
];

export function renderPage() {
  const v = encodeURIComponent(ASSET_VERSION);
  const chapters = CHAPTERS.map(
    (c, i) =>
      '<section class="chapter" id="c' + (i + 1) + '">' +
      '<p class="chapter__label">' + c.label + "</p>" +
      '<p class="chapter__line">' + c.line + "</p>" +
      "</section>",
  ).join("");

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>talvi — 3d</title>" +
    '<link rel="stylesheet" href="/3d.css?v=' + v + '">' +
    '<script src="/3d.js?v=' + v + '" defer></script>' +
    "</head><body>" +
    // The fixed WebGL layer sits beneath everything; the film overlays above
    // it, exactly as they sit above talvi's page (A5c). aria-hidden throughout.
    '<canvas id="scene" aria-hidden="true"></canvas>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    '<main class="chapters">' + chapters + "</main>" +
    "</body></html>"
  );
}
