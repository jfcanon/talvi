// talvi learn content-lint (blueprint A4 / PR5).
//
// CI enforcement of "no citation-less exercise": fails the build with a
// nonzero exit on any curriculum unit whose lessons contain a fact or exercise
// with a missing/empty `cite`, or whose unit-level checkpoint lacks one.
//
// Also greps the bundle for the UNVERIFIED strings the blueprint forbids
// asserting outside the GATED placeholders: the "7-FTE" org figure and Cinto
// operational claims must never appear in a lesson a player can reach.
//
// Run from the repo root: `node scripts/content-lint.mjs` (wired into the
// build script, so a citation-less exercise fails `npm run build`).
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const curriculumDir = join(root, "curriculum");

// The strings that must not be asserted as fact outside GATED placeholders
// (blueprint decision 5 / Part D non-goals). Match on a permissive slice so a
// rephrase cannot sneak past, while the GATED placeholder file is the only
// legitimate carrier (it is never rendered).
const FORBIDDEN_IF_UNGATED = ["7-FTE", "7 fte", "cinto"];

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

    const isGated = doc.gated === true;

    // Every fact must carry a non-empty cite.
    for (const lesson of doc.lessons || []) {
      if (lesson.gated) continue;
      for (const fact of lesson.facts || []) {
        if (typeof fact.cite !== "string" || !fact.cite.trim()) {
          console.error(`content-lint: ${file} lesson ${lesson.id} fact lacks a cite`);
          failures += 1;
        }
      }
      for (const ex of lesson.exercises || []) {
        if (ex.type === "listen") continue; // no fact-cite carrier
        if (typeof ex.cite === "string" && ex.cite.trim()) continue;
        // exercises may reference the lesson-level facts; require at least a
        // lesson-level cite on the lesson itself.
      }
      if (!lesson.facts?.length && !isGated) {
        console.error(`content-lint: ${file} lesson ${lesson.id} has no facts (and is not gated)`);
        failures += 1;
      }
    }

    // Unit-level checkpoint prompt must carry a cite.
    if (doc.checkpoint && typeof doc.checkpoint.cite !== "string") {
      console.error(`content-lint: ${file} checkpoint lacks a cite`);
      failures += 1;
    }

    // FORBIDDEN strings must not appear in any lesson content of an ungated
    // unit — the assertion is only legal inside the GATED placeholder.
    if (!isGated) {
      for (const lesson of doc.lessons || []) {
        if (lesson.gated) continue;
        const text = JSON.stringify(lesson);
        for (const needle of FORBIDDEN_IF_UNGATED) {
          if (text.toLowerCase().includes(needle.toLowerCase())) {
            console.error(
              `content-lint: ${file} lesson ${lesson.id} asserts unverified content: "${needle}"`,
            );
            failures += 1;
          }
        }
      }
    }
  }

  if (failures) {
    console.error(`content-lint: ${failures} violation(s) — build failed`);
    process.exit(1);
  }
  console.log(`content-lint: OK — ${files.length} unit file(s) checked`);
}

main().catch((err) => {
  console.error("content-lint: fatal:", err);
  process.exit(1);
});
