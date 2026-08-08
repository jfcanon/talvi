// One command that proves chat works on a given host.
//
//   node scripts/chat-verify.mjs                        # the live worker
//   node scripts/chat-verify.mjs https://green.example  # a blue/green candidate
//   node scripts/chat-verify.mjs <host> --full          # adds the 65-socket cap test
//
// WHY THIS EXISTS: chat was silently broken in production once already. A
// sign-in refactor extracted a function and dropped a variable from scope, and
// every UI route — including /chat — started returning 500. Nothing caught it,
// because the chat checks only ran when the chat code changed. The failure had
// nothing to do with chat and everything to do with the building around it.
//
// So this is deliberately runnable against ANY host, before a cutover rather
// than after: point it at the green deployment, get an exit code, then switch.
// A deploy that cannot pass this is not a deploy worth pointing traffic at.
//
// Every case runs on a freshly named channel. A Durable Object is created on
// first use and dies when its last member leaves, so these leave nothing
// behind — no cleanup step, nothing to collide with a parallel run.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const smoke = join(here, "chat-ws-smoke.mjs");

const args = process.argv.slice(2);
const full = args.includes("--full");
const base = (args.find((a) => !a.startsWith("--")) ?? "https://talvi-web.ygdcbtmc4u.workers.dev")
  .replace(/\/+$/, "");

// http(s) in, ws(s) out — the caller names the host the way they'd visit it.
const wsBase = base.replace(/^http/, "ws");
const fresh = (p) => `${wsBase}/chat/${p}${randomBytes(5).toString("hex")}/ws`;

function run(label, argv, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [smoke, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ label, ok: code === 0, code, out });
    });
  });
}

const oversize = JSON.stringify({ t: "msg", d: "x".repeat(5000) });

const cases = [
  ["relay both directions", [fresh("v"), "--pair"]],
  ["oversize frame refused", [fresh("v"), "probe", "--raw", oversize, "--expect-error", "toolarge"]],
  ["PIN gate + lockout", [fresh("g"), "--gate-test"]],
  ["end-to-end encryption", [fresh("e"), "--e2e-test"]],
];
if (full) cases.push(["member cap (64) + 1013", [fresh("c"), "--cap-test", "65"], 180000]);

console.log(`chat verification → ${base}\n`);

const results = [];
for (const [label, argv, timeout] of cases) {
  process.stdout.write(`  ${label} … `);
  const r = await run(label, argv, timeout);
  console.log(r.ok ? "pass" : `FAIL (exit ${r.code})`);
  if (!r.ok) console.log(r.out.split("\n").filter(Boolean).slice(-6).map((l) => "      " + l).join("\n"));
  results.push(r);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (!full) console.log("(run with --full to include the 65-socket member-cap test)");

if (failed.length) {
  console.error("FAILED: " + failed.map((r) => r.label).join(", "));
  process.exit(1);
}
