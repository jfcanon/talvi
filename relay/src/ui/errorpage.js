// Themed pages for the two conditions that are not the user's fault and are
// not permanent: rate limited (429) and daily budget spent (503).
//
// Deliberately NOT reusing the 404 page. A 404 must be byte-identical in every
// case because distinguishing them would leak whether a slug ever existed
// (B.7 item 5). These two carry no such secret — they describe the server's
// state, not any file's — so they may and should say exactly what happened and
// when to come back.
import { renderPage } from "./layout.js";

export function limitedPage() {
  const content =
    '<div class="panel">' +
    '<p class="halt">429</p>' +
    '<p class="halt__say">Too many requests from this address. The limit is a ' +
    "minute wide, so waiting one is the whole fix.</p>" +
    "</div>";

  return renderPage("relay — slow down", {
    lede: "THROTTLED. This address is asking faster than the line allows.",
    content,
  });
}

export function closedPage() {
  const content =
    '<div class="panel">' +
    '<p class="halt">CLOSED</p>' +
    '<p class="halt__say">The daily transfer budget is spent. This is a cost ' +
    "ceiling, not a fault — it resets on a rolling 24-hour window, so the " +
    "earliest uploads from yesterday free up capacity first.</p>" +
    "</div>";

  return renderPage("relay — closed for the day", {
    lede: "CLOSED FOR THE DAY. The daily budget is spent.",
    content,
  });
}
