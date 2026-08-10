// talvi hub — the smaller, more realistic world (v4.2).
//
// Revisions from owner review, on top of v4.1:
//   - the world is SMALLER — the camera sits close, the grid recedes sooner,
//     the fog is denser, everything feels intimate rather than epic;
//   - the apps are PERFECT CUBES — solid, lit, semi-transparent and hazy
//     (glow + fog read as blur), each occasionally GLITCHING — piled up into
//     a wall: three apps on the bottom row, decorative cubes stacked above;
//   - the words (talvi, relay, chat, cinto) are 3D OBJECTS — static words on
//     physical slabs, intermittent glitch — never camera-facing;
//   - the mix is 60% realistic (solid geometry, lights, depth haze) and 40%
//     digital (neon glow accents, faint grid, pulse rings, the glitches).
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas.
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";
import { makeWord } from "./word.js";

const SIDE = 3.4; // perfect cube edge.

// The wall: three apps on the bottom row, decorative cubes stacked above.
const APP_CFG = [
  { key: "relay", word: "relay", href: "https://app.ygdcbtmc4u.uk/relay", pos: [-3.9, 1.7, 0] },
  { key: "chat", word: "chat", href: "https://app.ygdcbtmc4u.uk/chat", pos: [0, 1.7, 0] },
  { key: "cinto", word: "cinto", href: "https://cinto.ygdcbtmc4u.uk", pos: [3.9, 1.7, 0] },
];

// Decorative cubes that fill the wall — not clickable, no labels.
const DECO = [
  { pos: [-1.95, 5.1, 0.25] },
  { pos: [1.95, 5.1, -0.25] },
  { pos: [0, 8.5, 0.15] },
];

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 3.6, 0);
export const DEFAULT_RADIUS = 15;

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.032);

  // --- lights (the "realistic" 60%: solid geometry needs light) -----------
  scene.add(new THREE.AmbientLight(0x8a6, 0.5));
  const key = new THREE.PointLight(0x7dffc4, 1.1, 42);
  key.position.set(9, 15, 14);
  scene.add(key);
  const rim = new THREE.PointLight(0xff2e88, 0.9, 42);
  rim.position.set(-9, 7, -16);
  scene.add(rim);
  const fill = new THREE.PointLight(0x22e8ff, 0.4, 30);
  fill.position.set(0, 2, -9);
  scene.add(fill);

  // --- ground: a solid dark plane + a faint digital grid ------------------
  scene.add(makeGround());

  const rain = createRain(1100);
  scene.add(rain.lines);

  const pulse = makePulse();
  scene.add(...pulse.lines);

  // --- the wall of cubes --------------------------------------------------
  const buildings = APP_CFG.map((cfg) => makeWallCube(cfg));
  const hitMeshes = [];
  for (const b of buildings) {
    scene.add(b.group);
    hitMeshes.push(b.hitMesh);
  }
  for (const d of DECO) {
    scene.add(makeDecoCube(d.pos));
  }

  // The wordmark above the wall — a big 3D word.
  const wordmark = makeWord("talvi", 7, 2.2);
  wordmark.group.position.set(0, 11.2, 0.6);
  scene.add(wordmark.group);

  const glitchers = [
    ...buildings.map((b) => b.glitch),
    ...buildings.map((b) => b.wordGlitch),
    wordmark.update,
  ];

  return {
    buildings,
    hitMeshes,
    focal: FOCAL,
    radius: DEFAULT_RADIUS,
    update(dt) {
      rain.update(dt);
      pulse.update(dt);
      for (const g of glitchers) g(dt);
    },
    setHighlight(b, on) {
      b.mat.emissiveIntensity = on ? 1.1 : 0.3;
      b.glow.material.opacity = on ? 0.55 : 0.24;
    },
  };
}

function makeGround() {
  const group = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.9 }),
  );
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);

  // Faint grid — the digital 40%, kept subtle so the solid cubes lead.
  const half = 22;
  const step = 3.5;
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
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return group;
}

// A perfect cube for an app: solid lit body (realistic), a faint wire edge and
// a centred glow (digital), an invisible hit volume, and a 3D word plaque.
// It glitches intermittently.
function makeWallCube(cfg) {
  const half = SIDE / 2;
  const group = new THREE.Group();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x0e1424,
    roughness: 0.5,
    metalness: 0.18,
    transparent: true,
    opacity: 0.9,
    emissive: 0x072a1f,
    emissiveIntensity: 0.3,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(SIDE, SIDE, SIDE), mat);
  group.add(body);

  // Faint wire edges — the digital line language, barely there.
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(SIDE, SIDE, SIDE)),
    new THREE.LineBasicMaterial({
      color: 0x7dffc4,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(edges);

  // Centred glow — reads as haze/blur around the cube.
  const glow = makeGlow(0x7dffc4, SIDE * 1.9, 0.24);
  group.add(glow);

  // The 3D word plaque, mounted on the cube's front face (faces +Z).
  const word = makeWord(cfg.word, 3, 1);
  word.group.position.set(0, 0, half + 0.02);
  group.add(word.group);

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(SIDE + 1.2, SIDE + 1.2, SIDE + 1.2),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  group.add(hit);

  group.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);

  const building = {
    key: cfg.key,
    label: cfg.word,
    href: cfg.href,
    group,
    hitMesh: hit,
    worldPos: new THREE.Vector3(...cfg.pos),
    mat,
    glow,
    glitch: withGlitch(
      () => {
        mat.emissive.set(0xff2e88);
        mat.emissiveIntensity = 1.4;
      },
      () => {
        mat.emissive.set(0x072a1f);
        mat.emissiveIntensity = 0.3;
      },
    ),
    wordGlitch: word.update,
  };
  hit.userData.building = building;
  return building;
}

function makeDecoCube(pos) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c1120,
    roughness: 0.55,
    metalness: 0.15,
    transparent: true,
    opacity: 0.82,
    emissive: 0x061f28,
    emissiveIntensity: 0.4,
  });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(SIDE, SIDE, SIDE), mat));
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(SIDE, SIDE, SIDE)),
      new THREE.LineBasicMaterial({
        color: 0x35d998,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  const glow = makeGlow(0x35d998, SIDE * 1.6, 0.16);
  group.add(glow);
  group.position.set(pos[0], pos[1], pos[2]);
  group.userData.glitch = withGlitch(
    () => {
      mat.emissive.set(0x22e8ff);
      mat.emissiveIntensity = 1.2;
    },
    () => {
      mat.emissive.set(0x061f28);
      mat.emissiveIntensity = 0.4;
    },
  );
  return group;
}

// The atmosphere: expanding shockwave rings across the ground, smaller for
// the smaller world.
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
    rings.push({ line, mat, t: i * 1.4, period: 2.8, max: 26 });
  }

  function update(dt) {
    for (const r of rings) {
      r.t += dt;
      if (r.t > r.period) r.t = 0;
      const p = r.t / r.period;
      r.line.scale.setScalar(1 + p * (r.max - 1));
      r.mat.opacity = 0.28 * Math.sin(Math.PI * p);
    }
  }

  return { lines, update };
}

// A small state machine that intermittently fires a ~120ms glitch: mostly
// idle, occasionally faults (the talvi glitch register).
function withGlitch(onGlitch, onRestore) {
  let untilNext = 1.5 + Math.random() * 3;
  let t = 0;
  return function (dt) {
    if (t > 0) {
      t -= dt;
      if (t <= 0) onRestore();
    } else {
      untilNext -= dt;
      if (untilNext <= 0) {
        t = 0.12;
        untilNext = 2 + Math.random() * 3.5;
        onGlitch();
      }
    }
  };
}
