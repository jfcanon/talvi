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
// for a PIN would hand away the only secret the channel has. Both the landing
// and the room form put the nick, and the key DERIVED from the PIN, in
// sessionStorage. A direct visit asks for them IN THE ROOM (PR9) rather than
// bouncing to the landing, because a shared link is the normal way in and the
// channel name is already in the URL.
//
// Wording rule for this file: say what is true of the CURRENT build and no
// more. Gated channels are end-to-end encrypted (PR4), open ones are plaintext
// (D10), and the PIN is 4 digits — which is a real limit on what encryption
// can promise here, so the copy states it instead of implying a safe. D13: an
// accurate claim beats a flattering one.
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
    '<div class="chat__layout">' +
    // This browser's channels (names only — the PIN is never stored, and
    // reopening a gated room means typing the PIN you know into the room).
    '<aside class="chat__side" id="side" hidden>' +
    '<div class="tagline"><span class="tagline__box">channels</span></div>' +
    '<ul class="chat__channels" id="sidelist"></ul>' +
    "</aside>" +
    '<div class="chat__main">' +
    '<div class="panel chat">' +
    '<div class="tagline"><span class="tagline__box">channel</span></div>' +
    '<input class="chat__field" id="channel" type="text" ' +
    'maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="NAME" aria-label="Channel name">' +
    '<div class="tagline"><span class="tagline__box">nick</span></div>' +
    nickInput() +
    '<div class="tagline"><span class="tagline__box">pin</span>' +
    '<span class="chat__optional">optional</span></div>' +
    '<input class="chat__field" id="pin" type="password" ' +
    'maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" ' +
    'placeholder="4 DIGITS" aria-label="Channel PIN, 4 digits, optional">' +
    '<p class="msg hidden" id="msg"></p>' +
    '<button class="btn" type="button" id="join">ENTER</button>' +
    '<p class="chat__fineprint">Names are secrets — pick one, nick yourself, and ' +
    "walk in. The room dies 24 hours after the last message, or when the last " +
    "person disconnects — whichever comes first.</p>" +
    '<p class="chat__fineprint">A 4-digit PIN locks the door: the first person ' +
    "in sets it, and everyone after needs it to get in. Leave it empty for an " +
    "open channel. With a PIN, messages are encrypted in your browser before " +
    "they leave it, so nothing readable ever sits on the server. The PIN locks " +
    "the door, not the safe — anyone who holds it can read and post as anyone.</p>" +
    "</div>" +
    "</div>" +
    "</div>" +
    '<noscript><p class="chat__fineprint">This needs JavaScript — the page ' +
    "is an empty frame without it.</p></noscript>";

  return renderPage("chat", {
    lede:
      "CHANNEL. Name it, nick yourself, walk in. The room lives 24 hours " +
      "after the last message — then everything is gone.",
    content,
    script: true,
    // The quiet 3D world behind the panel, like /talvi.
    backdrop: true,
  });
}

export function chatRoomPage(name) {
  const content =
    '<div class="chat__layout">' +
    // This browser's channels, beside the conversation — one click jumps.
    '<aside class="chat__side" id="side" hidden>' +
    '<div class="tagline"><span class="tagline__box">channels</span></div>' +
    '<ul class="chat__channels" id="sidelist"></ul>' +
    "</aside>" +
    '<div class="chat__main">' +
    '<div class="panel chat">' +
    '<div class="tagline"><span class="tagline__box">channel</span>' +
    '<span class="chat__channel">' +
    escapeHtml(name) +
    "</span></div>" +
    // Joining happens HERE, on the room page, because a shared link is the
    // normal way in. The channel name is deliberately absent from this form —
    // it is already in the URL that brought you here, and asking a person to
    // retype 20 random characters they were sent is not a form, it is a wall.
    // Hidden by default; the client reveals it only when this tab actually
    // needs something (a nick, or a PIN for a gated channel).
    //
    // The PIN is user knowledge, never stored: you type the PIN you know into
    // the field, then ENTER or the reconnect (↻) icon beside it joins. The ↻
    // is the same join — it is the affordance the owner asked for when
    // reopening a channel from the sidebar.
    '<div class="chat__join" id="joinbox" hidden>' +
    '<div class="tagline"><span class="tagline__box">nick</span></div>' +
    '<input class="chat__field" id="roomnick" type="text" maxlength="32" ' +
    'autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="NICK" aria-label="Your nick">' +
    '<div class="tagline"><span class="tagline__box">pin</span>' +
    '<span class="chat__optional">if this channel has one</span></div>' +
    '<div class="chat__pinslot">' +
    '<input class="chat__field chat__pin" id="roompin" type="password" maxlength="4" ' +
    'inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" ' +
    'placeholder="4 DIGITS" aria-label="Channel PIN, 4 digits, if the channel has one">' +
    '<button class="chat__reconnect" id="roomreconnect" type="button" ' +
    'aria-label="Reconnect with this PIN">↻</button>' +
    "</div>" +
    '<button class="btn" type="button" id="roomjoin">ENTER</button>' +
    "</div>" +
    '<p class="chat__members" id="members" aria-live="polite"></p>' +
    '<ol class="chat__msgs" id="msgs" aria-live="polite"></ol>' +
    '<p class="msg hidden" id="msg"></p>' +
    '<div class="chat__form">' +
    '<input class="chat__field chat__input" id="text" type="text" ' +
    'maxlength="1000" autocomplete="off" aria-label="Message">' +
    '<button class="btn" type="button" id="send" disabled>SEND</button>' +
    "</div>" +
    // Hidden until a socket actually drops. Reconnecting is a button and not a
    // timer on purpose: an automatic retry against a gated channel spends a
    // lockout attempt each time (D8).
    '<button class="btn btn--ghost" type="button" id="reconnect" hidden>RECONNECT</button>' +
    // DISCONNECT (owner 2026-08-10) — the explicit leave. A dropped socket is
    // not a leave (presence model); this button is the only way to end your
    // presence, and if you were the last one, the room ends now.
    '<button class="btn btn--ghost btn--danger" type="button" id="disconnect">DISCONNECT</button>' +
    // Whether this channel is encrypted is a property of the live object, not
    // of the URL — the Worker rendering this page does not know it, and asking
    // the object would both cost a round trip and turn page load into an
    // oracle for which channels are gated. So the page ships without a claim
    // and the client fills one in once the handshake has actually told it
    // which kind of room this is. A wrong claim here is worse than a late one.
    '<p class="chat__fineprint" id="mode">Connecting…</p>' +
    '<p class="chat__fineprint">Anyone in the room posts as anyone — no ' +
    "moderation, no way to eject, and no way to prove who wrote a line.</p>" +
    "</div>" +
    "</div>" +
    "</div>" +
    '<noscript><p class="chat__fineprint">This needs JavaScript — the page ' +
    "is an empty frame without it.</p></noscript>";

  return renderPage("chat/" + name, {
    // No encryption claim in the lede either, for the same reason: this string
    // is rendered before anyone knows whether the room has a gate.
    lede:
      "IN " +
      escapeHtml(name).toUpperCase() +
      ". The room lives 24 hours after the last message, then everything is " +
      "gone — or ends when the last person disconnects.",
    content,
    script: true,
    // The quiet 3D world behind the panel, like /talvi.
    backdrop: true,
  });
}
