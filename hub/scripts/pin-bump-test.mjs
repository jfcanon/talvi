// Test openCintoPinPR against the real jfcanon/cinto, then clean up.
// Uses GH_TOKEN (owner's gh auth token) like pr-logic-test. Creates a temp
// branch + PR, verifies package.json pin bumped, then closes + deletes.
import { execSync } from "node:child_process";
import { openCintoPinPR } from "../src/agent/brain.js";

const token = process.env.GH_TOKEN;
if (!token) { console.log("SKIP: GH_TOKEN not set"); process.exit(0); }

let failures = 0;
function check(name, ok, detail = "") { console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : "")); if (!ok) failures++; }

const env = {
  GITHUB_TOKEN: token,
  AI: null,
  CINTO_REPO: "jfcanon/cinto",
};

const headSha = "50d3abad298270802eafec9699ee17ac193899b0"; // a real customcinto commit
const fakeFeatureUrl = "https://github.com/jfcanon/customcinto/pull/FAKE";

const out = await openCintoPinPR(env, { headSha, featurePrUrl: fakeFeatureUrl });
check("pin-bump PR opened", out.t === "ok", JSON.stringify(out).slice(0, 120));
if (out.t === "ok") {
  // Verify the PR's package.json actually points at headSha.
  const prNum = out.result.split("/").pop();
  const branch = "chore/customcinto-" + headSha.slice(0, 8);
  const content = execSync(`gh api "repos/jfcanon/cinto/contents/package.json?ref=${branch}" --jq .content`, { encoding: "utf8" }).trim();
  const pkg = Buffer.from(content, "base64").toString("utf8");
  check("pin points at headSha", pkg.includes("archive/" + headSha + ".tar.gz"), "pkg has " + headSha.slice(0, 8));
  check("old pin gone", !pkg.includes("75b9b474"), "old sha still present");
  // cleanup
  execSync(`gh pr close ${prNum} --repo jfcanon/cinto --comment "pin-bump logic test — cleaning up" --delete-branch`, { stdio: "inherit" });
  console.log("cleaned up PR #" + prNum);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
