// Chat pages — the landing form and the room. Markup only; behaviour lives in
// src/ui/chat.js (appended to the /s.js concat).
//
// No <form> anywhere: form-action is 'none' (CSP), so a real submit would be
// blocked. The landing navigates in JS after validation — with JS off the
// page is inert, which is honest: chat needs a WebSocket, and WebSockets need
// JS. A <noscript> says so rather than pretending otherwise.
//
// Nicks travel via sessionStorage, never the URL: a room link is shared by
// word of mouth (D9), and a nick baked into the query string would be shared
// along with it. The room reads the nick the landing stored; a direct visit
// with no nick bounces to the landing to pick one.
import { renderPage } from "./layout.js";
import { escapeHtml } from "../sanitise.js";

const NICK_STORAGE = "talvi.chat.nick";

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
    '<div class="tagline"><span class="tagline__box">nick</span></div>' +
    nickInput() +
    '<p class="msg hidden" id="msg"></p>' +
    '<button class="btn" type="button" id="join">ENTER</button>' +
    '<p class="chat__fineprint">' +
    "Names are secrets — you know the channel, or you don't. Pick any nick; " +
    "no accounts, nothing is saved. The room dies when the last person leaves." +
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
    "anyone in it posts as anyone — no moderation, no way to eject.</p>" +
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
