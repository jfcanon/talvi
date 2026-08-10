// talvi hub — the sunrise launcher (v4.3.1).
//
// Owner review, on top of v4.3:
//   - the icons are now 3D OBJECTS floating INSIDE each cube (a distinct
//     shape per app), blurry (a soft glow core), and they glitch HEAVY: an
//     intermittent lightning crash — a screen flash, the icon spikes white
//     and jolts, the world brightens for a moment;
//   - the linear/geometric draws are cut ~40% (no wire edges, no floor grid,
//     no pulse rings) and the scene is ~60% more realistic (physical tile
//     material with clearcoat, depth haze);
//   - the cubes CAST SHADOWS onto the floor;
//   - a green SUNRISE hangs far behind the launcher, low on the horizon.
//
// The .leak/.grain/.wear film layers stay in CSS, above the canvas.
import * as THREE from "three";
import { createRain } from "./rain.js";
import { makeGlow } from "./glow.js";

const SIDE = 2.3; // tile edge.

// The launcher grid: three apps plus a dimmed future slot, floating at two
// heights. href null → present but not clickable (like the blade's MORE).
const TILE_CFG = [
  { key: "relay", icon: "box", label: "TALVI", href: "https://app.ygdcbtmc4u.uk/relay", x: -1.7, baseY: 6.3, z: 0 },
  { key: "chat", icon: "ring", label: "CHAT", href: "https://app.ygdcbtmc4u.uk/chat", x: 1.7, baseY: 6.3, z: 0 },
  { key: "cinto", icon: "diamond", label: "CINTO", href: "https://cinto.ygdcbtmc4u.uk", x: -1.7, baseY: 4.0, z: 0 },
  { key: "future", icon: "cross", label: "MORE", href: null, x: 1.7, baseY: 4.0, z: 0 },
];

// Where the camera orbits around, and how far out it starts.
export const FOCAL = new THREE.Vector3(0, 5.1, 0);
export const DEFAULT_RADIUS = 14;

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.026);

  // --- lights --------------------------------------------------------------
  const ambient = new THREE.AmbientLight(0x9a8, 0.5);
  scene.add(ambient);
  const key = new THREE.PointLight(0x7dffc4, 1.1, 42);
  key.position.set(9, 15, 14);
  scene.add(key);
  const rim = new THREE.PointLight(0xff2e88, 0.7, 42);
  rim.position.set(-9, 7, -16);
  scene.add(rim);
  const fill = new THREE.PointLight(0x22e8ff, 0.35, 30);
  fill.position.set(0, 2, -9);
  scene.add(fill);

  // The sunrise sun: a directional light that casts the tiles' shadows, from
  // the same direction the green glow sits.
  const sun = new THREE.DirectionalLight(0x9dffb0, 1.3);
  sun.position.set(-9, 24, -32);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -3;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  scene.add(sun);

  // The sunrise glow: a wide green bloom low on the far horizon. fog:false so
  // it reads as light through the haze, not a solid object.
  scene.add(makeSunGlow());

  scene.add(makeGround());

  const rain = createRain(800);
  scene.add(rain.lines);

  // --- the launcher grid ---------------------------------------------------
  const tiles = TILE_CFG.map((cfg) => makeTile(cfg));
  const buildings = tiles.filter((t) => t.href);
  const hitMeshes = buildings.map((b) => b.hitMesh);
  for (const t of tiles) scene.add(t.group);

  // The lightning storm: rare, but when it crashes it is heavy.
  const storm = makeStorm({
    overlay: document.querySelector(".storm"),
    icons: tiles.map((t) => t.icon),
    ambient,
  });

  return {
    buildings,
    hitMeshes,
    focal: FOCAL,
    radius: DEFAULT_RADIUS,
    update(dt) {
      rain.update(dt);
      storm.update(dt);
      // Gentle hover: each tile bobs around its base height. Skipped under
      // prefers-reduced-motion (main.js doesn't call update then).
      const t = performance.now() / 1000;
      for (const tile of tiles) {
        tile.group.position.y = tile.baseY + Math.sin(t * 0.9 + tile.phase) * 0.28;
        tile.worldPos.copy(tile.group.position);
      }
    },
    setHighlight(b, on) {
      b.mat.emissiveIntensity = on ? 1.1 : 0.5;
      b.glow.material.opacity = on ? 0.55 : 0.3;
    },
  };
}

// The sunrise glow — a wide, low, soft green bloom far behind the launcher.
function makeSunGlow() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(256, 256, 8, 256, 256, 250);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.18, "rgba(157,255,176,0.75)");
  g.addColorStop(0.5, "rgba(107,255,168,0.28)");
  g.addColorStop(1, "rgba(107,255,168,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  sprite.scale.set(95, 44, 1);
  sprite.position.set(0, 7, -46);
  return sprite;
}

// The floor: a plain dark plane receiving the tiles' shadows. No grid — the
// linear/geometric draws are cut back (v4.3.1).
function makeGround() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ color: 0x060a12, roughness: 0.85, metalness: 0.05 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

// A floating tile: a solid physical cube (clearcoat — more realistic), no wire
// edges, casting a shadow on the floor, with a blurry 3D icon floating INSIDE
// it and a flat 2D caption below. Only href tiles get a hit volume.
function makeTile(cfg) {
  const half = SIDE / 2;
  const group = new THREE.Group();

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x0e1626,
    roughness: 0.35,
    metalness: 0.2,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    transparent: true,
    opacity: 0.9,
    emissive: 0x0a3a2c,
    emissiveIntensity: 0.5,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(SIDE, SIDE, SIDE), mat);
  body.castShadow = true;
  group.add(body);

  // The 3D icon, floating INSIDE the cube — a distinct shape per app, blurry
  // through the translucent body and its own soft glow.
  const icon = make3DIcon(cfg.icon, cfg.href ? 1 : 0.45);
  icon.group.position.z = 0;
  group.add(icon.group);

  // Soft glow around the cube (reads as haze).
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
    icon,
    baseY: cfg.baseY,
    phase: Math.random() * Math.PI * 2,
  };
  if (hit) hit.userData.building = building;
  return building;
}

// The blurry 3D icon: a distinct shape per app, emissive, wrapped in a soft
// glow. `dim` fades the future slot.
function make3DIcon(kind, dim) {
  const group = new THREE.Group();
  const active = dim === 1;
  const bright = active ? 0x9dffb0 : 0x35d998;
  const body = active ? 0x7dffc4 : 0x35d998;

  const mat = new THREE.MeshStandardMaterial({
    color: body,
    emissive: bright,
    emissiveIntensity: active ? 1.6 : 0.7,
    roughness: 0.3,
    transparent: true,
    opacity: 0.95,
  });

  let mesh;
  if (kind === "box") mesh = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), mat);
  else if (kind === "ring") mesh = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.15, 12, 26), mat);
  else if (kind === "diamond") mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), mat);
  else {
    // cross (the future slot): two thin boxes sharing the dim material.
    const cross = new THREE.Group();
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.85, 0.16), mat));
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 0.16), mat));
    mesh = cross;
  }
  mesh.castShadow = false;
  group.add(mesh);

  const glow = makeGlow(bright, 2.4, active ? 0.5 : 0.24);
  glow.position.z = 0.02;
  group.add(glow);

  return { group, mesh, mat };
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

// The lightning storm: rare and heavy. A screen flash (the .storm overlay), the
// icons spike white and jolt, and the whole world brightens for a moment — like
// a crash of lightning behind the launcher. Skipped under reduced-motion
// (world.update isn't called).
function makeStorm({ overlay, icons, ambient }) {
  const original = icons.map((ic) => ({
    scale: ic.mesh.scale.x,
    hex: ic.mat.emissive.getHex(),
    intensity: ic.mat.emissiveIntensity,
  }));
  let untilNext = 3.5 + Math.random() * 3.5;
  let t = 0;

  function flash() {
    if (overlay) {
      overlay.style.opacity = "0.34";
      window.setTimeout(() => {
        overlay.style.opacity = "0";
      }, 120);
    }
    for (const ic of icons) {
      ic.mat.emissive.set(0xffffff);
      ic.mat.emissiveIntensity = 3.4;
      ic.mesh.scale.setScalar(1.5);
      ic.mesh.position.x = (Math.random() - 0.5) * 0.45;
      ic.mesh.position.y = (Math.random() - 0.5) * 0.45;
    }
    if (ambient) ambient.intensity = 1.8;
  }

  function restore() {
    icons.forEach((ic, i) => {
      ic.mat.emissive.setHex(original[i].hex);
      ic.mat.emissiveIntensity = original[i].intensity;
      ic.mesh.scale.setScalar(original[i].scale);
      ic.mesh.position.set(0, 0, 0);
    });
    if (ambient) ambient.intensity = 0.5;
  }

  function update(dt) {
    if (t > 0) {
      t -= dt;
      if (t <= 0) restore();
    } else {
      untilNext -= dt;
      if (untilNext <= 0) {
        t = 0.15;
        untilNext = 3.5 + Math.random() * 4;
        flash();
      }
    }
  }

  return { update };
}

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';
