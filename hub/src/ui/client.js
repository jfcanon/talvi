// talvi hub — blade retraction (A1).
//
// Self-booting plain script, not an ES module: /h.js is a raw file
// concatenated by scripts/build-assets.mjs (no module loader), so no `export`
// and no shared globals — this file owns its own DOMContentLoaded hook, the
// same pattern green's client.js and ambient.js use.
//
// The blade is a class toggle on .hub (is-open) driven by a real <button>.
// No inline handlers anywhere (CSP: script-src 'self' — which is WHY the
// toggle is a button + addEventListener, not an onclick attribute). The
// retract state is remembered in localStorage so the rail stays the way the
// visitor left it.
(function () {
  "use strict";

  const STORAGE_KEY = "talvi.hub.blade";
  const HUB = document.querySelector(".hub");
  const TOGGLE = document.querySelector(".blade__toggle");

  if (!HUB || !TOGGLE) return;

  // The toggle's label says what the NEXT click does, so a closed rail reads
  // "expand" and an open one "retract". On mobile the toggle is hidden by CSS
  // and this is moot, but the text must still be right if it is ever shown.
  function refreshToggle(open) {
    TOGGLE.textContent = open ? "retract" : "expand";
    TOGGLE.setAttribute("aria-pressed", String(open));
  }

  // Restore: default collapsed. A saved "open" only applies when the visitor
  // explicitly opened it — absence of the key is not "open".
  const restored = localStorage.getItem(STORAGE_KEY) === "open";
  if (restored) HUB.classList.add("is-open");
  refreshToggle(restored);

  TOGGLE.addEventListener("click", function () {
    const open = HUB.classList.toggle("is-open");
    refreshToggle(open);
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the toggle still works this page.
    }
  });
})();
