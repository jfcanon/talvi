// talvi-learn curriculum loader (blueprint B.3 / decision 4 & 5).
//
// Content is static JSON bundled by esbuild — never a database (decision 4),
// versioned with code. Every lesson fact carries a `cite` referencing a real
// grounding file; scripts/content-lint.mjs fails the build on any exercise
// with a missing/empty cite. Unit 5 is GATED: nothing in it ships until the
// underlying claims are verified (decision 5 / Part D non-goals).
//
// The path graph the UI draws is derived from this structure (the _moc.md
// shape): units hold lessons in order; the last unit's lessons chain on, and
// each unit's checkpoint gates the NEXT unit. MVP = Units 1–4.
//
// Curriculum version: 2026-08-14 — accuracy-audited against HUB-BLUEPRINT.md
// and sidequests citations (PR7 verify pass).
import u1 from "../../curriculum/u1.json";
import u2 from "../../curriculum/u2.json";
import u3 from "../../curriculum/u3.json";
import u4 from "../../curriculum/u4.json";
import u5 from "../../curriculum/u5.json";

const UNITS = [u1, u2, u3, u4, u5];

export const CURRICULUM_VERSION = "2026-08-14";

// Flatten once. Lessons carry an absolute id ("u2l1") so progress keys never
// collide across units. The path graph is the unit order itself (a serpentine
// rail, blueprint B.3 / decision 6: path graph = _moc.md).
function buildIndex() {
  const lessonsById = new Map();
  const checkpointsById = new Map();
  for (const unit of UNITS) {
    for (const lesson of unit.lessons) {
      lessonsById.set(lesson.id, { ...lesson, unitId: unit.unit.id, unitTitle: unit.unit.title });
    }
    if (unit.checkpoint) {
      checkpointsById.set(unit.checkpoint.id, {
        ...unit.checkpoint,
        unitId: unit.unit.id,
        unitTitle: unit.unit.title,
      });
    }
  }
  return { lessonsById, checkpointsById };
}

const { lessonsById, checkpointsById } = buildIndex();

export function getUnits() {
  return UNITS;
}

export function getLesson(id) {
  return lessonsById.get(id) || null;
}

export function getCheckpoint(id) {
  return checkpointsById.get(id) || null;
}

// The active node: the first lesson (in unit order) that is not yet mastered,
// accounting for the checkpoint gates. A unit whose checkpoint is unopened
// stays locked — the player cannot reach into it.
//
// `openGates` = set of checkpoint ids that already have a verdict.
// `lessons`   = the reduced lesson_progress map from the store.
export function activeNode(openGates, lessons) {
  for (const unit of UNITS) {
    if (unit.gated) continue;
    if (!unit.checkpoint && unit !== UNITS[0]) continue;
    if (unit.unit.id !== UNITS[0].unit.id) {
      // The gate for the PREVIOUS unit must be open to enter this unit.
      const prev = UNITS[UNITS.indexOf(unit) - 1];
      if (prev && prev.checkpoint && !openGates.has(prev.checkpoint.id)) continue;
    }
    for (const lesson of unit.lessons) {
      if (lesson.gated) continue;
      const status = lessons[lesson.id] ? lessons[lesson.id].status : "not_started";
      if (status !== "legendary" && status !== "mastered") return lesson.id;
    }
  }
  return null; // everything mastered — the MVP is complete
}

// The path graph: a node per lesson, in rail order, tagged with its unit and
// its state. Checkpoint nodes are inserted at each unit boundary as distinct
// gate nodes. Returns an array of rail entries the path page renders.
export function buildRail(openGates, lessons) {
  const rail = [];
  for (let i = 0; i < UNITS.length; i++) {
    const unit = UNITS[i];
    if (unit.gated) {
      rail.push({
        kind: "unit-banner",
        id: unit.unit.id,
        title: unit.unit.title,
        gated: true,
      });
      rail.push({
        kind: "checkpoint",
        id: unit.checkpoint.id,
        title: "Checkpoint 5 — GATED",
        unitId: unit.unit.id,
        unitTitle: unit.unit.title,
        locked: true,
        gated: true,
      });
      continue;
    }
    rail.push({
      kind: "unit-banner",
      id: unit.unit.id,
      title: unit.unit.title,
    });
    for (const lesson of unit.lessons) {
      if (lesson.gated) continue;
      const status = lessons[lesson.id] ? lessons[lesson.id].status : "not_started";
      rail.push({
        kind: "lesson",
        id: lesson.id,
        title: lesson.title,
        skill: lesson.skill,
        unitId: unit.unit.id,
        unitTitle: unit.unit.title,
        status,
        passes: lessons[lesson.id] ? lessons[lesson.id].passes : 0,
      });
    }
    if (unit.checkpoint) {
      const open = openGates.has(unit.checkpoint.id);
      rail.push({
        kind: "checkpoint",
        id: unit.checkpoint.id,
        title: unit.checkpoint.title,
        unitId: unit.unit.id,
        unitTitle: unit.unit.title,
        open,
      });
    }
  }
  return rail;
}
