// The upload page — "/". Markup only; behaviour lives in src/ui/client.js.
//
// No inline style and no inline script anywhere (CSP, B.7 item 3).
// No <form>: form-action is 'none', so a real submit would be blocked. The
// send button is an ordinary button driven by XHR.
import { renderPage } from "./layout.js";

const TTLS = [
  { days: 1, label: "1 DAY" },
  { days: 7, label: "7 DAYS" },
  { days: 30, label: "30 DAYS" },
  { days: 90, label: "90 DAYS" },
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
    '<label class="drop" id="drop" for="file">' +
    '<span class="drop__hd">Drop it here</span>' +
    '<span class="drop__sub">AWAITING INPUT — or press Enter to choose a file</span>' +
    '<span class="drop__file" id="chosen"></span>' +
    '<input class="vh" type="file" id="file">' +
    "</label>" +
    '<fieldset class="ttl">' +
    '<legend class="ttl__legend">Delete after</legend>' +
    '<div class="ttl__row">' +
    ttlOptions() +
    "</div>" +
    "</fieldset>" +
    '<button class="btn" type="button" id="send" disabled>Send it</button>' +
    '<div class="prog hidden" id="prog">' +
    '<div class="prog__track"><span class="prog__fill" id="fill"></span></div>' +
    '<p class="prog__pct" id="pct">0%</p>' +
    "</div>" +
    '<p class="msg hidden" id="msg"></p>' +
    "</div>" +
    '<div class="panel hidden" id="result">' +
    '<a class="result__link" id="link" href="#"></a>' +
    '<div class="result__actions">' +
    '<button class="btn btn--ghost" type="button" id="copy">COPY LINK</button>' +
    '<span class="meta__expiry" id="expiry"></span>' +
    "</div>" +
    "</div>";

  return renderPage("talvi — drop a file", {
    lede:
      "SESSION OPEN. Drop a file, take a link. The link expires on schedule — " +
      "one day unless you say otherwise. Ceiling 25 MB.",
    content,
    script: true,
  });
}
