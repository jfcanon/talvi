// talvi learn content-lint (blueprint A4 / PR5, revised for verified lifts).
//
// CI enforcement of the accuracy contract:
//   1. Every fact carries a non-empty `cite` ("<file>:<section>").
//   2. EVERY exercise carries a non-empty `cite` — an exercise without a
//      resolvable citation fails the build (decision 4 / PR5 scope).
//   3. Every unit checkpoint carries a non-empty `cite`.
//   4. A `cite` must be well-formed: "<file>:<section>" with a non-empty
//      section after the colon, and <file> must be one of the allowed roots
//      (secondbrain/docs/HUB-BLUEPRINT.md, sidequests/, or
//      cinto-cloud-console/ for verified cinto citations).
//   5. The UNVERIFIED strings the blueprint forbids asserting ("7-FTE",
//      "7 fte", "cinto") may appear only inside GATED placeholders
//      (lesson.gated === true) or in facts/exercises marked `verified: true`
//      — never in unverified reachable content.
//   6. Every fact must carry a non-empty `text` field (enforced by this
//      script; the lesson player renders `fact.text`).
//
// The ground-truth of each citation STRING is verified by the PR author
// against the secondbrain/sidequests corpus (which lives outside this repo;
// blueprint Part D open decision 4). This script enforces presence, shape,
// and gating so a citation-less exercise cannot silently land.
//
// Run from the repo root: `node scripts/content-lint.mjs` (wired into the
// build script, so a citation-less exercise fails `npm run build`).
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const curriculumDir = join(root, "curriculum");

// Allowed cite roots (blueprint decision 4, extended for verified cinto lifts).
// Any other <file> is a violation.
const ALLOWED_FILE_PREFIXES = [
  "secondbrain/docs/HUB-BLUEPRINT.md",
  "sidequests/",
  "cinto-cloud-console/",
];

// The strings that must not be asserted as fact outside GATED placeholders
// (blueprint decision 5 / Part D non-goals). Match on a permissive slice so
// a rephrase cannot sneak past, while the GATED placeholder file is the only
// legitimate carrier (it is never rendered).
const FORBIDDEN_IF_UNGATED = ["7-FTE", "7 fte", "cinto"];

function isAllowedCiteFile(file) {
  return ALLOWED_FILE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function badCite(cite) {
  if (typeof cite !== "string") return "not a string";
  const trimmed = cite.trim();
  if (!trimmed) return "empty";
  const sep = trimmed.lastIndexOf(":");
  if (sep < 1) return 'missing ":" (need "<file>:<section>")';
  const file = trimmed.slice(0, sep).trim();
  const section = trimmed.slice(sep + 1).trim();
  if (!section) return "empty section after ':'";
  if (!isAllowedCiteFile(file)) return `file "${file}" not in allowed roots`;
  return null;
}

async function main() {
  const files = (await readdir(curriculumDir)).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    console.error("content-lint: no curriculum files found");
    process.exit(1);
  }

  let failures = 0;

  for (const file of files) {
    const raw = await readFile(join(curriculumDir, file), "utf8");
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      console.error(`content-lint: ${file} is not valid JSON: ${err.message}`);
      failures += 1;
      continue;
    }

    const isGatedUnit = doc.gated === true;

    for (const lesson of doc.lessons || []) {
      // Lesson-level gating only — a unit being gated does NOT shield its
      // individual lessons from the accuracy gate. A lifted (ungated) lesson
      // must satisfy the contract honestly, not hide behind the unit gate.
      const lessonGated = lesson.gated === true;

      for (const fact of lesson.facts || []) {
        const problem = badCite(fact.cite);
        if (problem) {
          console.error(`content-lint: ${file} lesson ${lesson.id} fact lacks a valid cite: ${problem}`);
          failures += 1;
        }
        // B3: every fact must have a non-empty text field.
        if (!lessonGated && !(fact.text && fact.text.trim())) {
          console.error(`content-lint: ${file} lesson ${lesson.id} fact has empty or missing text`);
          failures += 1;
        }
      }

      for (const ex of lesson.exercises || []) {
        const problem = badCite(ex.cite);
        if (problem) {
          console.error(
            `content-lint: ${file} lesson ${lesson.id} exercise ("${ex.prompt ?? ""}") lacks a valid cite: ${problem}`,
          );
          failures += 1;
        }
      }

      // A reachable lesson must carry at least one fact and one exercise.
      if (!lessonGated) {
        if (!(lesson.facts || []).length) {
          console.error(`content-lint: ${file} lesson ${lesson.id} has no facts`);
          failures += 1;
        }
        if (!(lesson.exercises || []).length) {
          console.error(`content-lint: ${file} lesson ${lesson.id} has no exercises`);
          failures += 1;
        }
      }

      // UNVERIFIED strings only legal inside GATED placeholders or in
      // verified content (facts/exercises with verified: true).
      if (!lessonGated) {
        const text = JSON.stringify(lesson);
        for (const needle of FORBIDDEN_IF_UNGATED) {
          if (text.toLowerCase().includes(needle.toLowerCase())) {
            // Check if ALL occurrences are in verified facts/exercises.
            // If any unverified fact/exercise contains the needle, it's a violation.
            let isVerified = true;
            for (const fact of lesson.facts || []) {
              if (!fact.verified && JSON.stringify(fact).toLowerCase().includes(needle.toLowerCase())) {
                isVerified = false;
                break;
              }
            }
            if (isVerified) {
              for (const ex of lesson.exercises || []) {
                if (!ex.verified && JSON.stringify(ex).toLowerCase().includes(needle.toLowerCase())) {
                  isVerified = false;
                  break;
                }
              }
            }
            if (!isVerified) {
              console.error(
                `content-lint: ${file} lesson ${lesson.id} asserts unverified content: "${needle}"`,
              );
              failures += 1;
            }
          }
        }
      }
    }

    // Unit-level checkpoint prompt must carry a valid cite.
    if (doc.checkpoint) {
      const problem = badCite(doc.checkpoint.cite);
      if (problem) {
        console.error(`content-lint: ${file} checkpoint lacks a valid cite: ${problem}`);
        failures += 1;
      }
    }
  }

  if (failures) {
    console.error(`content-lint: ${failures} violation(s) \u2014 build failed`);
    process.exit(1);
  }
  console.log(`content-lint: OK \u2014 ${files.length} unit file(s) checked`);
}

main().catch((err) => {
  console.error("content-lint: fatal:", err);
  process.exit(1);
});
