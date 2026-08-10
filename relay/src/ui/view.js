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
import { PREFIX } from "../prefix.js";

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

export function viewPage(row, slug, isImage, gated) {
  const name = escapeHtml(row.filename);
  const type = escapeHtml(row.content_type);
  const size = escapeHtml(formatSize(row.size_bytes));
  const iso = escapeHtml(row.expires_at);
  const stamp = escapeHtml(utcStamp(row.expires_at));

  // Download is the only action for most files. When the object's own bytes
  // say "image" (sniffed server-side, never the declared type), a second
  // action — "as markdown" — sits beside it. Both are plain anchors; the
  // markdown route serves an attachment with the same no-render discipline as
  // /d (markdown sidequest).
  //
  // A GATED drop (Workstream E): the buttons are rendered but hidden behind a
  // PIN prompt. The client proves the gate, the server sets a short-lived
  // cookie, and the buttons are revealed. The record (name/size/type/expiry)
  // stays visible — the PIN gates the FILE BYTES, not the metadata, and the
  // copy below says exactly that (§4 discipline: state what it adds and what
  // it does not).
  const actions =
    '<div class="actions">' +
    (gated
      ? '<div class="gate">' +
        '<div class="tagline"><span class="tagline__box">pin</span></div>' +
        '<input class="chat__field" id="pin" type="password" maxlength="4" ' +
        'inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" ' +
        'placeholder="4 DIGITS" aria-label="Download PIN, 4 digits">' +
        '<button class="btn" type="button" id="unlock">UNLOCK</button>' +
        '<p class="msg hidden" id="pinmsg"></p>' +
        '<p class="chat__fineprint">This file is protected by a 4-digit PIN. ' +
        "The PIN stops a leaked link being enough on its own — but it does not " +
        "encrypt the file, and anyone with both the link and the PIN can " +
        "download. Four digits is a lock on a door, not a safe.</p>" +
        "</div>" +
        '<a class="dl hidden" href="' +
        PREFIX +
        "/" +
        escapeHtml(slug) +
        '/d">Download<span class="dl__arrow" aria-hidden="true">&darr;</span></a>' +
        (isImage
          ? '<a class="dl--alt hidden" href="' +
            PREFIX +
            "/" +
            escapeHtml(slug) +
            '/md" data-md>as markdown<span class="dl__arrow" aria-hidden="true">&darr;</span></a>'
          : "")
      : '<a class="dl" href="' +
        PREFIX +
        "/" +
        escapeHtml(slug) +
        '/d">Download<span class="dl__arrow" aria-hidden="true">&darr;</span></a>' +
        (isImage
          ? '<a class="dl--alt" href="' +
            PREFIX +
            "/" +
            escapeHtml(slug) +
            '/md" data-md>as markdown<span class="dl__arrow" aria-hidden="true">&darr;</span></a>'
          : "")) +
    "</div>";

  const content =
    '<div class="panel">' +
    '<div class="tagline"><span class="tagline__box">record</span></div>' +
    '<div class="hud">' +
    // The filename gets its own full-width row and is NOT uppercased — it is
    // the one value on this page read character by character.
    '<div class="hud__row">' +
    '<div class="hud__cell hud__cell--tag"><span class="hud__label">file</span></div>' +
    '<div class="hud__cell"><span class="hud__value hud__value--verbatim">' +
    name +
    "</span></div>" +
    "</div>" +
    '<div class="hud__row">' +
    '<div class="hud__cell"><span class="hud__label">size</span>' +
    '<span class="hud__value">' +
    size +
    "</span></div>" +
    '<div class="hud__cell"><span class="hud__label">type</span>' +
    '<span class="hud__value">' +
    type +
    "</span></div>" +
    "</div>" +
    '<div class="hud__row">' +
    '<div class="hud__cell"><span class="hud__label">expires</span>' +
    '<span class="hud__value meta__expiry" id="expires" data-expires="' +
    iso +
    '">' +
    stamp +
    "</span></div>" +
    "</div>" +
    '<div class="hud__strip" aria-hidden="true"></div>' +
    "</div>" +
    actions +
    "</div>";

  return renderPage(row.filename, {
    lede: "INCOMING. One file is being held for you. Collect it before it expires.",
    content,
    script: true,
    // A stranger with a share link came for one thing — the file. No shell,
    // no blade, nothing else to click (blueprint A2).
    shell: false,
  });
}
