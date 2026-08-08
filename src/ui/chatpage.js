// Chat pages — the landing form and the room. Markup only; behaviour lives in
// src/ui/chat.js and src/ui/chatcrypto.js (both appended to the /s.js concat).
//
// No <form> anywhere: form-action is 'none' (CSP), so a real submit would be
// blocked. The landing navigates in JS after validation — with JS off the
// page is inert, which is honest: chat needs a WebSocket, and WebSockets need
// JS. A <noscript> says so rather than pretending otherwise.
//
// Nicks and PINs never travel in the URL. A room link is shared by word of
// mouth (D9) and anything in the query string is shared along with it — which
// for a PIN would hand away the only secret the channel has. The landing puts
// the nick, and the key DERIVED from the PIN, in sessionStorage; the room
// reads them there. A direct visit with neither bounces back here.
//
// Wording rule for this file: PR3 gates entry, it does NOT encrypt. Message
// bodies are still relayed in plaintext (D10) and the copy below says so
// plainly. The E2E disclosures (D13) land with PR4, when they become true.
import { renderPage } from "./layout.js";
import { escapeHtml } from "../sanitise.js";

function nickInput() {
  return (
    '<input class="chat__field chat__nick" id="nick" type="text" ' +
    'maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="NICK" aria-label="Your nick">'
  );
}

export function chatLandingPage() {
  const content =
    '<div class="panel chat">' +
    '<div class="tagline"><span class="tagline__box">channel</span></div>' +
    '<input class="chat__field" id="channel" type="text" ' +
    'maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="NAME" aria-label="Channel name">' +
    '<button class="btn btn--ghost" type="button" id="create">NEW NAME</button>' +
    '<div class="tagline"><span class="tagline__box">nick</span></div>' +
    nickInput() +
    '<div class="tagline"><span class="tagline__box">pin</span>' +
    '<span class="chat__optional">optional</span></div>' +
    '<input class="chat__field" id="pin" type="password" ' +
    'maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="PIN" aria-label="Channel PIN, optional">' +
    '<p class="msg hidden" id="msg"></p>' +
    '<button class="btn" type="button" id="join">ENTER</button>' +
    '<p class="chat__fineprint">' +
    "Names are secrets — you know the channel, or you don't. Pick any nick; " +
    "no accounts, nothing is saved. The room dies when the last person leaves." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "A PIN locks the door: the first person in sets it, and everyone after " +
    "needs it to get in. Leave it empty for an open channel. The PIN is the " +
    "channel's only secret — make it strong, and use a different one per " +
    "channel. Nothing you type is stored, but the same name and PIN always " +
    "reopen the same door, so a PIN stays worth guarding after the room is " +
    "gone." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "When the last person leaves, the room forgets its PIN along with " +
    "everything else — and whoever walks in first after that sets the next " +
    "one. So a name is worth as much as the PIN is: share both only with " +
    "people you would let back in." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "The PIN controls who gets in. It does not yet scramble what you type — " +
    "messages cross the wire readable by whatever carries them." +
    "</p>" +
    "</div>" +
    '<noscript><p class="chat__fineprint">This needs JavaScript — the page ' +
    "is an empty frame without it.</p></noscript>";

  return renderPage("talvi — chat", {
    lede:
      "CHANNEL. Name it, nick yourself, walk in. Ephemeral by design — no " +
      "log, no history, gone when the room empties.",
    content,
    script: true,
  });
}

export function chatRoomPage(name) {
  const content =
    '<div class="panel chat">' +
    '<div class="tagline"><span class="tagline__box">channel</span>' +
    '<span class="chat__channel">' +
    escapeHtml(name) +
    "</span></div>" +
    '<ol class="chat__msgs" id="msgs" aria-live="polite"></ol>' +
    '<p class="msg hidden" id="msg"></p>' +
    '<div class="chat__form">' +
    '<input class="chat__field chat__input" id="text" type="text" ' +
    'maxlength="1000" autocomplete="off" aria-label="Message">' +
    '<button class="btn" type="button" id="send" disabled>SEND</button>' +
    "</div>" +
    '<p class="chat__fineprint">Nobody reads this but the room. Still: ' +
    "anyone in it posts as anyone — no moderation, no way to eject. Messages " +
    "are relayed as you typed them, not scrambled; a PIN decides who gets in, " +
    "not what the wire can see.</p>" +
    "</div>" +
    '<noscript><p class="chat__fineprint">This needs JavaScript — the page ' +
    "is an empty frame without it.</p></noscript>";

  return renderPage("talvi — chat/" + name, {
    lede:
      "IN " +
      escapeHtml(name).toUpperCase() +
      ". Plaintext relay — what you type, they read. Nothing is stored.",
    content,
    script: true,
  });
}
