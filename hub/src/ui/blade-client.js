// talvi shared shell — blade retraction (A1, extended).
// COPIED byte-identical into hub/src/ui, relay/src/ui, chat/src/ui client.js
// (as a self-contained IIFE, concatenated — no module loader, no export).
//
// The blade is a class toggle on .shell (is-open) driven by a real <button>.
// No inline handlers anywhere (CSP: script-src 'self' — which is WHY the
// toggle is a button + addEventListener, not an onclick attribute). The
// retract state is remembered in localStorage under ONE key shared by every
// app, so the rail stays the way the visitor left it as they switch apps.
(function () {
  "use strict";

  const STORAGE_KEY = "talvi.shell.blade";
  const SHELL = document.querySelector(".shell");
  const TOGGLE = document.querySelector(".blade__toggle");

  if (!SHELL || !TOGGLE) return;

  // The toggle is an icon: the glyph says what the NEXT click does (» =
  // expand, « = collapse), and the aria-label says it in words for assistive
  // tech. On mobile the toggle is hidden by CSS and this is moot, but the
  // state must still be right if it is ever shown.
  function refreshToggle(open) {
    TOGGLE.textContent = open ? "«" : "»";
    TOGGLE.setAttribute("aria-label", open ? "collapse rail" : "expand rail");
    TOGGLE.setAttribute("aria-pressed", String(open));
  }

  // Restore: default collapsed. A saved "open" only applies when the visitor
  // explicitly opened it — absence of the key is not "open".
  const restored = localStorage.getItem(STORAGE_KEY) === "open";
  if (restored) SHELL.classList.add("is-open");
  refreshToggle(restored);

  TOGGLE.addEventListener("click", function () {
    const open = SHELL.classList.toggle("is-open");
    refreshToggle(open);
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the toggle still works this page.
    }
  });
})();
