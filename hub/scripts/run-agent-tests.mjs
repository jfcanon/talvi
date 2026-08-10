// Bundles + runs the agent logic test. The @cloudflare/computer package
// imports cloudflare:workers, which Node cannot load directly, so esbuild
// bundles the test with that module aliased to a stub. Pure-value assertions
// only — the fs protocol, path gating, and error codes.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "agent-logic-test.mjs");
const out = join(here, "agent-logic-test.bundle.mjs");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  alias: { "cloudflare:workers": join(here, "cf-workers-stub.mjs") },
  logLevel: "warning",
  outfile: out,
});

const result = spawnSync(process.execPath, [out], { stdio: "inherit" });
process.exit(result.status ?? 1);
