// talvi hub — node labels (v4, idea #1: the buildings ARE the apps).
//
// Each building has a real <a class="node" data-key=…> in the HTML. Every
// frame we project the building's world position to screen and park the label
// there, so the anchor floats over its building as the camera moves. Hidden
// (is-off) when the building is behind the camera. The labels are genuine
// anchors — keyboard-reachable, focusable, and the guaranteed navigation path
// even before WebGL or when a raycast misses.
import * as THREE from "three";

const v = new THREE.Vector3();

export function updateLabels(camera, buildings) {
  for (const b of buildings) {
    const el = document.querySelector('.node[data-key="' + b.key + '"]');
    if (!el) continue;
    v.copy(b.worldPos).project(camera);
    if (v.z > 1) {
      // Behind the camera — drop it.
      el.classList.remove("is-on");
      el.classList.add("is-off");
      continue;
    }
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    el.style.transform =
      "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%, -50%)";
    el.classList.remove("is-off");
    el.classList.add("is-on");
  }
}
