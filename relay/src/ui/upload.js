// The upload page — "/". Markup only; behaviour lives in src/ui/client.js.
//
// No inline style and no inline script anywhere (CSP, B.7 item 3).
// No <form>: form-action is 'none', so a real submit would be blocked. The
// send button is an ordinary button driven by XHR.
import { ASSET_VERSION } from "../generated/assets.js";
import { renderPage } from "./layout.js";
import { PREFIX } from "../prefix.js";

// 90 days removed 2026-08-02 at the human's request.
//
// The d90/ LIFECYCLE RULE in main.tf is deliberately left in place. TTL_DAYS
// and the lifecycle prefixes are two halves of one contract (RUNBOOK §4), and
// the danger runs in both directions: removing the rule while objects still
// carry a d90/ prefix would leave those objects with nothing to expire them —
// stored, and billed, forever. Dropping the option stops NEW 90-day uploads;
// the rule stays until the last existing one has aged out.
const TTLS = [
  { days: 1, label: "1 DAY" },
  { days: 7, label: "7 DAYS" },
  { days: 30, label: "30 DAYS" },
];

const DEFAULT_TTL = 1; // A.4 — and it must stay one of the R2 lifecycle prefixes

function ttlOptions() {
  return TTLS.map(
    ({ days, label }) =>
      '<input class="ttl__in vh" type="radio" name="ttl" id="ttl-' +
      days +
      '" value="' +
      days +
      '"' +
      (days === DEFAULT_TTL ? " checked" : "") +
      ">" +
      '<label class="ttl__opt" for="ttl-' +
      days +
      '">' +
      label +
      "</label>",
  ).join("");
}

export function uploadPage() {
  const content =
    '<div class="panel">' +
    // label + visually-hidden input: keyboard-reachable and screen-reader
    // announced without a single JS event listener involved.
    // A prompt waiting for input, nothing else. The visible label text is
    // gone; the accessible name is not — the input keeps a visually-hidden
    // <label>, so a screen reader still announces "choose a file" even though
    // sighted users see only the caret.
    '<div class="tagline"><span class="tagline__box">input</span></div>' +
    '<label class="term" id="drop" for="file">' +
    '<span aria-hidden="true">&gt;</span>' +
    '<span class="term__caret" id="caret" aria-hidden="true"></span>' +
    '<span class="term__echo" id="chosen"></span>' +
    '<span class="vh">Choose a file to upload</span>' +
    '<input class="vh" type="file" id="file">' +
    "</label>" +
    '<div class="tagline"><span class="tagline__box">retention</span></div>' +
    '<fieldset class="ttl">' +
    '<legend class="vh">Delete after</legend>' +
    '<div class="ttl__row">' +
    ttlOptions() +
    "</div>" +
    "</fieldset>" +
    // Optional download PIN (Workstream E). The browser derives H_gate from
    // this PIN and sends only the proof with the upload; the PIN itself never
    // leaves this page. Honest copy: a gate, not encryption.
    '<div class="tagline"><span class="tagline__box">pin</span>' +
    '<span class="chat__optional">optional</span></div>' +
    '<input class="chat__field" id="pin" type="password" maxlength="4" ' +
    'inputmode="numeric" pattern="[0-9]*" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" ' +
    'placeholder="4 DIGITS" aria-label="Download PIN, 4 digits, optional">' +
    '<p class="chat__fineprint">Set a PIN to gate this download. The PIN stops ' +
    "a leaked link being enough on its own — it does not encrypt the file, and " +
    "anyone with both the link and the PIN can download. Four digits is a lock " +
    "on a door, not a safe.</p>" +
    '<button class="btn" type="button" id="send" disabled>Send it</button>' +
    '<div class="prog hidden" id="prog">' +
    '<div class="prog__track"><span class="prog__fill" id="fill"></span></div>' +
    '<p class="prog__pct" id="pct">0%</p>' +
    "</div>" +
    '<p class="msg hidden" id="msg"></p>' +
    "</div>" +
    // The sound toggle sits below the machine. Decoration with a control
    // attached, so the control is a real <button> and the decoration is
    // aria-hidden. (v2: the walking pixel sprite is gone — it clashed with the
    // quiet 3D world behind the glass. The world is the figure now.)
    '<div class="ambient">' +
    '<button class="btn btn--ghost btn--quiet" type="button" id="sound" aria-pressed="false">SOUND OFF</button>' +
    "</div>" +
    // Result panel, in the same HUD frame as the view page's file record —
    // one visual language for "the machine is reporting a fact".
    '<div class="panel hidden" id="result">' +
    '<div class="hud">' +
    '<div class="hud__row">' +
    '<div class="hud__cell hud__cell--tag"><span class="hud__label">link</span></div>' +
    '<div class="hud__cell"><a class="result__link" id="link" href="#"></a></div>' +
    "</div>" +
    '<div class="hud__row">' +
    '<div class="hud__cell"><span class="hud__label">expires</span>' +
    '<span class="hud__value" id="expiry"></span></div>' +
    "</div>" +
    '<div class="hud__strip" aria-hidden="true"></div>' +
    "</div>" +
    '<div class="result__actions">' +
    '<button class="btn btn--ghost" type="button" id="copy">COPY LINK</button>' +
    '<a class="btn btn--ghost" href="https://amazed-cougar-41.accounts.dev/sign-out">SIGN OUT</a>' +
    "</div>" +
    "</div>";

  return renderPage("talvi — drop a file", {
    lede:
      "SESSION OPEN. Drop a file, take a link. The link expires on schedule — " +
      "one day unless you say otherwise. Ceiling 25 MB.",
    content,
    script: true,
    // P2: the quiet 3D world behind the machine, with the panels frosted over
    // it (the prompt12 essence — cinematic backdrop under layered UI — in
    // talvi's language).
    backdrop: true,
  });
}
