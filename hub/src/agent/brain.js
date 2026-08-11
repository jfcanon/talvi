// The agent's brain (PR3b) — direct Workers AI, no heavy agent framework.
//
// Two capabilities, both reached from the panel protocol:
//
//   1. `chat` — natural language. Sends the user's message (plus a system
//      prompt that grounds the model in the workspace + customcinto context)
//      to a free Workers AI model via env.AI.run(). Returns the reply. The
//      model is a plain text assistant: it may WRITE a feature for the user,
//      and the `pr` command ships it. There is no autonomous tool loop yet
//      (that needs @cloudflare/think + a paid model — see blueprint PR3).
//
//   2. `pr` — the contractor step. Commits files from the workspace into
//      jfcanon/customcinto via the GitHub Contents + Pulls API and opens a
//      PR. The repo-scoped token lives in env.GITHUB_TOKEN (a Cloudflare
//      secret), is never written to the workspace (D10), and is invoked only
//      by this controlled function.
//
// The model and repo are deliberately configurable via env with safe
// defaults, so nothing about this file hardcodes a paid model or a foreign
// repository.
import { isWorkspacePath, WORKSPACE_ROOT } from "./paths.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const CUSTOMCINTO_REPO = "jfcanon/customcinto";
export const CUSTOMCINTO_BASE = "main";

// The system prompt grounds the model in what it can actually do. Keep it
// minimal and truthful: it can read/write the workspace via the panel
// commands, and the user ships features via `pr`. It cannot run code, and it
// must never claim otherwise.
export function systemPrompt() {
  return (
    "You are the talvi agent inside the customcinto surface. " +
    "You can propose code and files for the /customcinto feature surface, " +
    "and the user writes them into the workspace and ships them with `pr`. " +
    "You CANNOT run code, build, or typecheck. " +
    "Do not claim you executed anything. " +
    "Keep replies short and practical. " +
    "Do not invent file contents beyond what the user asked for. " +
    "Never ask for secrets or tokens."
  );
}

export async function chat(env, ws, message) {
  if (!env.AI) return { t: "err", code: "noai" };
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  try {
    const results = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: message },
      ],
    });
    const text = String(results?.response ?? "").trim();
    if (!text) return { t: "err", code: "empty" };
    return { t: "ok", cmd: "chat", result: text };
  } catch (err) {
    // Surface the failure mode (not content) so the panel can report it.
    return { t: "err", code: "ai", detail: String(err?.message ?? err).slice(0, 120) };
  }
}

// Ship workspace files to customcinto as a PR.
//
// Flow (GitHub REST, token = env.GITHUB_TOKEN):
//   1. GET  /repos/{repo}/git/ref/heads/{base}          → base SHA
//   2. GET  /repos/{repo}/git/trees/{sha}?recursive=1   → current tree
//   3. POST /repos/{repo}/git/blobs                     → blob SHA per file
//   4. POST /repos/{repo}/git/trees                     → new tree (subtree)
//   5. POST /repos/{repo}/git/commits                   → commit
//   6. POST /repos/{repo}/git/refs                      → branch
//   7. POST /repos/{repo}/pulls                         → PR
//
// Paths are restricted to the customcinto route-group subtree
// (customcinto/...) so the agent can never touch cinto's engine or data
// model. The caller passes the workspace files it wants to ship as
// { relPath: content } pairs.
const GH = "https://api.github.com";

async function gh(env, path, options = {}) {
  const res = await fetch(GH + path, {
    method: options.method || "GET",
    headers: {
      authorization: "Bearer " + env.GITHUB_TOKEN,
      "content-type": "application/json",
      "user-agent": "talvi-agent",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("github " + res.status + " " + JSON.stringify(json).slice(0, 200));
  }
  return json;
}

function normalizeFiles(files) {
  // Restrict to the customcinto route-group subtree and drop anything else.
  const out = {};
  for (const [rel, content] of Object.entries(files)) {
    if (!rel.startsWith("customcinto/") || rel.split("/").includes("..")) continue;
    if (typeof content !== "string") continue;
    out[rel] = content;
  }
  return out;
}

export async function openCustomCintoPR(env, { branch, title, body, files }) {
  const repo = env.CUSTOMCINTO_REPO || CUSTOMCINTO_REPO;
  const base = env.CUSTOMCINTO_BASE || CUSTOMCINTO_BASE;
  const clean = normalizeFiles(files);
  if (Object.keys(clean).length === 0) {
    return { t: "err", code: "nofiles" };
  }

  const baseRef = await gh(env, `/repos/${repo}/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha;

  // Build a tree of just the files being changed, as blobs.
  const entries = [];
  for (const [rel, content] of Object.entries(clean)) {
    const blob = await gh(env, `/repos/${repo}/git/blobs`, {
      method: "POST",
      body: { content, encoding: "utf-8" },
    });
    entries.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await gh(env, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseSha, tree: entries },
  });

  const commit = await gh(env, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: { message: title, tree: tree.sha, parents: [baseSha] },
  });

  await gh(env, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: "refs/heads/" + branch, sha: commit.sha },
  });

  const pr = await gh(env, `/repos/${repo}/pulls`, {
    method: "POST",
    body: { title, head: branch, base, body },
  });

  return { t: "ok", cmd: "pr", result: pr.html_url };
}
