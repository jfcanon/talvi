// talvi hub — HYG celestial dome (v8.0).
// Stars: astronexus/HYG-Database hygdata_v41, mag <= 6.5.
// Mapping: mathiasbno/three-starmap RA/Dec → sphere.
// Aquarius lines: Stellarium western constellationship.fab
//   (eleanorlutz/worldstars_atlas_of_space).
import * as THREE from "three";
import catalog from "./sky-catalog.json";

export const SKY_RADIUS = 460;

const BA_LAT = -34.6037014;
const BA_LNG = -58.3816048;
const EVENING_HOUR = 21;
const TILT = 23.44;

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

function magSize(m) {
  return Math.max(0.7, Math.min(5.2, 4.6 * Math.pow(10, -0.12 * (m + 1.44))));
}

function magOpacity(m) {
  return Math.max(0.22, Math.min(1, 0.28 + 0.55 * Math.pow(10, -0.18 * (m + 0.2))));
}

function pointsFrom(rows, color) {
  const pos = new Float32Array(rows.length * 3);
  rows.forEach((row, i) => {
    const p = raDecToPoint(row[0], row[1], SKY_RADIUS);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const avg = rows.reduce((s, r) => s + r[2], 0) / rows.length;
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color,
      size: magSize(avg),
      sizeAttenuation: false,
      transparent: true,
      opacity: magOpacity(avg),
      depthWrite: false,
      fog: false,
    }),
  );
}

export function makeSky() {
  const group = new THREE.Group();
  group.renderOrder = -1;

  const bins = [[], [], [], []];
  for (const s of catalog.stars) {
    const m = s[2];
    if (m <= 1.6) bins[0].push(s);
    else if (m <= 3.2) bins[1].push(s);
    else if (m <= 4.8) bins[2].push(s);
    else bins[3].push(s);
  }
  const colors = [0xf4fff8, 0xe2f4ea, 0xd0e4d8, 0xb8c8c0];
  bins.forEach((rows, i) => {
    if (rows.length) group.add(pointsFrom(rows, colors[i]));
  });

  const anchors = catalog.aqrAnchors || [];
  if (anchors.length) {
    const pos = new Float32Array(anchors.length * 3);
    anchors.forEach((a, i) => {
      const p = raDecToPoint(a.ra, a.dec, SKY_RADIUS);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    group.add(
      new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: 0x7dffc4,
          size: 4.2,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          fog: false,
        }),
      ),
    );
  }

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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    group.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          color: 0x7dffc4,
          transparent: true,
          opacity: 0.38,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      ),
    );
  }

  group.rotation.order = "ZYX";
  group.rotation.z = THREE.MathUtils.degToRad(TILT);
  group.rotation.x = THREE.MathUtils.degToRad(BA_LAT);
  group.rotation.y = THREE.MathUtils.degToRad(BA_LNG + 360 * (EVENING_HOUR / 24 - 0.5));
  return group;
}
