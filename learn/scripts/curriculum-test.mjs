// Curriculum contract tests for talvi learn (PR5).
// Validates the shape the path graph and lesson player consume:
//   1. every unit has id+title, every lesson has id/title/skill/xp,
//   2. every lesson has >=1 fact with a cite and >=1 exercise,
//   3. every exercise is a known type with the fields that type requires,
//   4. Unit 5 (and only Unit 5) is GATED — MVP is Units 1-4,
//   5. lesson counts per unit match the blueprint contract.
// The cite-presence contract itself is enforced by scripts/content-lint.mjs
// (run first in the same npm script); this file checks structure + counts.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const curriculumDir = join(root, "curriculum");

// The blueprint contract (Part C): Units 1-4 MVP, Unit 5 GATED placeholders.
const EXPECTED_LESSONS = { u1: 5, u2: 6, u3: 8, u4: 5, u5: 4 };

const KNOWN_TYPES = new Set(["select", "order", "spot", "match", "tf", "complete"]);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    console.error(`FAIL - ${name}`);
    failures += 1;
  }
}

const files = (await readdir(curriculumDir)).filter((f) => f.endsWith(".json")).sort();
check("5 unit files present", files.length === 5);

let totalLessons = 0;
let mvpLessons = 0;
let totalCheckpoints = 0;

for (const f of files) {
  const doc = JSON.parse(await readFile(join(curriculumDir, f), "utf8"));
  const uid = doc.unit.id;

  check(`${f}: is a unit with id+title`, !!doc.unit?.id && !!doc.unit?.title);
  check(`${f}: lesson count matches blueprint (${EXPECTED_LESSONS[uid]})`, doc.lessons.length === EXPECTED_LESSONS[uid]);
  totalLessons += doc.lessons.length;
  if (uid !== "u5") mvpLessons += doc.lessons.length;
  if (doc.checkpoint) totalCheckpoints += 1;

const gated = doc.gated === true;
   for (const lesson of doc.lessons) {
     const lessonIsPlaceholder = (lesson.facts || []).length === 0 && (lesson.exercises || []).length === 0;
     if (lesson.gated || (gated && lessonIsPlaceholder)) {
       check(`${f}/${lesson.id}: gated lesson has no reachable exercises`, (lesson.exercises || []).length === 0);
       continue;
     }
    check(`${f}/${lesson.id}: has a title`, typeof lesson.title === "string" && lesson.title.length > 0);
    check(`${f}/${lesson.id}: has a skill`, typeof lesson.skill === "string" && lesson.skill.length > 0);
    check(`${f}/${lesson.id}: has >=1 fact`, (lesson.facts || []).length >= 1);
    check(`${f}/${lesson.id}: has >=1 exercise`, (lesson.exercises || []).length >= 1);

    const types = new Set(lesson.exercises.map((e) => e.type));
    check(`${f}/${lesson.id}: only known exercise types`, [...types].every((t) => KNOWN_TYPES.has(t)));
    for (const ex of lesson.exercises) {
      check(`${f}/${lesson.id}: exercise has a prompt`, typeof ex.prompt === "string" && ex.prompt.length > 0);
      check(`${f}/${lesson.id}: exercise carries a cite`, typeof ex.cite === "string" && ex.cite.length > 0);
      if (ex.type === "select") {
        check(`${f}/${lesson.id}: select has options + answer index`, Array.isArray(ex.options) && typeof ex.answer === "number");
      }
      if (ex.type === "spot") {
        check(`${f}/${lesson.id}: spot has a scenario + options + answer index`, typeof ex.scenario === "string" && Array.isArray(ex.options) && typeof ex.answer === "number");
      }
      if (ex.type === "tf") {
        check(`${f}/${lesson.id}: tf has a boolean answer`, typeof ex.answer === "boolean");
      }
      if (ex.type === "match") {
        check(`${f}/${lesson.id}: match has pairs`, Array.isArray(ex.pairs) && ex.pairs.length >= 2);
      }
      if (ex.type === "order") {
        check(`${f}/${lesson.id}: order has options + ordered answer`, Array.isArray(ex.options) && Array.isArray(ex.answer));
      }
      if (ex.type === "complete") {
        check(`${f}/${lesson.id}: complete has bank + answer`, Array.isArray(ex.bank) && Array.isArray(ex.answer));
      }
    }
  }

  if (doc.checkpoint) {
    check(`${f}: checkpoint has prompt+cite`, !!doc.checkpoint.prompt && typeof doc.checkpoint.cite === "string");
  }
}

check("MVP total = 24 lessons (Units 1-4)", mvpLessons === 24);
check("5 checkpoints total (one per unit)", totalCheckpoints === 5);

console.log(failures ? `\n${failures} failure(s)` : "\nall curriculum contract tests passed");
process.exit(failures ? 1 : 0);
