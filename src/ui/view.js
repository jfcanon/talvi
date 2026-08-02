// The recipient page — "/:slug".
//
// This is the app's ONLY stored-XSS sink: filename and content-type are
// client-supplied, sanitised at intake (src/sanitise.js) and escaped again
// here at render (B.7 item 3). Both, not either.
//
// Hierarchy: the download button is the brightest and largest thing on the
// page. Everything else is a label on the thing you came to collect.
import { escapeHtml } from "../sanitise.js";
import { renderPage } from "./layout.js";

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Server-side absolute expiry, in UTC, without the raw ISO T/Z. client.js
// upgrades this to the reader's locale plus "in 29 days" — but with JS off the
// page still states exactly when the file dies.
function utcStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    " " +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    " UTC"
  );
}

export function viewPage(row, slug) {
  const name = escapeHtml(row.filename);
  const type = escapeHtml(row.content_type);
  const size = escapeHtml(formatSize(row.size_bytes));
  const iso = escapeHtml(row.expires_at);
  const stamp = escapeHtml(utcStamp(row.expires_at));

  const content =
    '<div class="panel">' +
    '<h2 class="file__name">' +
    name +
    "</h2>" +
    '<dl class="meta">' +
    "<dt>Size</dt><dd class=\"meta__hi\">" +
    size +
    "</dd>" +
    "<dt>Type</dt><dd>" +
    type +
    "</dd>" +
    '<dt>Expires</dt><dd class="meta__expiry" id="expires" data-expires="' +
    iso +
    '">' +
    stamp +
    "</dd>" +
    "</dl>" +
    '<a class="dl" href="/' +
    escapeHtml(slug) +
    '/d">Download<span class="dl__arrow" aria-hidden="true">&darr;</span></a>' +
    "</div>";

  return renderPage(row.filename, {
    lede: "Someone left this for you. Take it before it expires.",
    content,
    foot:
      "The type above is only a label — every download is served as an opaque " +
      "attachment, never rendered by this site.",
    script: true,
  });
}
