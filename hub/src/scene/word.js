// talvi hub — 3D words (v4.2).
//
// The words (talvi, relay, chat, cinto) are 3D objects in the world, not
// camera-facing labels: each is drawn onto a canvas at runtime (no font file,
// no image asset) and mounted on a thin slab so it has physical depth — you
// orbit AROUND it. Static by default; intermittently it glitches — two ghost
// copies offset by a few centimetres and tinted magenta and cyan flash for
// ~120ms, the talvi glitch register applied to a solid object.
import * as THREE from "three";

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

function drawText(text) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.font = "700 150px " + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = c.width / 2;
  const cy = c.height / 2 + 8;
  ctx.shadowColor = "rgba(125,255,196,0.85)";
  ctx.shadowBlur = 55;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText(text, cx, cy);
  ctx.shadowBlur = 14;
  ctx.fillStyle = "#eafff5";
  ctx.fillText(text, cx, cy);
  return new THREE.CanvasTexture(c);
}

// A 3D word: the glowing glyphs on a thin dark slab (so it has depth and reads
// as a physical object), plus two ghost copies for the glitch.
export function makeWord(text, w, h) {
  const group = new THREE.Group();

  const tex = drawText(text);
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(base);

  const magenta = makeSplit(tex, 0xff2e88, 0.14, w, h);
  const cyan = makeSplit(tex, 0x22e8ff, -0.14, w, h);
  group.add(magenta, cyan);

  // The slab — physical thickness behind the glyphs.
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.18),
    new THREE.MeshStandardMaterial({
      color: 0x0a0d18,
      roughness: 0.6,
      transparent: true,
      opacity: 0.92,
    }),
  );
  slab.position.z = -0.14;
  group.add(slab);

  // Intermittent glitch: mostly idle, occasionally faults for ~120ms.
  let untilNext = 2 + Math.random() * 3;
  let t = 0;
  function update(dt) {
    if (t > 0) {
      t -= dt;
      if (t <= 0) {
        magenta.material.opacity = 0;
        cyan.material.opacity = 0;
      }
    } else {
      untilNext -= dt;
      if (untilNext <= 0) {
        t = 0.12;
        untilNext = 2.5 + Math.random() * 4.5;
        magenta.material.opacity = 0.85;
        cyan.material.opacity = 0.85;
      }
    }
  }

  return { group, update };
}

function makeSplit(texture, color, offsetX, w, h) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: texture,
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.position.x = offsetX;
  mesh.position.z = 0.02;
  return mesh;
}
