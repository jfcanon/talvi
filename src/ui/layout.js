// Page shell. Deliberately minimal in Step 2 — it exists so the multi-module
// esbuild bundle (index.js -> layout.js -> generated/assets.js) is proven
// before any real UI code depends on it.
import { STYLE_CSS } from "../generated/assets.js";

export function renderPage(title, bodyHtml) {
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + title + "</title>" +
    "<style>" + STYLE_CSS + "</style>" +
    "</head><body>" + bodyHtml + "</body></html>"
  );
}
