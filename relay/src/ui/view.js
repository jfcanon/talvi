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

export function viewPage(row, slug, isImage, gated, encrypted = false) {
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
  //
  // An ENCRYPTED drop (B1): the R2 object is ciphertext and the key travels in
  // the share link's #k=… fragment. The button is rendered but the client
  // intercepts it — fetch /d, decrypt in the browser, download the plaintext.
  // No "as markdown" (OCR cannot read ciphertext), no server-side sniff.
  const download =
    '<a class="dl' +
    (encrypted ? " dl--encrypted" : "") +
    (gated ? " hidden" : "") +
    '" href="' +
    PREFIX +
    "/" +
    escapeHtml(slug) +
    '/d"' +
    (encrypted ? ' data-encrypted="1"' : "") +
    ">" +
    (encrypted
      ? "Decrypt & download"
      : 'Download<span class="dl__arrow" aria-hidden="true">&darr;</span>') +
    "</a>";

  // The "as markdown" action. On a plaintext drop it is a plain link to the
  // server-side OCR (GET /md). On an ENCRYPTED drop the server cannot OCR
  // ciphertext, so the client decrypts and POSTs the image (data-encrypted-md
  // tells client.js to intercept); the copy below says honestly that this one
  // action sends the decrypted image to the server, processed but never stored.
  const markdown =
    (isImage && !encrypted) || encrypted
      ? '<a class="dl--alt' +
        (gated ? " hidden" : "") +
        '" href="' +
        PREFIX +
        "/" +
        escapeHtml(slug) +
        '/md"' +
        (encrypted ? ' data-encrypted-md="1"' : "") +
        ' data-md>as markdown<span class="dl__arrow" aria-hidden="true">&darr;</span></a>'
      : "";

  const actions =
    '<div class="actions" data-encrypted="' +
    (encrypted ? "1" : "0") +
    '">' +
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
        "</div>"
      : "") +
    download +
    markdown +
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
    (encrypted
      ? '<p class="chat__fineprint">This file was encrypted before upload — the ' +
        "server holds ciphertext and cannot read it. The key rides in this " +
        "link's #k= fragment, which never reaches the server. It is the strongest " +
        "protection this site offers, and it protects only what it says: anyone " +
        "with this full link (fragment included) can decrypt and download. " +
        "OCR is the one exception: 'as markdown' decrypts the image in this " +
        "browser and sends it to the server for conversion — it is processed, " +
        "never stored.</p>" +
        '<p class="msg hidden" id="encmsg"></p>'
      : "") +
    "</div>";

  return renderPage(row.filename, {
    lede: "INCOMING. One file is being held for you. Collect it before it expires.",
    content,
    script: true,
    // A stranger with a share link came for one thing — the file. No shell,
    // no blade, nothing else to click (blueprint A2).
    shell: false,
    // P2: the quiet world still sits behind the single-purpose instrument.
    backdrop: true,
  });
}
