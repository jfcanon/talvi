// talvi hub — the floating launcher (v4.3).
//
// Owner review, on top of v4.2:
//   - the glitching colour-faults are GONE — stable, quiet tiles;
//   - the cubes FLOAT in the air, gently hovering (bobbing), not piled into a
//     wall;
//   - they are now 3D ICONS in a grid — the Okta / JumpCloud application
//     launcher: a 2x2 grid of small tiles, each carrying the app's 2D icon
//     (a glyph) on its face, with a flat 2D caption below — nothing is a 3D
//     text object anymore (the v4.2 word slabs are rolled back);
//   - 60% realistic (solid lit tiles, depth haze, fog) / 40% digital (glyph
//     icons, faint grid, neon glows, pulse rings).
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas.
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";

const SIDE = 2.3; // tile edge.

// The launcher grid: three apps plus a dimmed future slot, floating at two
// heights. href null → present but not clickable (like the blade's MORE).
const TILE_CFG = [
  { key: "relay", glyph: "▣", label: "TALVI", href: "https://app.ygdcbtmc4u.uk/relay", x: -1.7, baseY: 6.3, z: 0 },
  { key: "chat", glyph: "▤", label: "CHAT", href: "https://app.ygdcbtmc4u.uk/chat", x: 1.7, baseY: 6.3, z: 0 },
  { key: "cinto", glyph: "◈", label: "CINTO", href: "https://cinto.ygdcbtmc4u.uk", x: -1.7, baseY: 4.0, z: 0 },
  { key: "future", glyph: "＋", label: "MORE", href: null, x: 1.7, baseY: 4.0, z: 0 },
];

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 5.1, 0);
export const DEFAULT_RADIUS = 14;

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.03);

  // --- lights (the "realistic" 60%: solid geometry needs light) -----------
  scene.add(new THREE.AmbientLight(0x8a6, 0.5));
  const key = new THREE.PointLight(0x7dffc4, 1.1, 42);
  key.position.set(9, 15, 14);
  scene.add(key);
  const rim = new THREE.PointLight(0xff2e88, 0.8, 42);
  rim.position.set(-9, 7, -16);
  scene.add(rim);
  const fill = new THREE.PointLight(0x22e8ff, 0.4, 30);
  fill.position.set(0, 2, -9);
  scene.add(fill);

  scene.add(makeGround());

  const rain = createRain(1000);
  scene.add(rain.lines);

  const pulse = makePulse();
  scene.add(...pulse.lines);

  // --- the launcher grid ---------------------------------------------------
  const tiles = TILE_CFG.map((cfg) => makeTile(cfg));
  const buildings = tiles.filter((t) => t.href);
  const hitMeshes = buildings.map((b) => b.hitMesh);
  for (const t of tiles) scene.add(t.group);

  return {
    buildings,
    hitMeshes,
    focal: FOCAL,
    radius: DEFAULT_RADIUS,
    update(dt) {
      rain.update(dt);
      pulse.update(dt);
      // Gentle hover: each tile bobs around its base height. Skipped under
      // prefers-reduced-motion (main.js doesn't call update then).
      const t = performance.now() / 1000;
      for (const tile of tiles) {
        tile.group.position.y = tile.baseY + Math.sin(t * 0.9 + tile.phase) * 0.28;
        tile.worldPos.copy(tile.group.position);
      }
    },
    setHighlight(b, on) {
      b.mat.emissiveIntensity = on ? 1.15 : 0.55;
      b.glow.material.opacity = on ? 0.55 : 0.3;
    },
  };
}

function makeGround() {
  const group = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 70),
    new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.9 }),
  );
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);

  // Faint grid — the digital 40%, kept subtle.
  const half = 16;
  const step = 3;
  const pts = [];
  for (let i = 0; i <= (half / step) * 2; i++) {
    const x = -half + i * step;
    pts.push(x, 0.02, -half, x, 0.02, half);
  }
  for (let i = 0; i <= (half / step) * 2; i++) {
    const z = -half + i * step;
    pts.push(-half, 0.02, z, half, 0.02, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  group.add(
    new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0x35d998,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return group;
}

// A floating tile: a solid lit cube (realistic) with the app's 2D icon on its
// front face and a flat 2D caption below (rolled back from the v4.2 word
// slabs). Stable material — no glitch, no colour faults. Only href tiles get
// a hit volume (clickable) and a hover response.
function makeTile(cfg) {
  const half = SIDE / 2;
  const group = new THREE.Group();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x0f1728,
    roughness: 0.42,
    metalness: 0.18,
    transparent: true,
    opacity: 0.96,
    emissive: 0x0a3a2c,
    emissiveIntensity: 0.55,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(SIDE, SIDE, SIDE), mat);
  group.add(body);

  // Faint wire edges — the digital line language, barely there.
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(SIDE, SIDE, SIDE)),
      new THREE.LineBasicMaterial({
        color: 0x7dffc4,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );

  // The 2D icon on the front face.
  const icon = makeIcon(cfg.glyph, 1.55);
  icon.position.z = half + 0.02;
  group.add(icon);

  // Soft glow (reads as haze around the tile).
  const glow = makeGlow(0x7dffc4, SIDE * 2.1, cfg.href ? 0.3 : 0.16);
  group.add(glow);

  // Flat 2D caption below the tile — a single texture plane, not a 3D object.
  const cap = makeLabel(cfg.label, 2.1);
  cap.position.y = -half - 0.8;
  cap.position.z = 0.05;
  group.add(cap);

  let hit = null;
  if (cfg.href) {
    hit = new THREE.Mesh(
      new THREE.BoxGeometry(SIDE + 1, SIDE + 1, SIDE + 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    group.add(hit);
  }

  group.position.set(cfg.x, cfg.baseY, cfg.z);

  const building = {
    key: cfg.key,
    label: cfg.key, // prompt echo: " open relay"
    href: cfg.href,
    group,
    hitMesh: hit,
    worldPos: new THREE.Vector3(cfg.x, cfg.baseY, cfg.z),
    mat,
    glow,
    baseY: cfg.baseY,
    phase: Math.random() * Math.PI * 2,
  };
  if (hit) hit.userData.building = building;
  return building;
}

// The atmosphere: expanding shockwave rings across the ground.
function makePulse() {
  const lines = [];
  const rings = [];
  for (let i = 0; i < 2; i++) {
    const SEG = 128;
    const pts = [];
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      pts.push(Math.cos(a), 0, Math.sin(a));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x6bffa8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.rotation.x = -Math.PI / 2;
    lines.push(line);
    rings.push({ line, mat, t: i * 1.4, period: 2.8, max: 22 });
  }

  function update(dt) {
    for (const r of rings) {
      r.t += dt;
      if (r.t > r.period) r.t = 0;
      const p = r.t / r.period;
      r.line.scale.setScalar(1 + p * (r.max - 1));
      r.mat.opacity = 0.26 * Math.sin(Math.PI * p);
    }
  }

  return { lines, update };
}

// A 2D icon: the app glyph drawn on a transparent canvas.
function makeIcon(glyph, size) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.font = "700 150px " + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(125,255,196,0.9)";
  ctx.shadowBlur = 40;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText(glyph, c.width / 2, c.height / 2 + 4);
  const mat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}

// A flat 2D caption: the app name on a single texture plane. Not a 3D object —
// no slab, no depth — and fixed facing +Z (you orbit around it).
function makeLabel(text, width) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.font = "700 64px " + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(125,255,196,0.8)";
  ctx.shadowBlur = 26;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText(text, c.width / 2, c.height / 2 + 4);
  const mat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, width * (128 / 512)), mat);
}
