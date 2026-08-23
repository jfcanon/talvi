// talvi hub — HYG celestial dome (v9.0). One Points draw for stars + dust.
// Stars: astronexus/HYG-Database hygdata_v41, mag <= 6.5.
// Mapping: mathiasbno/three-starmap RA/Dec → sphere.
// Aquarius lines: Stellarium western constellationship.fab
import * as THREE from "three";
import catalog from "./sky-catalog.json";

export const SKY_RADIUS = 460;

const BA_LAT = -34.6037014;
const BA_LNG = -58.3816048;
const EVENING_HOUR = 21;
const TILT = 23.44;

let starTex = null;
function starTexture() {
  if (starTex) return starTex;
  const s = 64;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,255,255,0.95)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(0.7, "rgba(255,255,255,0.06)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  starTex = new THREE.CanvasTexture(c);
  starTex.needsUpdate = true;
  return starTex;
}

function nebulaTexture(r, g, b) {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.22)`);
  grd.addColorStop(0.45, `rgba(${r},${g},${b},0.07)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

function raDecToPoint(raHours, decDeg, radius) {
  const lng = (raHours * 360) / 24 - 180;
  const lat = decDeg;
  const deg2Rad = Math.PI / 180;
  const phi = (90 - lat) * deg2Rad;
  const theta = (lng + 180) * deg2Rad;
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function starRgb(ra, dec, mag) {
  const t = (Math.sin(ra * 12.9898 + dec * 78.233) * 43758.5453) % 1;
  const u = t < 0 ? t + 1 : t;
  const cool = mag > 4.2 ? Math.min(1, u + 0.15) : u * 0.7;
  if (cool < 0.33) return [0.72, 0.82, 1];
  if (cool < 0.66) return [0.95, 0.94, 0.9];
  return [1, 0.72, 0.52];
}

export function makeSky(dustCount = 160) {
  const group = new THREE.Group();
  group.renderOrder = -1;
  const map = starTexture();
  const anchors = catalog.aqrAnchors || [];
  const starN = catalog.stars.length + anchors.length;
  const n = starN + dustCount;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const vel = new Float32Array(dustCount * 3);

  catalog.stars.forEach((s, i) => {
    const p = raDecToPoint(s[0], s[1], SKY_RADIUS);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    const rgb = starRgb(s[0], s[1], s[2]);
    col[i * 3] = rgb[0];
    col[i * 3 + 1] = rgb[1];
    col[i * 3 + 2] = rgb[2];
  });
  anchors.forEach((a, k) => {
    const i = catalog.stars.length + k;
    const p = raDecToPoint(a.ra, a.dec, SKY_RADIUS);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    col[i * 3] = 1;
    col[i * 3 + 1] = 0.95;
    col[i * 3 + 2] = 0.82;
  });

  function placeDust(d) {
    let x, y, z, r;
    do {
      x = (Math.random() - 0.5) * 36;
      y = 1 + Math.random() * 16;
      z = (Math.random() - 0.5) * 36;
      r = Math.hypot(x, y - 6, z);
    } while (r < 9);
    const i = starN + d;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vel[d * 3] = (Math.random() - 0.5) * 0.08;
    vel[d * 3 + 1] = (Math.random() - 0.5) * 0.05;
    vel[d * 3 + 2] = (Math.random() - 0.5) * 0.08;
    col[i * 3] = 0.78;
    col[i * 3 + 1] = 0.83;
    col[i * 3 + 2] = 0.88;
  }
  for (let d = 0; d < dustCount; d++) placeDust(d);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  group.add(
    new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map,
        vertexColors: true,
        size: 2.2,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        alphaTest: 0.02,
      }),
    ),
  );

  const segs = catalog.aqrSegs || [];
  if (segs.length) {
    const linePos = new Float32Array(segs.length * 6);
    segs.forEach((seg, i) => {
      const a = raDecToPoint(seg[0], seg[1], SKY_RADIUS);
      const b = raDecToPoint(seg[2], seg[3], SKY_RADIUS);
      const o = i * 6;
      linePos[o] = a.x;
      linePos[o + 1] = a.y;
      linePos[o + 2] = a.z;
      linePos[o + 3] = b.x;
      linePos[o + 4] = b.y;
      linePos[o + 5] = b.z;
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    group.add(
      new THREE.LineSegments(
        lg,
        new THREE.LineBasicMaterial({
          color: 0x8aa8b8,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          fog: false,
        }),
      ),
    );
  }

  const clouds = [
    { ra: 22.1, dec: -6, rgb: [80, 40, 90], s: 200 },
    { ra: 5.6, dec: -20, rgb: [50, 55, 90], s: 180 },
  ];
  for (const c of clouds) {
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: nebulaTexture(c.rgb[0], c.rgb[1], c.rgb[2]),
        transparent: true,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.55,
      }),
    );
    spr.position.copy(raDecToPoint(c.ra, c.dec, SKY_RADIUS * 0.94));
    spr.scale.set(c.s, c.s, 1);
    group.add(spr);
  }

  group.rotation.order = "ZYX";
  group.rotation.z = THREE.MathUtils.degToRad(TILT);
  group.rotation.x = THREE.MathUtils.degToRad(BA_LAT);
  group.rotation.y = THREE.MathUtils.degToRad(BA_LNG + 360 * (EVENING_HOUR / 24 - 0.5));

  function updateDust(dt) {
    for (let d = 0; d < dustCount; d++) {
      vel[d * 3] += (Math.random() - 0.5) * 0.012 * dt;
      vel[d * 3 + 1] += (Math.random() - 0.5) * 0.008 * dt;
      vel[d * 3 + 2] += (Math.random() - 0.5) * 0.012 * dt;
      vel[d * 3] *= 0.994;
      vel[d * 3 + 1] *= 0.994;
      vel[d * 3 + 2] *= 0.994;
      const i = starN + d;
      pos[i * 3] += vel[d * 3] * dt;
      pos[i * 3 + 1] += vel[d * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[d * 3 + 2] * dt;
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { group, updateDust };
}
