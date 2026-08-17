// talvi hub — night sky (v8.0). Field stars + Aquarius above the horizon.
import * as THREE from "three";

export const SKY_RADIUS = 90;

const FIELD = Math.round(2500 * 1.02);
const VIEW_YAW = 0.5;
const VIEW_PITCH = 0.42;
const VIEW_RADIUS = 16;
const FOCAL_Y = 5.98;

const AQR = {
  eps: [20.7945, -9.4958],
  bet: [21.5259, -5.5712],
  alp: [22.0964, -0.3199],
  the: [22.2806, -7.7833],
  iot: [22.1073, -13.87],
  gam: [22.3609, -1.3873],
  zet: [22.4805, -0.0175],
  eta: [22.5892, -0.1175],
  pi: [22.3714, 1.3776],
  lam: [22.8769, -7.5797],
  del: [22.9108, -15.8208],
  s88: [23.157, -21.1728],
  phi: [23.237, -6.049],
  psi: [23.2643, -9.0878],
};

const AQR_LINES = [
  ["eps", "bet"],
  ["bet", "alp"],
  ["alp", "the"],
  ["the", "iot"],
  ["alp", "gam"],
  ["gam", "zet"],
  ["zet", "eta"],
  ["gam", "pi"],
  ["iot", "del"],
  ["del", "lam"],
  ["lam", "phi"],
  ["phi", "psi"],
  ["del", "s88"],
];

function rng(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultCamera() {
  const cp = Math.cos(VIEW_PITCH);
  const sp = Math.sin(VIEW_PITCH);
  return new THREE.Vector3(
    VIEW_RADIUS * cp * Math.sin(VIEW_YAW),
    FOCAL_Y + VIEW_RADIUS * sp,
    VIEW_RADIUS * cp * Math.cos(VIEW_YAW),
  );
}

function aqrOnSky() {
  const names = Object.keys(AQR);
  let meanRa = 0;
  let meanDec = 0;
  for (const k of names) {
    meanRa += AQR[k][0];
    meanDec += AQR[k][1];
  }
  meanRa /= names.length;
  meanDec /= names.length;

  const local = {};
  const scale = 2.4;
  for (const k of names) {
    const dRa = (AQR[k][0] - meanRa) * 15 * Math.cos((meanDec * Math.PI) / 180);
    const dDec = AQR[k][1] - meanDec;
    local[k] = new THREE.Vector2(dRa * scale, dDec * scale);
  }

  const cam = defaultCamera();
  const away = new THREE.Vector3(-cam.x, 0, -cam.z).normalize();
  const dir = away.add(new THREE.Vector3(0, 1.55, 0)).normalize();
  const center = dir.multiplyScalar(SKY_RADIUS);
  if (center.y < 28) center.y = 28;

  const toCam = cam.clone().sub(center).normalize();
  let right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toCam);
  if (right.lengthSq() < 1e-6) right = new THREE.Vector3(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(toCam, right).normalize();
  if (up.y < 0) {
    up.negate();
    right.negate();
  }

  const at = {};
  for (const k of names) {
    const p = center.clone().addScaledVector(right, local[k].x).addScaledVector(up, local[k].y);
    if (p.y < 12) p.y = 12;
    at[k] = p;
  }
  return at;
}

export function makeSky() {
  const group = new THREE.Group();
  const rand = rng(7);

  const field = new Float32Array(FIELD * 3);
  for (let i = 0; i < FIELD; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    field[i * 3] = r * Math.cos(t) * SKY_RADIUS;
    field[i * 3 + 1] = u * SKY_RADIUS;
    field[i * 3 + 2] = r * Math.sin(t) * SKY_RADIUS;
  }
  const fieldGeo = new THREE.BufferGeometry();
  fieldGeo.setAttribute("position", new THREE.BufferAttribute(field, 3));
  group.add(
    new THREE.Points(
      fieldGeo,
      new THREE.PointsMaterial({
        color: 0xdce8ff,
        size: 0.18,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.72 * 1.02,
        depthWrite: false,
        fog: false,
      }),
    ),
  );

  const at = aqrOnSky();
  const names = Object.keys(AQR);
  const bright = new Float32Array(names.length * 3);
  names.forEach((k, i) => {
    bright[i * 3] = at[k].x;
    bright[i * 3 + 1] = at[k].y;
    bright[i * 3 + 2] = at[k].z;
  });
  const brightGeo = new THREE.BufferGeometry();
  brightGeo.setAttribute("position", new THREE.BufferAttribute(bright, 3));
  group.add(
    new THREE.Points(
      brightGeo,
      new THREE.PointsMaterial({
        color: 0xd4eee4,
        size: 0.32,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        fog: false,
      }),
    ),
  );

  const segs = new Float32Array(AQR_LINES.length * 6);
  AQR_LINES.forEach((pair, i) => {
    const a = at[pair[0]];
    const b = at[pair[1]];
    const o = i * 6;
    segs[o] = a.x;
    segs[o + 1] = a.y;
    segs[o + 2] = a.z;
    segs[o + 3] = b.x;
    segs[o + 4] = b.y;
    segs[o + 5] = b.z;
  });
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(segs, 3));
  group.add(
    new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0xb7d4c8,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ),
  );

  return group;
}
