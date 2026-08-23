// Rebuild hub/src/scene/sky-catalog.json from HYG + Stellarium Aquarius lines.
// Inputs (not committed): hygdata_v41.csv and constellationship.fab.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hygPath = process.argv[2];
const fabPath = process.argv[3];
if (!hygPath || !fabPath) {
  console.error("usage: node scripts/build-sky-catalog.mjs <hygdata_v41.csv> <constellationship.fab>");
  process.exit(2);
}

const fab = readFileSync(fabPath, "utf8");
const line = fab.split(/\n/).find((l) => l.startsWith("Aqr "));
if (!line) throw new Error("no Aqr row in constellationship.fab");
const parts = line.trim().split(/\s+/);
const nseg = Number(parts[1]);
const hips = parts.slice(2).map(Number);
if (hips.length !== nseg * 2) throw new Error("Aqr hip count mismatch");
const want = new Set(hips);

const stars = [];
const byHip = new Map();
const rows = readFileSync(hygPath, "utf8").split(/\n/);
const header = rows[0].split(",");
const iHip = header.indexOf("hip");
const iRa = header.indexOf("ra");
const iDec = header.indexOf("dec");
const iMag = header.indexOf("mag");
const iProper = header.indexOf("proper");
for (let i = 1; i < rows.length; i++) {
  if (!rows[i]) continue;
  const cols = rows[i].split(",");
  const mag = Number(cols[iMag]);
  const ra = Number(cols[iRa]);
  const dec = Number(cols[iDec]);
  if (!Number.isFinite(mag) || !Number.isFinite(ra) || !Number.isFinite(dec)) continue;
  if (mag < -2 || mag > 6.5) continue;
  const proper = cols[iProper] || "";
  if (proper.toLowerCase() === "sol") continue;
  const hip = Number(cols[iHip]) || 0;
  stars.push([Math.round(ra * 1e5) / 1e5, Math.round(dec * 1e5) / 1e5, Math.round(mag * 1e3) / 1e3]);
  if (want.has(hip)) byHip.set(hip, { ra, dec, mag, proper });
}

const missing = [...want].filter((h) => !byHip.has(h));
if (missing.length) throw new Error("missing HIP " + missing.join(","));

const aqrSegs = [];
for (let i = 0; i < hips.length; i += 2) {
  const a = byHip.get(hips[i]);
  const b = byHip.get(hips[i + 1]);
  aqrSegs.push([
    Math.round(a.ra * 1e5) / 1e5,
    Math.round(a.dec * 1e5) / 1e5,
    Math.round(b.ra * 1e5) / 1e5,
    Math.round(b.dec * 1e5) / 1e5,
  ]);
}
const aqrAnchors = [...byHip.entries()]
  .filter(([, v]) => v.proper)
  .map(([hip, v]) => ({
    hip,
    name: v.proper,
    ra: Math.round(v.ra * 1e5) / 1e5,
    dec: Math.round(v.dec * 1e5) / 1e5,
    mag: v.mag,
  }))
  .sort((a, b) => a.mag - b.mag);

const out = {
  source:
    "astronexus/HYG-Database hygdata_v41, mag<=6.5; Aquarius lines from Stellarium western constellationship.fab via eleanorlutz/worldstars_atlas_of_space",
  count: stars.length,
  stars,
  aqrSegs,
  aqrAnchors,
};
writeFileSync(join(here, "../src/scene/sky-catalog.json"), JSON.stringify(out));
console.log("sky-catalog:", stars.length, "stars,", aqrSegs.length, "Aqr segments");
