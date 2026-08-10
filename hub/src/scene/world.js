// talvi hub — the explorable world (v4, ideas #1 + #2).
//
// Near-black ground, phosphor-green line-and-glow, fog, and the instrument
// language translated into wireframe geometry. The change in v4: the
// instrument panels are no longer scenery on a linear path — they are three
// BUILDINGS (relay, chat, cinto) arranged around the world, each a real app.
// Every building carries an invisible hit volume so a raycast can find it, a
// glow that lifts on hover, and a world position the HTML label anchors to.
//
// The sign (wordmark) stays as the central landmark.
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas, so the
// worn-film register reads exactly as it does on talvi's page today (A5c).
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";
import { createSign } from "./sign.js";

// One building per app. Order and keys must match the <a class="node"
// data-key=…> anchors in hubpage.js. Positions put the three apps around the
// wordmark so orbiting reads them as a cluster of lit buildings.
const BUILDING_CFG = [
  { key: "relay", label: "TALVI", href: "https://app.ygdcbtmc4u.uk/relay", pos: [-13, 3.2, -6] },
  { key: "chat", label: "CHAT", href: "https://app.ygdcbtmc4u.uk/chat", pos: [13, 3.2, -6] },
  { key: "cinto", label: "CINTO", href: "https://cinto.ygdcbtmc4u.uk", pos: [0, 3.2, -20] },
];

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 2.6, -4);
export const DEFAULT_RADIUS = 24;

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.018);

  scene.add(makeGrid());
  scene.add(makePosts());

  const rain = createRain(1500);
  scene.add(rain.lines);

  const scan = makeScan();
  scene.add(scan.mesh);

  const buildings = BUILDING_CFG.map((cfg) => makeBuilding(cfg));
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
      scan.update(dt);
      sign.update(dt);
    },
    setHighlight(b, on) {
      b.mat.opacity = on ? 1 : 0.75;
      b.glow.material.opacity = on ? 0.55 : 0.3;
    },
  };
}

// A building: the instrument box (deeper than the old panels so it reads as a
// cube), a glow centre, and an invisible hit volume the raycaster targets.
function makeBuilding(cfg) {
  const group = new THREE.Group();

  const { seg, mat } = makeBox(11, 6, 3);
  group.add(seg);

  const glow = makeGlow(0x7dffc4, 8, 0.3);
  glow.position.set(0, 0, 3.6);
  group.add(glow);

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(14, 9, 6),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  hit.userData.building = null; // set below after the object exists
  group.add(hit);

  group.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);

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

// The instrument box: front and back faces, corner connectors and brackets,
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
  const mat = new THREE.LineBasicMaterial({
    color: 0x7dffc4,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return { seg: new THREE.LineSegments(geo, mat), mat };
}
