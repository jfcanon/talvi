// talvi chat — the quiet backdrop (same as relay's, so /chat reads like
// /talvi). A still, faint 3D world behind the chat pages — the prompt12
// essence (cinematic atmosphere under layered UI) done in talvi's language:
// no photo, no fonts, no external assets, just fog, a dim grid, a few dim
// instrument panels off-axis, and very faint slow rain. Quiet by design:
//   - opacities are low so the transcript stays the star,
//   - under prefers-reduced-motion it renders ONE static frame,
//   - DPR is capped at 1.25 — it is a background, not a showcase.
//
// Self-booting: bundled by scripts/build-assets.mjs into an IIFE (three.js
// included) and appended to /s.js, but it only boots on pages that carry the
// <canvas id="backdrop"> element (the upload and view pages) — every other
// page pays nothing beyond the download.
import * as THREE from "three";

(function () {
  "use strict";

  const canvas = document.getElementById("backdrop");
  if (!canvas || !window.WebGLRenderingContext) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x05060b, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.018);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    160,
  );
  // A fixed establishing shot: slightly high, looking down the world. The
  // backdrop does NOT move with scroll — it is atmosphere, not narrative.
  camera.position.set(0, 6.5, 16);
  camera.lookAt(0, 2, -28);

  scene.add(makeGrid());
  scene.add(makePanels());
  const rain = makeRain(350);
  scene.add(rain.lines);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (reduce) renderer.render(scene, camera);
  }
  window.addEventListener("resize", resize);

  if (reduce) {
    // One static frame, no animation loop. resize() re-renders on rotation.
    renderer.render(scene, camera);
    return;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    rain.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

function makeGrid() {
  const half = 50;
  const step = 5;
  const pts = [];
  for (let i = 0; i <= (half / step) * 2; i++) {
    const x = -half + i * step;
    pts.push(x, 0, -half, x, 0, half);
  }
  for (let i = 0; i <= (half / step) * 2; i++) {
    const z = -half + i * step;
    pts.push(-half, 0, z, half, 0, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0x35d998,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

// Dim instrument panels off the axis — enough depth to read, dim enough to
// stay out of the way. Same wireframe language as the hub world.
function makePanels() {
  const group = new THREE.Group();
  const spots = [
    [-7, 4.5, -18, 8, 5],
    [8, 3.5, -30, 6, 4],
    [-5, 5, -44, 7, 4.5],
  ];
  for (const [x, y, z, w, h] of spots) {
    const panel = makePanel(w, h, 1);
    panel.position.set(x, y, z);
    group.add(panel);
  }
  return group;
}

function makePanel(w, h, depth) {
  const hw = w / 2;
  const hh = h / 2;
  const lines = [];
  function rect(zz) {
    lines.push(-hw, -hh, zz, hw, -hh, zz);
    lines.push(hw, -hh, zz, hw, hh, zz);
    lines.push(hw, hh, zz, -hw, hh, zz);
    lines.push(-hw, hh, zz, -hw, -hh, zz);
  }
  rect(0);
  rect(depth);
  for (const [sx, sy] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
    lines.push(sx * hw, sy * hh, 0, sx * hw, sy * hh, depth);
    const b = 0.6;
    lines.push(sx * hw, sy * hh, 0, sx * hw - sx * b, sy * hh, 0);
    lines.push(sx * hw, sy * hh, 0, sx * hw, sy * hh - sy * b, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  return new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0x7dffc4,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function makeRain(count) {
  const FLOOR = -3;
  const CEIL = 16;
  const drops = [];
  for (let i = 0; i < count; i++) {
    drops.push({
      x: (Math.random() * 2 - 1) * 40,
      y: FLOOR + Math.random() * (CEIL - FLOOR),
      z: 10 + Math.random() * -70,
    });
  }
  const positions = new Float32Array(count * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x7dffc4,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  const STREAK = 0.4;
  const SPEED = 4.5;

  function writeDrop(i, d) {
    const o = i * 6;
    positions[o] = d.x;
    positions[o + 1] = d.y;
    positions[o + 2] = d.z;
    positions[o + 3] = d.x;
    positions[o + 4] = d.y - STREAK;
    positions[o + 5] = d.z + STREAK * 0.35;
  }
  drops.forEach(writeDrop);

  function update(dt) {
    for (let i = 0; i < count; i++) {
      const d = drops[i];
      d.y -= SPEED * dt;
      d.z += SPEED * dt * 0.35;
      if (d.y < FLOOR) {
        d.y = CEIL;
        d.x = (Math.random() * 2 - 1) * 40;
        d.z = 10 + Math.random() * -70;
      }
      writeDrop(i, d);
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { lines, update };
}
