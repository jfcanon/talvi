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
    'maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" ' +
    'placeholder="4 DIGITS" aria-label="Channel PIN, 4 digits, optional">' +
    '<p class="msg hidden" id="msg"></p>' +
    '<button class="btn" type="button" id="join">ENTER</button>' +
    '<p class="chat__fineprint">' +
    "Names are secrets — you know the channel, or you don't. Pick any nick; " +
    "no accounts, nothing is saved. The room dies when the last person leaves." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "A 4-digit PIN locks the door: the first person in sets it, and everyone " +
    "after needs it to get in. Leave it empty for an open channel. Nothing you " +
    "type is stored, but the same name and PIN always reopen the same door, so " +
    "a PIN stays worth guarding after the room is gone." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "When the last person leaves, the room forgets its PIN along with " +
    "everything else — and whoever walks in first after that sets the next " +
    "one. So a name is worth as much as the PIN is: share both only with " +
    "people you would let back in." +
    "</p>" +
    '<p class="chat__fineprint">' +
    "With a PIN, messages are encrypted in your browser before they leave it, " +
    "so this app never handles readable text and nothing readable crosses the " +
    "wire. Know the limit: four digits is only ten thousand combinations, so " +
    "anyone who records the traffic can try them all and read along. Treat it " +
    "as a lock on a door, not a safe. Whoever carries the traffic also sees " +
    "who talks to whom and when, anyone holding the PIN reads everything and " +
    "can post as anyone, and without a PIN there is no scrambling at all." +
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
    // Joining happens HERE, on the room page, because a shared link is the
    // normal way in. The channel name is deliberately absent from this form —
    // it is already in the URL that brought you here, and asking a person to
    // retype 20 random characters they were sent is not a form, it is a wall.
    // Hidden by default; the client reveals it only when this tab actually
    // needs something (a nick, or a PIN for a gated channel).
    '<div class="chat__join" id="joinbox" hidden>' +
    '<div class="tagline"><span class="tagline__box">nick</span></div>' +
    '<input class="chat__field" id="roomnick" type="text" maxlength="32" ' +
    'autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="NICK" aria-label="Your nick">' +
    '<div class="tagline"><span class="tagline__box">pin</span>' +
    '<span class="chat__optional">if this channel has one</span></div>' +
    '<input class="chat__field" id="roompin" type="password" maxlength="4" ' +
    'inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" ' +
    'placeholder="4 DIGITS" aria-label="Channel PIN, 4 digits, if the channel has one">' +
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
    '<noscript><p class="chat__fineprint">This needs JavaScript — the page ' +
    "is an empty frame without it.</p></noscript>";

  return renderPage("talvi — chat/" + name, {
    // No encryption claim in the lede either, for the same reason: this string
    // is rendered before anyone knows whether the room has a gate. "Nothing is
    // stored" is true of both kinds and is the part worth saying up front.
    lede:
      "IN " +
      escapeHtml(name).toUpperCase() +
      ". Nothing is stored, nothing is logged, and the room ends when the " +
      "last person leaves.",
    content,
    script: true,
  });
}
