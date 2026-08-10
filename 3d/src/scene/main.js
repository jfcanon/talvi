// talvi 3d — scene boot (blueprint A7, A8).
//
// One fixed full-viewport renderer; DPR capped at 1.5 so phones stay cheap;
// camera driven by scroll every frame (the whole point of the page, so it
// runs even under reduced motion); autonomous motion (rain, scan, sign
// glitch) updates only when motion is allowed. A frame is still always
// rendered, so a scroll under reduced motion is not a frozen frame.
import * as THREE from "three";
import { buildWorld } from "./world.js";
import { createScrollCamera } from "./scroll.js";

export function bootScene() {
  const canvas = document.getElementById("scene");
  if (!canvas) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x05060b, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    220,
  );

  const world = buildWorld(scene);
  const scroll = createScrollCamera(camera);
  scroll.update();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", resize);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    scroll.update();
    if (!reduceMotion) world.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
