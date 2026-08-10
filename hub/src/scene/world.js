// talvi hub — the explorable world (v4.1).
//
// Three CUBES (relay, chat, cinto) arranged around the central wordmark, each
// a real app you can click (invisible hit volume + raycast). Revisions in
// v4.1:
//   - the buildings are cubes (equal sides), not flat prisms;
//   - each carries a fixed 3D nameplate above it — a textured plane attached
//     to the cube and facing the world centre, so orbiting walks AROUND it
//     rather than reading a camera-facing label;
//   - the light is centred INSIDE each cube;
//   - the 2D x-ray scan band is gone; the atmosphere is now expanding
//     shockwave rings of light radiating across the ground (a wave you see
//     edge-on as you orbit).
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas.
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";
import { createSign } from "./sign.js";

// One cube per app. `label` is what the nameplate says — RELAY (not TALVI:
// the wordmark IS talvi; the cube is the relay app). `pos` puts the three
// cubes around the sign so orbiting reads them as a lit cluster.
const CUBE_CFG = [
  { key: "relay", label: "RELAY", href: "https://app.ygdcbtmc4u.uk/relay", pos: [-13, 3.2, -6] },
  { key: "chat", label: "CHAT", href: "https://app.ygdcbtmc4u.uk/chat", pos: [13, 3.2, -6] },
  { key: "cinto", label: "CINTO", href: "https://cinto.ygdcbtmc4u.uk", pos: [0, 3.2, -20] },
];

const CUBE = 5.5; // equal sides — a cube, not a cuboid.

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 2.6, -4);
export const DEFAULT_RADIUS = 24;

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.018);

  scene.add(makeGrid());
  scene.add(makePosts());

  const rain = createRain(1500);
  scene.add(rain.lines);

  const pulse = makePulse();
  scene.add(...pulse.lines);

  const buildings = CUBE_CFG.map((cfg) => makeCube(cfg));
  const hitMeshes = [];
  for (const b of buildings) {
    scene.add(b.group);
    hitMeshes.push(b.hitMesh);
  }

  const sign = createSign();
  sign.group.position.set(0, 4.4, 0);
  scene.add(sign.group);

  return {
    buildings,
    hitMeshes,
    focal: FOCAL,
    radius: DEFAULT_RADIUS,
    update(dt) {
      rain.update(dt);
      pulse.update(dt);
      sign.update(dt);
    },
    setHighlight(b, on) {
      b.mat.opacity = on ? 1 : 0.75;
      b.glow.material.opacity = on ? 0.55 : 0.3;
    },
  };
}

// A cube: the instrument wireframe (one detailed face with cells + marked
// strip, the other faces plain edges), a nameplate above it facing the world
// centre, a glow centred INSIDE it, and an invisible hit volume for the
// raycaster. Every child moves with the cube, so orbiting sees the plate edge-
// on from the sides — it is fixed in the world, not facing the audience.
function makeCube(cfg) {
  const half = CUBE / 2;
  const group = new THREE.Group();

  const { seg, mat } = makeBox(CUBE, CUBE, CUBE);
  group.add(seg);

  // Light centred inside the cube.
  const glow = makeGlow(0x7dffc4, 3.4, 0.45);
  glow.position.set(0, 0, half);
  group.add(glow);

  // Nameplate: a textured plane floating just above the cube, its front
  // turned toward the world centre so you see it at different angles while
  // orbiting. DoubleSide so it is still readable from behind. lookAt runs
  // AFTER the group is positioned — it takes world coordinates.
  const plate = makeNameplate(cfg.label);
  plate.position.set(0, half + 0.9, 0);
  group.add(plate);

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(CUBE + 2.5, CUBE + 2.5, CUBE + 2.5),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  group.add(hit);

  group.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
  plate.lookAt(new THREE.Vector3(0, cfg.pos[1] + half + 0.9, 0));

  const building = {
    key: cfg.key,
    label: cfg.label,
    href: cfg.href,
    group,
    hitMesh: hit,
    worldPos: new THREE.Vector3(...cfg.pos),
    mat,
    glow,
  };
  hit.userData.building = building;
  return building;
}

function makeNameplate(text) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 160;
  const ctx = c.getContext("2d");
  ctx.font = "700 84px " + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(125,255,196,0.8)";
  ctx.shadowBlur = 46;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText(text, c.width / 2, c.height / 2 + 6);
  const mat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.45), mat);
}

function makeGrid() {
  const half = 70;
  const step = 4;
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
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function makePosts() {
  const spots = [
    [-20, -8, 5],
    [18, -20, 7],
    [-24, 2, 10],
    [22, 4, -14],
    [-16, -6, -28],
    [10, 6, -34],
    [-28, -10, 14],
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

// The atmosphere is a wave of light now, not a 2D x-ray scan: expanding rings
// of phosphor radiate from the world centre across the ground, swell, and
// fade — a sonar pulse you see edge-on while orbiting. Two rings, offset, for
// a continuous rhythm.
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
    rings.push({ line, mat, t: i * 1.7, period: 3.4, max: 48 });
  }

  function update(dt) {
    for (const r of rings) {
      r.t += dt;
      if (r.t > r.period) r.t = 0;
      const p = r.t / r.period;
      r.line.scale.setScalar(1 + p * (r.max - 1));
      r.mat.opacity = 0.32 * Math.sin(Math.PI * p);
    }
  }

  return { lines, update };
}

// The instrument cube: front and back faces, corner connectors and brackets,
// divider cells, and a marked strip — the talvi HUD translated to a volume.
function makeBox(w, h, depth) {
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
    const b = 0.8;
    lines.push(sx * hw, sy * hh, 0, sx * hw - sx * b, sy * hh, 0);
    lines.push(sx * hw, sy * hh, 0, sx * hw, sy * hh - sy * b, 0);
  }

  const cells = 3;
  for (let i = 1; i <= cells; i++) {
    const y = -hh + (h / (cells + 1)) * i;
    lines.push(-hw, y, 0, hw, y, 0);
  }
  lines.push(0, -hh, 0, 0, hh, 0);

  const ticks = 10;
  for (let i = 0; i < ticks; i++) {
    const x = -hw + (w / ticks) * i + w / (ticks * 2);
    lines.push(x, -hh - 0.3, 0, x, -hh + 0.25, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x7dffc4,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return { seg: new THREE.LineSegments(geo, mat), mat };
}
