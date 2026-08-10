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

  // Restore: default collapsed. A saved "open" only applies when the visitor
  // explicitly opened it — absence of the key is not "open".
  if (localStorage.getItem(STORAGE_KEY) === "open") {
    HUB.classList.add("is-open");
    TOGGLE.setAttribute("aria-pressed", "true");
  }

  TOGGLE.addEventListener("click", function () {
    const open = HUB.classList.toggle("is-open");
    TOGGLE.setAttribute("aria-pressed", String(open));
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the toggle still works this page.
    }
  });
})();
