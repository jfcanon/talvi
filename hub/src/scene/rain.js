// talvi 3d — rain (blueprint A8, and the diagonal rain of talvi's style.css).
//
// A field of short cyan line segments falling along a slightly diagonal
// velocity vector, recycled to the top when they pass the floor. World-space
// so the camera can fly through it; the count is scaled to the viewport so a
// phone does not pay desktop's bill (A8).
//
// Autonomous motion, so the whole update is skipped under prefers-reduced-
// motion — the drops freeze where they are, which is the one permitted
// "static texture" reading (talvi's reduced-motion rule).
import * as THREE from "three";

const RANGE_X = 46;
const FLOOR = -3;
const CEIL = 17;
const RANGE_Z_MIN = 12;
const RANGE_Z_MAX = -74;
const STREAK = 0.55;
const SPEED = 6.5;

const DIR = new THREE.Vector3(0.32, -1, 0.2).normalize();

export function createRain(baseCount) {
  const area = window.innerWidth * window.innerHeight;
  const count = Math.max(300, Math.min(baseCount, Math.round(baseCount * Math.min(1, area / (1920 * 1080)) + 300)));

  const drops = [];
  for (let i = 0; i < count; i++) drops.push(randDrop());

  const positions = new Float32Array(count * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x22e8ff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);

  function randDrop() {
    return {
      x: (Math.random() * 2 - 1) * RANGE_X,
      y: FLOOR + Math.random() * (CEIL - FLOOR),
      z: RANGE_Z_MIN + Math.random() * (RANGE_Z_MAX - RANGE_Z_MIN),
    };
  }

  function writeDrop(i, d) {
    const o = i * 6;
    positions[o] = d.x;
    positions[o + 1] = d.y;
    positions[o + 2] = d.z;
    positions[o + 3] = d.x + DIR.x * STREAK;
    positions[o + 4] = d.y + DIR.y * STREAK;
    positions[o + 5] = d.z + DIR.z * STREAK;
  }

  for (let i = 0; i < count; i++) writeDrop(i, drops[i]);

  function update(dt) {
    for (let i = 0; i < count; i++) {
      const d = drops[i];
      d.x += DIR.x * SPEED * dt;
      d.y += DIR.y * SPEED * dt;
      d.z += DIR.z * SPEED * dt;
      if (d.y < FLOOR) {
        const n = randDrop();
        d.x = n.x;
        d.y = CEIL;
        d.z = n.z;
      }
      writeDrop(i, d);
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { lines, update };
}
