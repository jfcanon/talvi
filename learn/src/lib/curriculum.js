// talvi-learn curriculum (decision 4 / decision 5 / decision 6). Content is
// static JSON bundled by esbuild — never a database. PR5 (NID-100) authored
// Units 1–4 (real, cite-gated) and gated Unit 5; build-assets.mjs embeds the
// unit files as CURRICULUM (sorted by filename) in src/generated/assets.js.
// This module turns that bundle into the path graph + lookups the UI consumes:
//
//   getUnits()       → the embedded unit array
//   getLesson(id)    → enriched lesson (with unit context) or null
//   getCheckpoint(id)→ a checkpoint record or null
//   buildRail(lessons) → ordered path nodes (unit banners, lessons, gates)
//   activeNode(lessons) → the single next-to-play node id, or null
//
// Game mechanics map the machinery (decision 6): the path graph is the _moc.md
// shape (unit → lessons → checkpoint), a checkpoint is a gate-enforced verdict
// (the unit cannot close until the gate is passed), and the next node is the
// frontier — like the hub's active-sitting pointer.
//
// Gating model (server-side, deterministic — the client never decides reach):
//   - Unit 1 is unlocked; unit N>1 is unlocked only when unit N-1's checkpoint
//     is completed (has a mastered/legendary lesson_progress row).
//   - Within an unlocked unit, lesson i is unlocked when lesson i-1 is
//     completed (the first lesson is unlocked).
//   - A unit's checkpoint unlocks when every lesson in the unit is completed.
//   - Unit 5 is gated at the content level (decision 5): its nodes always
//     render locked — the underlying claims are UNVERIFIED.
import { CURRICULUM } from "../generated/assets.js";

// The API contract shape (GET /learn/api/curriculum). `version` bumps when the
// content changes; the client keys nothing off it (the server is truth).
export function getCurriculum() {
  return { version: 1, units: CURRICULUM };
}

export function getUnits() {
  return CURRICULUM;
}

// Enriched lesson record: the unit context rides along so the player can show
// "unit N / lesson M" without a second lookup.
export function getLesson(lessonId) {
  for (const unit of CURRICULUM) {
    for (const lesson of unit.lessons || []) {
      if (lesson.id === lessonId) {
        return {
          ...lesson,
          unitId: unit.unit.id,
          unitTitle: unit.unit.title,
          unitGated: unit.gated === true || lesson.gated === true,
          exercises: (lesson.exercises || []).map((ex) => ({ ...ex })),
        };
      }
    }
  }
  return null;
}

export function getCheckpoint(id) {
  for (const unit of CURRICULUM) {
    if (unit.checkpoint && unit.checkpoint.id === id) {
      return {
        ...unit.checkpoint,
        unitId: unit.unit.id,
        unitTitle: unit.unit.title,
        unitGated: unit.gated === true,
        exercises: [],
      };
    }
  }
  return null;
}

// A lesson or checkpoint is "done" once it has a mastered/legendary progress
// row (the ledger-derived state from PR4's reduction).
function isDone(lessons, id) {
  const row = lessons[id];
  return !!row && (row.state === "mastered" || row.state === "legendary");
}

function isMastered(lessons, id) {
  const row = lessons[id];
  return !!row && row.state === "mastered";
}

function isLegendary(lessons, id) {
  const row = lessons[id];
  return !!row && row.state === "legendary";
}

// Ordered path nodes. Node kinds:
//   { kind: "banner",   unitId, title, gated }
//   { kind: "lesson",   id, title, skill, unitId, gated, status }
//   { kind: "gate",     id, title, prompt, unitId, gated, status }
// status ∈ locked | active | mastered | legendary. Exactly one node may be
// 'active' (the frontier); the rest before it are done, after it locked.
//
// Gating model (revised for verified-lesson lifts):
//   - Unit accessibility depends on previous unit's checkpoint completion
//     (prevUnitUnlocked), NOT on whether the unit itself is gated.
//   - A unit being "gated" means its content is unverified; the banner shows
//     "GATED" but individual lessons can be lifted (ungated) once verified.
//   - A lesson with gated:false inside a gated unit is playable if the unit
//     is accessible (prevUnitUnlocked).
//   - The checkpoint unlocks when all reachable (non-gated) lessons are done
//     AND the unit is accessible.
export function buildRail(lessons) {
  const nodes = [];
  let prevUnitUnlocked = true;

  for (const unit of CURRICULUM) {
    const uid = unit.unit.id;
    const unitGated = unit.gated === true;
    // Unit accessibility: depends only on previous unit's checkpoint completion.
    // A gated unit can still have reachable (lifted) lessons.
    const unitAccessible = prevUnitUnlocked;

    nodes.push({
      kind: "banner",
      unitId: uid,
      title: unit.unit.title,
      gated: unitGated,
    });

    if (!unitAccessible) {
      // Locked unit: previous checkpoint not done — nothing reachable.
      for (const lesson of unit.lessons || []) {
        nodes.push({ kind: "lesson", id: lesson.id, title: lesson.title, skill: lesson.skill, unitId: uid, gated: lesson.gated === true, status: "locked" });
      }
      if (unit.checkpoint) {
        nodes.push({ kind: "gate", id: unit.checkpoint.id, title: unit.checkpoint.title, prompt: unit.checkpoint.prompt, unitId: uid, gated: false, status: "locked" });
      }
      continue;
    }

    // Accessible unit: lessons unlock sequentially, then the checkpoint.
    // Gated lessons are always locked; ungated lessons unlock sequentially.
    let prevLessonDone = true;
    for (const lesson of unit.lessons || []) {
      const gated = lesson.gated === true;
      const done = !gated && isDone(lessons, lesson.id);
      const unlocked = !gated && prevLessonDone;
      let status;
      if (gated) status = "locked";
      else if (isLegendary(lessons, lesson.id)) status = "legendary";
      else if (isMastered(lessons, lesson.id)) status = "mastered";
      else if (unlocked) status = "active";
      else status = "locked";
      nodes.push({ kind: "lesson", id: lesson.id, title: lesson.title, skill: lesson.skill, unitId: uid, gated, status });
      prevLessonDone = prevLessonDone && done;
    }

    if (unit.checkpoint) {
      // Checkpoint unlocks when all reachable (non-gated) lessons are done.
      const allReachableDone = (unit.lessons || []).every((l) => l.gated === true || isDone(lessons, l.id));
      const done = isDone(lessons, unit.checkpoint.id);
      const unlocked = allReachableDone;
      let status;
      if (done && isLegendary(lessons, unit.checkpoint.id)) status = "legendary";
      else if (done && isMastered(lessons, unit.checkpoint.id)) status = "mastered";
      else if (unlocked) status = "active";
      else status = "locked";
      nodes.push({ kind: "gate", id: unit.checkpoint.id, title: unit.checkpoint.title, prompt: unit.checkpoint.prompt, unitId: uid, gated: false, status });
      prevUnitUnlocked = done;
    } else {
      prevUnitUnlocked = unitAccessible;
    }
  }

  // A node can be both 'active' and done-adjacent only at the frontier; but the
  // master/legendary check above is inclusive of done nodes that also sit at
  // the frontier (e.g. a re-checkable gate). Only one node may be 'active' —
  // the first unlocked, uncompleted node in rail order.
  let claimed = false;
  for (const n of nodes) {
    if (n.status === "active") {
      if (claimed) n.status = "locked";
      else claimed = true;
    }
  }
  return nodes;
}

// The next-to-play node id, or null when the whole path is complete.
export function activeNode(lessons) {
  const rail = buildRail(lessons);
  for (const n of rail) {
    if (n.status === "active") return n.id;
  }
  return null;
}

// True when a lesson/gate node is playable given the current progress. A done
// node is always replayable (mastery re-check, decision 6); an unlocked
// frontier node is the active node; anything locked is not.
export function isReachable(lessons, id) {
  const rail = buildRail(lessons);
  const node = rail.find((n) => n.id === id);
  if (!node) return false;
  return node.status === "active" || node.status === "mastered" || node.status === "legendary";
}

// "unit N / lesson M of L" for the lesson header.
export function lessonPosition(lessonId) {
  let unitIndex = 0;
  for (const unit of CURRICULUM) {
    const idx = (unit.lessons || []).findIndex((l) => l.id === lessonId);
    if (idx !== -1) {
      return { unitIndex: unitIndex + 1, lessonIndex: idx + 1, lessonTotal: (unit.lessons || []).length, unitTitle: unit.unit.title };
    }
    unitIndex += 1;
  }
  return { unitIndex: 0, lessonIndex: 0, lessonTotal: 0, unitTitle: "" };
}

// Overall completion percentage across the MVP (non-gated) lessons.
export function completionPct(lessons) {
  let total = 0;
  let done = 0;
  for (const unit of CURRICULUM) {
    if (unit.gated === true) continue;
    for (const lesson of unit.lessons || []) {
      if (lesson.gated === true) continue;
      total += 1;
      if (isDone(lessons, lesson.id)) done += 1;
    }
    if (unit.checkpoint) {
      total += 1;
      if (isDone(lessons, unit.checkpoint.id)) done += 1;
    }
  }
  return total ? Math.round((done / total) * 100) : 0;
}

// Transform file-path citations to human-readable format
export function formatCitation(cite) {
  if (!cite) return "";
  const map = {
    "secondbrain/docs/HUB-BLUEPRINT.md:Vocabulary": "Tribunal Blueprint — Vocabulary",
    "secondbrain/docs/HUB-BLUEPRINT.md:Thesis": "Tribunal Blueprint — Thesis",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a710 Verdict": "Tribunal Blueprint — \u00a710 Verdict",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a72 Purpose & scope": "Tribunal Blueprint — Purpose & Scope",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a73 The core loop": "Tribunal Blueprint — Core Loop",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a71 Name": "Tribunal Blueprint — Name",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a74 Routing policy": "Tribunal Blueprint — Routing Policy",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a76 Grounding": "Tribunal Blueprint — Grounding",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a75 Convergence method": "Tribunal Blueprint — Convergence Method",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a77 State & memory": "Tribunal Blueprint — State & Memory",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a70 Current state": "Tribunal Blueprint — Current State",
    "secondbrain/docs/HUB-BLUEPRINT.md:\u00a79 item 8": "Tribunal Blueprint — \u00a79 Item 8",
    "sidequests/harness-baseline/intake.md:Grounding": "Harness Baseline — Grounding",
    "sidequests/harness-baseline/verdict.md:Component map": "Harness Baseline — Component Map",
    "sidequests/harness-baseline/verdict.md:Live defects found": "Harness Baseline — Live Defects Found",
    "sidequests/harness-baseline/verdict.md:Top-5": "Harness Baseline — Top-5",
    "sidequests/harness-baseline/verdict.md:Ceiling": "Harness Baseline — Ceiling",
    "sidequests/plan-convergence/verdict.md:Phase 0": "Plan Convergence — Phase 0",
    "sidequests/plan-convergence/verdict.md:Phase 1": "Plan Convergence — Phase 1",
    "sidequests/plan-convergence/verdict.md:Phase 2": "Plan Convergence — Phase 2",
    "sidequests/plan-convergence/verdict.md:Phase 3": "Plan Convergence — Phase 3",
    "sidequests/plan-convergence/verdict.md:Thread B": "Plan Convergence — Thread B",
    "sidequests/plan-convergence/verdict.md:Dissents": "Plan Convergence — Dissents",
    "sidequests/multica-eval/verdict.md:1. License gate": "Multica Eval — License Gate",
    "sidequests/multica-eval/verdict.md:5. Recommendation": "Multica Eval — Recommendation",
    "sidequests/_claims-schema.md:Record schema": "Claims Schema — Record Schema",
    "sidequests/_claims-schema.md:Lifecycle": "Claims Schema — Lifecycle",
  };
  return map[cite] || cite;
}
