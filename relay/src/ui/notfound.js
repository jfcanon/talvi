// The 404 page.
//
// ONE page for every miss: malformed slug, never existed, expired, R2 object
// gone, unmatched route. Byte-identical in all cases, deliberately (B.7 item
// 5) — an observer must not be able to tell "expired" from "never existed",
// because that difference is itself information about what was here.
//
// So: no dynamic content on this page. Nothing that could vary by cause. The
// copy is written to be true of every case at once.
import { renderPage } from "./layout.js";

export function notFoundPage() {
  const content =
    '<p class="lost glitch">404</p>' +
    '<p class="lost__say">Nothing lives at this address. It may have expired, ' +
    "it may never have existed — this page cannot tell you which, and that is " +
    "on purpose.</p>" +
    '<a class="btn" href="/">Drop a file</a>';

  return renderPage("talvi — nothing here", {
    lede: "NO RECORD. This address is dead, or was never alive.",
    content,
  });
}
