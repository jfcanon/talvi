// Curriculum contract tests for talvi learn (PR5, exercised from PR6).
// Validates:
//   1. every fact carries a real cite (the content-lint contract),
//   2. every lesson has exercises of a known type with the fields that type
//      requires,
//   3. the path-graph logic (activeNode / buildRail) computes the right next
//      node as progress and gates move.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const curriculumDir = join(root, "curriculum");

const KNOWN_TYPES = new Set(["select", "order", "match", "complete", "listen"]);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    console.error(`FAIL - ${name}`);
    failures += 1;
  }
}

const files = (await readdir(curriculumDir)).filter((f) => f.endsWith(".json"));
const units = [];
for (const f of files) {
  const doc = JSON.parse(await readFile(join(curriculumDir, f), "utf8"));
  units.push(doc);

  check(`${f}: is a unit with id+title`, !!doc.unit?.id && !!doc.unit?.title);

  for (const lesson of doc.lessons || []) {
    if (lesson.gated) {
      check(`${f}/${lesson.id}: gated lesson has no reachable exercises`, (lesson.exercises || []).length === 0);
      continue;
    }
    check(`${f}/${lesson.id}: has a title`, typeof lesson.title === "string" && lesson.title.length > 0);
    check(`${f}/${lesson.id}: has a skill`, typeof lesson.skill === "string" && lesson.skill.length > 0);
    check(`${f}/${lesson.id}: has >=1 fact with a cite`, (lesson.facts || []).every((x) => typeof x.cite === "string" && x.cite.length > 0) && lesson.facts.length >= 1);
    check(`${f}/${lesson.id}: has >=1 exercise`, (lesson.exercises || []).length >= 1);
    for (const ex of lesson.exercises || []) {
      check(`${f}/${lesson.id}: exercise type known (${ex.type})`, KNOWN_TYPES.has(ex.type));
      check(`${f}/${lesson.id}: exercise has a prompt`, typeof ex.prompt === "string" && ex.prompt.length > 0);
    }
    const ids = new Set(lesson.exercises.map((e) => e.type));
    check(`${f}/${lesson.id}: listen exercises carry text`, ids.has("listen") ? lesson.exercises.find((e) => e.type === "listen").text.length > 0 : true);
    check(`${f}/${lesson.id}: select carries answer index`, ids.has("select") ? lesson.exercises.find((e) => e.type === "select").answer !== undefined : true);
  }

  if (doc.checkpoint) {
    check(`${f}: checkpoint has prompt+cite`, !!doc.checkpoint.prompt && typeof doc.checkpoint.cite === "string");
  }
}

// ---- activeNode / buildRail logic (mirror curriculum.js's contract) ----
// Import the real module through esbuild (Node can't import the .json statically).
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: [join(root, "src/lib/curriculum.js")],
  bundle: true,
  format: "esm",
  outfile: join(root, "dist/curriculum-test.mjs"),
  logLevel: "silent",
});
const curriculum = await import(join(root, "dist/curriculum-test.mjs"));

// Fresh player: no gates open, no lessons done.
check("active: starts at u1l1", curriculum.activeNode(new Set(), {}) === "u1l1");

// Master u1l1 → next is u1l2.
const done1 = { u1l1: { status: "mastered", passes: 1 } };
check("active: after u1l1 → u1l2", curriculum.activeNode(new Set(), done1) === "u1l2");

// Everything in unit 1 mastered, but c1 gate NOT open → unit 2 locked.
const doneU1 = {
  u1l1: { status: "mastered", passes: 1 },
  u1l2: { status: "mastered", passes: 1 },
  u1l3: { status: "mastered", passes: 1 },
  u1l4: { status: "mastered", passes: 1 },
  u1l5: { status: "mastered", passes: 1 },
};
check("active: unit1 done, gate closed → null (no reachable node)", curriculum.activeNode(new Set(), doneU1) === null);

// Open c1 → unit 2 unlocked.
check("active: gate c1 open → u2l1", curriculum.activeNode(new Set(["c1"]), doneU1) === "u2l1");

// buildRail: banners + lessons + checkpoints in order.
const rail = curriculum.buildRail(new Set(), {});
const kinds = rail.map((n) => n.kind);
check("rail: starts with a unit banner", kinds[0] === "unit-banner");
check("rail: contains lessons", kinds.includes("lesson"));
check("rail: contains checkpoints", kinds.includes("checkpoint"));
check("rail: 5 units (incl. GATED banner)", rail.filter((n) => n.kind === "unit-banner").length === 5);

// Legendary threshold: 3 passes → legendary.
check(
  "legendary at 3 passes",
  curriculum.buildRail(new Set(), { u1l1: { status: "legendary", passes: 3 } }).find((n) => n.id === "u1l1").status === "legendary",
);

console.log(failures ? `\n${failures} failure(s)` : "\nall curriculum tests passed");
process.exit(failures ? 1 : 0);
