// PR logic test (PR3b): exercise the GitHub Contents+Pulls flow that brain.js
// implements, against the REAL jfcanon/customcinto repo, then clean up.
//
// Uses env.GH_TOKEN (a repo-scoped PAT) if present; otherwise the owner's gh
// auth via gh api. Creates a temp branch + PR, verifies, then closes the PR
// and deletes the branch. Safe to run; leaves only a closed PR + deleted branch.
import { execSync } from "node:child_process";

const token = process.env.GH_TOKEN;
const repo = "jfcanon/customcinto";
const branch = "agent-test-" + Date.now().toString(36);
const GH = "https://api.github.com";

function ghCli(args) {
  return JSON.parse(execSync(`gh api ${args.join(" ")}`, { encoding: "utf8" }));
}

async function ghFetch(path, options = {}) {
  const headers = { "content-type": "application/json", "user-agent": "talvi-agent", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(GH + path, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("github " + res.status + " " + JSON.stringify(json).slice(0, 200));
  return json;
}

let failures = 0;
function check(name, ok, detail = "") { console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : "")); if (!ok) failures++; }

try {
  const baseRef = await ghFetch(`/repos/${repo}/git/ref/heads/main`);
  const baseSha = baseRef.object.sha;
  check("fetched base sha", typeof baseSha === "string" && baseSha.length === 40, baseSha);

  const blob = await ghFetch(`/repos/${repo}/git/blobs`, { method: "POST", body: { content: "agent test footer\n", encoding: "utf-8" } });
  check("created blob", typeof blob.sha === "string", blob.sha?.slice(0, 8));

  const tree = await ghFetch(`/repos/${repo}/git/trees`, { method: "POST", body: { base_tree: baseSha, tree: [{ path: "customcinto/test-agent.txt", mode: "100644", type: "blob", sha: blob.sha }] } });
  check("created tree", typeof tree.sha === "string", tree.sha?.slice(0, 8));

  const commit = await ghFetch(`/repos/${repo}/git/commits`, { method: "POST", body: { message: "agent logic test", tree: tree.sha, parents: [baseSha] } });
  check("created commit", typeof commit.sha === "string", commit.sha?.slice(0, 8));

  await ghFetch(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: "refs/heads/" + branch, sha: commit.sha } });
  check("created branch", true, branch);

  const pr = await ghFetch(`/repos/${repo}/pulls`, { method: "POST", body: { title: "agent logic test (auto-close)", head: branch, base: "main", body: "temporary" } });
  check("opened PR", typeof pr.html_url === "string", pr.html_url);

  // Cleanup: close PR + delete branch
  if (pr.number) await ghFetch(`/repos/${repo}/pulls/${pr.number}`, { method: "PATCH", body: { state: "closed" } });
  await ghFetch(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
  console.log("cleaned up (closed PR #" + pr.number + ", deleted branch)");
} catch (e) {
  check("flow completes", false, String(e.message || e));
  // best-effort cleanup
  try { await ghFetch(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }); } catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
