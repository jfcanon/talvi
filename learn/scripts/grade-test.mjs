// Grade unit tests for talvi learn (PR6). The grading code lives INSIDE
// client.js (served at /learn/s.js) — this harness extracts the real shipped
// PURE-GRADING block and exercises it, so the test covers exactly what the
// browser runs, not a re-implementation.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = await readFile(join(root, "src/ui/client.js"), "utf8");

const start = clientSrc.indexOf("PURE-GRADING-START");
const end = clientSrc.indexOf("PURE-GRADING-END");
if (start === -1 || end === -1 || end <= start) {
  console.error("grade-test: PURE-GRADING markers missing in client.js");
  process.exit(1);
}

// Extract the pure block and eval it with an exports capture. The block is
// the IIFE's inner scope, so we wrap it and pull the exports out.
let captured = null;
const sandbox = new Function(
  "exports",
  `"use strict";\n` +
    clientSrc.slice(start + "PURE-GRADING-START".length, end) +
    `\nexports._capture = { grade, norm, eq, eqList };`,
);
sandbox((captured = {}));
const { grade, eq, eqList } = captured._capture;

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    console.error(`FAIL - ${name}`);
    failures += 1;
  }
}

// ---- select ----
check("select: correct index", grade({ type: "select", answer: 2 }, 2) === true);
check("select: wrong index", grade({ type: "select", answer: 2 }, 1) === false);

// ---- order ----
check(
  "order: exact order",
  grade({ type: "order", answer: ["Intake", "Triage", "Ground", "Route", "Converge", "Verify", "Record"] },
    ["Intake", "Triage", "Ground", "Route", "Converge", "Verify", "Record"]) === true,
);
check(
  "order: wrong order",
  grade({ type: "order", answer: ["Intake", "Ground", "Triage"] }, ["Intake", "Triage", "Ground"]) === false,
);
check(
  "order: missing items",
  grade({ type: "order", answer: ["a", "b", "c"] }, ["a", "b"]) === false,
);

// ---- match ----
const pairs = [
  { left: "guides", right: "feedforward" },
  { left: "sensors", right: "feedback" },
  { left: "guardrails", right: "policy" },
];
check(
  "match: all correct",
  grade({ type: "match", pairs }, new Map([[0, "feedforward"], [1, "feedback"], [2, "policy"]])) === true,
);
check(
  "match: one wrong",
  grade({ type: "match", pairs }, new Map([[0, "feedback"], [1, "feedforward"], [2, "policy"]])) === false,
);
check(
  "match: incomplete",
  grade({ type: "match", pairs }, new Map([[0, "feedforward"]])) === false,
);

// ---- complete ----
check(
  "complete: exact",
  grade({ type: "complete", answer: ["the Living Tribunal", "convergence"] },
    ["the Living Tribunal", "convergence"]) === true,
);
check(
  "complete: swapped order",
  grade({ type: "complete", answer: ["the Living Tribunal", "convergence"] },
    ["convergence", "the Living Tribunal"]) === false,
);

// ---- listen / diacritics / locale ----
check("listen: exact", grade({ type: "listen", text: "The value is discipline, not machinery." }, "the value is discipline not machinery") === true);
check("listen: case/punct-insensitive", grade({ type: "listen", text: "Session, disposable!" }, "session disposable") === true);
check("eq: diacritic-insensitive", eq("café", "cafe") === true);
check("eq: trailing space tolerant", eq(" hub  ", "hub") === true);

console.log(failures ? `\n${failures} failure(s)` : "\nall grade tests passed");
process.exit(failures ? 1 : 0);
