// Test parseModelOutput against real model outputs.
import { parseModelOutput } from "../src/agent/brain.js";

let failures = 0;
function check(name, ok, detail = "") { console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : "")); if (!ok) failures++; }

// 1. The exact reply from the live test (markdown-fenced JSON — should fall back to reply)
const fenced = '```json\n{"actions":[{"op":"write","path":"customcinto/x","content":"y"}]}\n```';
const r1 = parseModelOutput(fenced);
check("markdown fenced JSON parses to actions", Array.isArray(r1.actions) && r1.actions[0].op === "write", JSON.stringify(r1).slice(0,80));

// 2. Plain JSON actions (the good case)
const good = '{"actions":[{"op":"write","path":"customcinto/footer/Footer.tsx","content":"x"},{"op":"pr","branch":"add-footer","title":"add footer"}]}';
const r2 = parseModelOutput(good);
check("json actions parsed", Array.isArray(r2.actions) && r2.actions.length === 2 && r2.actions[1].op === "pr", JSON.stringify(r2.actions));

// 3. Plain reply
const r3 = parseModelOutput('{"reply":"hello"}');
check("reply parsed", r3.reply === "hello");

// 4. Unknown op filtered out
const bad = '{"actions":[{"op":"rm","path":"customcinto/x"},{"op":"write","path":"customcinto/a.tsx","content":"c"}]}';
const r4 = parseModelOutput(bad);
check("unknown ops filtered", r4.actions.length === 1 && r4.actions[0].op === "write", JSON.stringify(r4.actions));

// 5. Non-JSON prose stays a reply
const r5 = parseModelOutput("Here is some code: <div>hi</div>");
check("prose stays reply", r5.reply.startsWith("Here is some code"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
