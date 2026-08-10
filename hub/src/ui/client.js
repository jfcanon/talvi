// talvi hub — boots the 3D world and drives the blade (blueprint A2/A5).
//
// This file is the client entry and IS bundled by scripts/build-assets.mjs
// (esbuild: three.js + the scene modules + this file → the /h.js payload), so
// unlike the old raw-concatenated client it can use imports and an ES module
// graph. It owns its own DOMContentLoaded hook.
//
// Two jobs:
//   1. Boot the world if WebGL exists (the page still works without it: the
//      captions and the film overlays sit on the plain dark ground).
//   2. The blade: a class toggle on .blade (is-open) driven by a real
//      <button>. No inline handlers anywhere (CSP: script-src 'self' — which
//      is WHY the toggle is a button + addEventListener, not an onclick
//      attribute). The retract state is remembered in localStorage so the rail
//      stays the way the visitor left it.
import { bootScene } from "../scene/main.js";

(function () {
  "use strict";

  function bootWorld() {
    if (window.WebGLRenderingContext) bootScene();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWorld);
  } else {
    bootWorld();
  }

  const STORAGE_KEY = "talvi.hub.blade";
  const BLADE = document.querySelector(".blade");
  const TOGGLE = document.querySelector(".blade__toggle");

  if (!BLADE || !TOGGLE) return;

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
  if (restored) BLADE.classList.add("is-open");
  refreshToggle(restored);

  TOGGLE.addEventListener("click", function () {
    const open = BLADE.classList.toggle("is-open");
    refreshToggle(open);
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the toggle still works this page.
    }
  });
})();
