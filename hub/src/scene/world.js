// talvi hub — the 3D world behind the front door (blueprint A1/A5).
//
// Near-black ground, phosphor-green line-and-glow, fog, and the instrument
// language translated into wireframe geometry:
//   - ground grid            LineSegments, additive, receding into fog
//   - rain                   diagonal streaks (rain.js)
//   - scan band              a soft additive plane sweeping down the ground
//   - instrument panels      one per app (relay, chat, cinto) — wireframe
//                            boxes with corner brackets, divider cells and a
//                            marked strip, plus a glow centre. The app's
//                            identity lives in the HTML control plate, not the
//                            geometry, so the 3D stays atmosphere.
//   - light posts            thin vertical lines off the axis for parallax
//   - the sign               the wordmark sprite (sign.js)
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas, so the
// worn-film register reads exactly as it does on talvi's page today (A5c).
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";
import { createSign } from "./sign.js";

// One panel per app, spaced along the camera path (scroll.js section order).
const INSTRUMENTS = [
  { z: -16 }, // RELAY
  { z: -34 }, // CHAT
  { z: -52 }, // CINTO
];

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.026);

  scene.add(makeGrid());
  scene.add(makePosts());

  const rain = createRain(1500);
  scene.add(rain.lines);

  const scan = makeScan();
  scene.add(scan.mesh);

  for (const inst of INSTRUMENTS) {
    const panel = makePanel(11, 6, 2);
    panel.group.position.set(0, 3.4, inst.z);
    scene.add(panel.group);
  }

  const sign = createSign();
  sign.group.position.set(0, 3.4, 0);
  scene.add(sign.group);

  return {
    update(dt) {
      rain.update(dt);
      scan.update(dt);
      sign.update(dt);
    },
  };
}

function makeGrid() {
  const half = 70;
  const step = 4;
  const pts = [];
  for (let i = 0; i <= half / step * 2; i++) {
    const x = -half + i * step;
    pts.push(x, 0, -half, x, 0, half);
  }
  for (let i = 0; i <= half / step * 2; i++) {
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
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

// Off-axis vertical posts so the camera's forward travel has parallax to read.
function makePosts() {
  const spots = [
    [-20, -8, 5],
    [18, -20, 7],
    [-15, -30, 4],
    [22, -38, 8],
    [-18, -50, 5],
    [14, -58, 6],
    [-26, -16, 4],
  ];
  const pts = [];
  for (const [x, z, h] of spots) pts.push(x, 0, z, x, h, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const seg = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0x35d998,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const group = new THREE.Group();
  group.add(seg);
  for (const [x, , z] of spots) {
    const glow = makeGlow(0x35d998, 1.5, 0.5);
    glow.position.set(x, 1.2, z);
    group.add(glow);
  }
  return group;
}

function makeScan() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(170, 9),
    new THREE.MeshBasicMaterial({
      color: 0x6bffa8,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 15;
  const top = 15;
  const bottom = -4;
  const speed = 2.6;

  function update(dt) {
    mesh.position.y -= speed * dt;
    if (mesh.position.y < bottom) mesh.position.y = top;
  }

  return { mesh, update };
}

// The instrument panel: outer box, back face, corner connectors and brackets,
// divider cells, and a marked strip of ticks along the bottom — the talvi HUD
// translated to wireframe. One geometry, one material.
function makePanel(w, h, depth) {
  const hw = w / 2;
  const hh = h / 2;
  const lines = [];

  function rect(z) {
    lines.push(-hw, -hh, z, hw, -hh, z);
    lines.push(hw, -hh, z, hw, hh, z);
    lines.push(hw, hh, z, -hw, hh, z);
    lines.push(-hw, hh, z, -hw, -hh, z);
  }
  rect(0);
  rect(depth);

  for (const [sx, sy] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
    lines.push(sx * hw, sy * hh, 0, sx * hw, sy * hh, depth);
    const b = 0.9;
    lines.push(sx * hw, sy * hh, 0, sx * hw - sx * b, sy * hh, 0);
    lines.push(sx * hw, sy * hh, 0, sx * hw, sy * hh - sy * b, 0);
  }

  const cells = 3;
  for (let i = 1; i <= cells; i++) {
    const y = -hh + (h / (cells + 1)) * i;
    lines.push(-hw, y, 0, hw, y, 0);
  }
  lines.push(0, -hh, 0, 0, hh, 0);

  const ticks = 14;
  for (let i = 0; i < ticks; i++) {
    const x = -hw + (w / ticks) * i + w / (ticks * 2);
    lines.push(x, -hh - 0.35, 0, x, -hh + 0.3, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  const seg = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0x7dffc4,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  const group = new THREE.Group();
  group.add(seg);
  const glow = makeGlow(0x7dffc4, 7, 0.26);
  glow.position.set(0, 0, depth + 0.6);
  group.add(glow);

  return { group };
}
