// talvi 3d — client entry. Boots the scene once the DOM is ready. If WebGL is
// unavailable the page still works: the captions and the film overlays sit on
// the plain dark ground (blueprint Part D — no WebGL fallback is a build
// target for an MVP, but nothing collapses without it).
import { bootScene } from "../scene/main.js";

function boot() {
  if (window.WebGLRenderingContext) bootScene();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
