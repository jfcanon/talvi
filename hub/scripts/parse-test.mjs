// Parser tests for the brain's model-output parsing (action loop).
import { parseModelOutput } from "../src/agent/brain.js";

let failures = 0;
function check(name, ok, detail = "") { console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : "")); if (!ok) failures++; }

// 1. Markdown-fenced JSON → actions (op field)
const fenced = '```json\n{"actions":[{"op":"write","path":"customcinto/x","content":"y"}]}\n```';
const r1 = parseModelOutput(fenced);
check("markdown fenced JSON parses to actions", Array.isArray(r1.actions) && r1.actions[0].op === "write");

// 2. Bare JSON actions (op field)
const good = '{"actions":[{"op":"write","path":"customcinto/footer/Footer.tsx","content":"x"},{"op":"pr","branch":"add-footer","title":"add footer"}]}';
const r2 = parseModelOutput(good);
check("json actions parsed", Array.isArray(r2.actions) && r2.actions.length === 2 && r2.actions[1].op === "pr");

// 3. Plain reply
const r3 = parseModelOutput('{"reply":"hello"}');
check("reply parsed", r3.reply === "hello");

// 4. Unknown op filtered
const bad = '{"actions":[{"op":"rm","path":"customcinto/x"},{"op":"write","path":"customcinto/a.tsx","content":"c"}]}';
const r4 = parseModelOutput(bad);
check("unknown ops filtered", r4.actions.length === 1 && r4.actions[0].op === "write");

// 5. Non-JSON prose stays a reply
const r5 = parseModelOutput("Here is some code: <div>hi</div>");
check("prose stays reply", r5.reply.startsWith("Here is some code"));

// 6. json_object mode: prose + fence + trailing text + `action` field name
const jsonmode =
  'Sure! Here it is:\n\n```json\n{"actions":[{"action":"write","path":"customcinto/footer/page.tsx","content":"<div class=\\"hud__value\\">Copyright</div>"},{"action":"pr","branch":"feature-x","title":"x"}]}\n```\n\nLet me know!';
const r6 = parseModelOutput(jsonmode);
check("json_object mode (fence + prose + action field)", Array.isArray(r6.actions) && r6.actions.length === 2 && r6.actions[0].op === "write" && r6.actions[0].path === "customcinto/footer/page.tsx", JSON.stringify(r6.actions));

// 7. Truncated / broken JSON falls back to reply (never crashes)
const r7 = parseModelOutput('{"actions":[{"op":"write","path":"customcinto/x"');
check("truncated json falls back safely", typeof r7.reply === "string");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
