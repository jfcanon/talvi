// talvi hub — the constellation front door (v6.0).
//
// Design direction (frontend-design + talvi-design): the launcher is a
// CONSTELLATION. The four tiles — relay ▣, chat ▤, cinto ◈, a dim future ＋ —
// are stars connected by faint phosphor lines that LIVE with the physics
// (they stretch as the tiles drift and bounce), and the "talvi" wordmark is a
// bright pole star above. One front door = the apps are connected. The lines
// are the signature; everything else stays quiet.
//
// What changed from v4.3.2:
//   - the rigid 2×2 grid became a constellation arrangement;
//   - faint constellation lines connect the tiles (updated each frame to the
//     live physics positions) and reach up to the wordmark pole star;
//   - the floor grid and the sonar pulse rings are gone — a soft light pool
//     glows on the ground beneath the constellation instead;
//   - a quiet arrival: the tiles scale in staggered, the lines fade in
//     (instant under prefers-reduced-motion);
//   - the fog leans cool blue-violet so the night isn't flat black.
//
// Kept: the physics (drift + bounce, never phase), orbit/dolly camera,
// raycast click, hover highlight, the `>_` prompt echo, the blade.
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";

const SIDE = 2.3; // tile edge.

// --- lightweight physics ---------------------------------------------------
const BODY_R = SIDE * 0.55; // collision radius (slightly larger than the cube)
const SPRING = 1.3;
const DAMP = 0.985;
const REST = 0.35;

// The constellation: four apps + a dim future star. Positions form a
// connected pattern, spaced comfortably above 2*BODY_R so the stars rest
// apart and only collide when a gust pushes them together.
const TILE_CFG = [
  { key: "relay", glyph: "▣", href: "https://app.ygdcbtmc4u.uk/relay", x: -2.6, baseY: 5.2, z: 0.6 },
  { key: "chat", glyph: "▤", href: "https://app.ygdcbtmc4u.uk/chat", x: 2.6, baseY: 5.2, z: 0.6 },
  { key: "cinto", glyph: "◈", href: "/cinto", x: 0, baseY: 3.4, z: -0.8 },
  { key: "learn", glyph: "◆", href: "/learn", x: -2.0, baseY: 2.2, z: 1.2 },
  { key: "future", glyph: "＋", href: null, x: 0, baseY: 7.2, z: 0.2 },
];

// The pole star — the wordmark, floating above the constellation.
const WORD_POS = new THREE.Vector3(0, 9.6, 0);

// Which stars the constellation lines connect. "word" is the pole star.
const LINES = [
  ["relay", "chat"],
  ["relay", "cinto"],
  ["chat", "cinto"],
  ["cinto", "learn"],
  ["learn", "future"],
  ["future", "word"],
];

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 5.2, 0);
export const DEFAULT_RADIUS = 16;

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

export function buildWorld(scene) {

  scene.background = new THREE.Color(0x070a14);
  scene.fog = new THREE.FogExp2(0x0a0e1f, 0.024);

  // --- lights --------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0x8a6, 0.5));
  const key = new THREE.PointLight(0x7dffc4, 1.1, 42);
  key.position.set(9, 15, 14);
  scene.add(key);
  const rim = new THREE.PointLight(0xff2e88, 0.7, 42);
  rim.position.set(-9, 7, -16);
  scene.add(rim);
  const fill = new THREE.PointLight(0x22e8ff, 0.35, 30);
  fill.position.set(0, 2, -9);
  scene.add(fill);

  scene.add(makeGround());
  scene.add(makeLightPool());

  const rain = createRain(900);
  scene.add(rain.lines);

  // --- the constellation ---------------------------------------------------
  const tiles = TILE_CFG.map((cfg) => makeTile(cfg));
  const buildings = tiles.filter((t) => t.href);
  const hitMeshes = buildings.map((b) => b.hitMesh);
  for (const t of tiles) scene.add(t.group);

  // The pole star — the "talvi" wordmark as a bright star (Sprite, so it glows
  // toward the viewer like a star; it is the brand, not an app label).
  const pole = makePoleStar();
  pole.group.position.copy(WORD_POS);
  scene.add(pole.group);

  // The constellation lines, updated each frame to the live star positions.
  const lines = makeLines(tiles, pole);
  lines.update(tiles, pole); // set the initial positions (static under reduce)
  scene.add(lines.mesh);

  return {
    buildings,
    hitMeshes,
    focal: FOCAL,
    radius: DEFAULT_RADIUS,
    update(dt) {
      // Only called when motion is allowed (main.js) — under reduced motion
      // the world is static: tiles at anchors, lines drawn, everything visible.
      rain.update(dt);
      stepPhysics(tiles, dt);
      lines.update(tiles, pole);
      const t = performance.now() / 1000;
      const p = arrival(t, tiles, lines, pole);
      // The signature shimmers faintly — a slow breath on the lines.
      lines.mesh.material.opacity = (0.2 + 0.05 * Math.sin(t * 0.7)) * p;
    },
    setHighlight(b, on) {
      b.mat.emissiveIntensity = on ? 1.15 : 0.55;
      b.glow.material.opacity = on ? 0.55 : 0.3;
    },
  };
}

function makeGround() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 70),
    new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.9 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// A soft green light pool on the ground beneath the constellation — replaces
// the old floor grid (a digital default) with quiet light on the night.
function makeLightPool() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 4, 128, 128, 124);
  g.addColorStop(0, "rgba(125,255,196,0.5)");
  g.addColorStop(0.5, "rgba(125,255,196,0.16)");
  g.addColorStop(1, "rgba(125,255,196,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  return mesh;
}

// A tile = a star: a solid lit cube with the app's 2D glyph icon, a soft
// glow, physics state, and (for clickable stars) a hit volume. No labels.
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

  const iconZ = makeIcon(cfg.glyph, 1.55);
  iconZ.position.z = half + 0.02;
  group.add(iconZ);
  const iconX = iconZ.clone();
  iconX.position.set(half + 0.02, 0, 0);
  iconX.rotation.y = Math.PI / 2;
  group.add(iconX);
  const iconY = iconZ.clone();
  iconY.position.set(0, half + 0.02, 0);
  iconY.rotation.x = -Math.PI / 2;
  group.add(iconY);

  const glow = makeGlow(0x7dffc4, SIDE * 2.1, cfg.href ? 0.3 : 0.16);
  group.add(glow);

  let hit = null;
  if (cfg.href) {
    hit = new THREE.Mesh(
      new THREE.BoxGeometry(SIDE + 1, SIDE + 1, SIDE + 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    group.add(hit);
  }

  group.position.set(cfg.x, cfg.baseY, cfg.z);

  const building = {
    key: cfg.key,
    label: cfg.key,
    href: cfg.href,
    group,
    hitMesh: hit,
    worldPos: new THREE.Vector3(cfg.x, cfg.baseY, cfg.z),
    mat,
    glow,
    pos: group.position,
    vel: new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5),
    anchor: new THREE.Vector3(cfg.x, cfg.baseY, cfg.z),
    baseY: cfg.baseY,
    phase: Math.random() * Math.PI * 2,
    nextGust: 1 + Math.random() * 2,
    arriveDelay:
      cfg.key === "relay"
        ? 0
        : cfg.key === "chat"
        ? 0.18
        : cfg.key === "cinto"
        ? 0.36
        : cfg.key === "learn"
        ? 0.54
        : 0.72,
  };
  if (hit) hit.userData.building = building;
  return building;
}

// The pole star: the "talvi" wordmark drawn on a canvas, glowing as a bright
// Sprite, plus a wide halo. The brand — always reads as a star.
function makePoleStar() {
  const group = new THREE.Group();
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.font = "700 150px " + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(125,255,196,0.9)";
  ctx.shadowBlur = 60;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText("talvi", c.width / 2, c.height / 2 + 8);
  ctx.shadowBlur = 16;
  ctx.fillStyle = "#eafff5";
  ctx.fillText("talvi", c.width / 2, c.height / 2 + 8);

  const word = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  word.scale.set(5.5, 1.4, 1);
  group.add(word);

  const halo = makeGlow(0x9dffb0, 7, 0.4);
  group.add(halo);

  return { group, sprite: word };
}

// The constellation lines: faint phosphor segments connecting the stars.
// Positions are rewritten every frame so the lines stretch with the physics.
function makeLines(tiles, pole) {
  const positions = new Float32Array(LINES.length * 2 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x7dffc4,
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.LineSegments(geo, mat);

  const byKey = {};
  for (const t of tiles) byKey[t.key] = t;
  byKey.word = { pos: WORD_POS };

  function update() {
    for (let i = 0; i < LINES.length; i++) {
      const [a, b] = LINES[i];
      const A = byKey[a].pos;
      const B = byKey[b].pos;
      const o = i * 6;
      positions[o] = A.x;
      positions[o + 1] = A.y;
      positions[o + 2] = A.z;
      positions[o + 3] = B.x;
      positions[o + 4] = B.y;
      positions[o + 5] = B.z;
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { mesh, update };
}

// The arrival: the constellation assembles — stars scale in staggered, the
// pole and lines fade in. Reduced motion skips it (everything is set visible
// at build time).
function arrival(t, tiles, lines, pole) {
  for (const tile of tiles) {
    const p = Math.min(1, Math.max(0, (t - tile.arriveDelay) / 0.7));
    const s = 0.5 + 0.5 * easeOut(p);
    tile.group.scale.setScalar(s);
  }
  const p = Math.min(1, Math.max(0, t / 1.2));
  pole.group.children[0].material.opacity = 0.95 * p;
  pole.group.children[1].material.opacity = 0.4 * p;
  lines.mesh.material.opacity = 0.2 * p;
  return p;
}

function easeOut(p) {
  return 1 - Math.pow(1 - p, 3);
}

function stepPhysics(tiles, dt) {
  const t = performance.now() / 1000;
  const dtF = Math.min(dt, 0.033);

  for (const tile of tiles) {
    tile.anchor.y = tile.baseY + Math.sin(t * 0.9 + tile.phase) * 0.28;
    tile.vel.x += (tile.anchor.x - tile.pos.x) * SPRING * dtF;
    tile.vel.y += (tile.anchor.y - tile.pos.y) * SPRING * dtF;
    tile.vel.z += (tile.anchor.z - tile.pos.z) * SPRING * dtF;
    tile.vel.multiplyScalar(Math.pow(DAMP, dtF * 60));
    tile.pos.addScaledVector(tile.vel, dtF);

    if (t > tile.nextGust) {
      tile.nextGust = t + 2 + Math.random() * 3;
      tile.vel.x += (Math.random() - 0.5) * 0.45;
      tile.vel.z += (Math.random() - 0.5) * 0.45;
    }
  }

  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const A = tiles[i];
      const B = tiles[j];
      const dx = B.pos.x - A.pos.x;
      const dy = B.pos.y - A.pos.y;
      const dz = B.pos.z - A.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      const min = BODY_R * 2;
      if (dist < min && dist > 0.0001) {
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const overlap = min - dist;
        A.pos.x -= nx * overlap / 2;
        A.pos.y -= ny * overlap / 2;
        A.pos.z -= nz * overlap / 2;
        B.pos.x += nx * overlap / 2;
        B.pos.y += ny * overlap / 2;
        B.pos.z += nz * overlap / 2;
        const rel =
          (B.vel.x - A.vel.x) * nx +
          (B.vel.y - A.vel.y) * ny +
          (B.vel.z - A.vel.z) * nz;
        if (rel < 0) {
          const imp = (-(1 + REST) * rel) / 2;
          A.vel.x -= nx * imp;
          A.vel.y -= ny * imp;
          A.vel.z -= nz * imp;
          B.vel.x += nx * imp;
          B.vel.y += ny * imp;
          B.vel.z += nz * imp;
        }
      }
    }
  }

  for (const tile of tiles) {
    if (tile.pos.y < BODY_R) {
      tile.pos.y = BODY_R;
      if (tile.vel.y < 0) tile.vel.y = -tile.vel.y * REST;
    }
    tile.worldPos.copy(tile.pos);
  }
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
