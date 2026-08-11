// The agent's brain (PR3b) — direct Workers AI, no heavy agent framework.
//
// Two capabilities, both reached from the panel protocol:
//
//   1. `chat` — natural language with a CONSTRAINED tool loop. The model is
//      told it may reply as JSON with a list of actions it wants to take:
//        { "reply": "..." }                                   — just talk
//        { "actions": [ {"op":"write", "path": "...", "content":"..."} ] }
//        { "actions": [ {"op":"pr", "branch":"...", "title":"..."} ] }
//      The DO executes those actions directly (path-locked to the customcinto
//      subtree; no code execution, no new deps). This is what makes "add a
//      copyright footer" a single exchange instead of the model punting the
//      file-write back to the user.
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

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const CUSTOMCINTO_REPO = "jfcanon/customcinto";
export const CUSTOMCINTO_BASE = "main";

const MAX_ACTIONS = 8; // model may request at most this many ops per turn
const MAX_ACTION_CONTENT = 32 * 1024; // per-file bytes the model may write

// The system prompt grounds the model in what it can actually do: it may
// PROPOSE files, and — via the JSON action protocol — write them into the
// customcinto subtree and open a PR. It cannot run code. Style guidance
// anchors it to customcinto's actual instrument UI (cinto's CSS classes),
// not Tailwind or an invented design language.
export function systemPrompt() {
  return (
    "You are the talvi agent inside the customcinto surface. " +
    "customcinto is a compliance app whose UI uses these CSS classes only: " +
    "stack, hud, hud__row, hud__cell, hud__label, hud__value, tagline, " +
    "tagline__box, muted, tiny, link. Do not use Tailwind or external styles. " +
    "To DO something, reply with exactly ONE JSON object containing a single " +
    "actions array (never multiple objects, never multiple arrays): " +
    "{\"reply\":\"...\"} to just talk, or {\"actions\":[{\"op\":\"write\",\"path\":\"customcinto/<feature>/<file>\",\"content\":\"...\"}]} " +
    "to write a file, and/or {\"actions\":[{\"op\":\"pr\",\"branch\":\"<branch>\",\"title\":\"<title>\"}]} " +
    "to open pull requests shipping everything staged under customcinto/ (the " +
    "agent opens BOTH the feature PR and the cinto deploy PR — the human merges " +
    "feature first, then deploy). " +
    "Put ALL actions in that one array, in order. " +
    "You may use op or action as the field name. " +
    "All paths must start with customcinto/. You CANNOT run code, build, or " +
    "typecheck; do not claim you did. Keep replies short. " +
    "Never ask for secrets or tokens."
  );
}

// Parse the model's reply into either plain text or a list of actions.
// Returns { reply } or { actions }. Tolerant of the free models' habits:
// JSON wrapped in markdown fences, trailing prose after the fence, the field
// named `op` or `action`, and MULTIPLE separate JSON objects in one reply
// (the model occasionally emits {"actions":[…]} twice instead of one array —
// that exact output swallowed a live run). Falls back to treating the whole
// output as a reply if no valid actions JSON is found.
export function parseModelOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { reply: "" };

  let reply;
  const actions = [];
  for (const parsed of extractJsonObjects(trimmed)) {
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.reply === "string" && reply === undefined) {
        reply = parsed.reply;
      }
      actions.push(...extractActions(parsed.actions));
    }
  }
  if (actions.length) return { actions };
  if (reply !== undefined) return { reply };
  return { reply: trimmed };
}

// Extract every balanced {...} object from a string, in order. Handles a
// reply containing several separate JSON objects (and prose between them).
export function extractJsonObjects(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced; give up on the rest
    const candidate = text.slice(start, end + 1);
    try {
      out.push(JSON.parse(candidate));
    } catch {
      // not valid JSON — skip this block, keep scanning
    }
    i = end + 1;
  }
  return out;
}

function extractActions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_ACTIONS)
    .filter((a) => a && typeof a === "object")
    .map((a) => ({ ...a, op: a.op || a.action }))
    .filter((a) => a.op === "write" || a.op === "pr");
}

export async function chat(env, ws, message, runAction) {
  if (!env.AI) return { t: "err", code: "noai" };
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  try {
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: message },
    ];

    let results = await env.AI.run(model, {
      messages,
      response_format: { type: "json_object" },
    });
    let text = String(results?.response ?? "").trim();
    if (!text) return { t: "err", code: "empty" };

    // The 8B model truncates long action payloads; json_object mode on the
    // 70B model keeps them valid. If the reply still holds no parseable
    // actions/reply block, retry ONCE with a finish-it nudge — then fall
    // back to the text reply. One retry bounds cost.
    if (!parseModelOutput(text).actions && !parseModelOutput(text).reply) {
      results = await env.AI.run(model, {
        messages: [
          ...messages,
          { role: "assistant", content: text },
          {
            role: "user",
            content:
              "Your previous reply was cut off. Complete it: reply with ONLY the full JSON, finishing every action you started.",
          },
        ],
        response_format: { type: "json_object" },
      });
      text = String(results?.response ?? "").trim();
    }

    const parsed = parseModelOutput(text);
    if (parsed.actions) {
      // Execute each action via the DO's controlled runner; collect a summary.
      const lines = [];
      for (const action of parsed.actions) {
        const out = await runAction(action);
        if (out.t === "ok") lines.push(out.result);
        else lines.push("err " + (out.code || "io") + (out.detail ? " — " + out.detail : ""));
      }
      return { t: "ok", cmd: "chat", result: lines.join("\n") };
    }
    return { t: "ok", cmd: "chat", result: parsed.reply || "(no reply)" };
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

  return { t: "ok", cmd: "pr", result: pr.html_url, headSha: pr.head.sha };
}

// The deploy half of the loop. customcinto is a PINNED build dependency of
// cinto (D9a): merging a customcinto PR changes the source but the site only
// changes once cinto points its `customcinto` dep at the new SHA. This opens
// that pin-bump PR on jfcanon/cinto, so the whole flow is two merges:
//   merge customcinto PR  → feature is in the source
//   merge cinto pin PR    → cinto rebuilds from the new SHA → site updates
// The body tells the reviewer the required merge order.
export async function openCintoPinPR(env, { headSha, featurePrUrl }) {
  const repo = env.CINTO_REPO || "jfcanon/cinto";
  const base = "main";
  const short = headSha.slice(0, 8);
  const branch = "chore/customcinto-" + short;

  // Current package.json on cinto main.
  const current = await gh(env, `/repos/${repo}/contents/package.json?ref=${base}`);
  const pkg = Buffer.from(current.content, "base64").toString("utf8");
  const next = pkg.replace(
    /(archive\/)[0-9a-f]{40}(\.tar\.gz)/,
    `$1${headSha}$2`,
  );
  if (next === pkg) {
    return { t: "err", code: "pinunchanged" };
  }

  // Git-data flow on the cinto repo: blob → tree → commit → ref → PR.
  const baseRef = await gh(env, `/repos/${repo}/git/ref/heads/${base}`);
  const baseCommit = await gh(env, `/repos/${repo}/git/commits/${baseRef.object.sha}`);
  const baseTree = baseCommit.tree.sha;

  const blob = await gh(env, `/repos/${repo}/git/blobs`, {
    method: "POST",
    body: { content: next, encoding: "utf-8" },
  });
  const tree = await gh(env, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: [{ path: "package.json", mode: "100644", type: "blob", sha: blob.sha }],
    },
  });
  const commit = await gh(env, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: {
      message: `customcinto: bump pin to ${short}`,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    },
  });
  await gh(env, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: "refs/heads/" + branch, sha: commit.sha },
  });
  const pr = await gh(env, `/repos/${repo}/pulls`, {
    method: "POST",
    body: {
      title: `customcinto: bump pin to ${short}`,
      head: branch,
      base,
      body:
        "Auto-opened by the talvi agent (deploy step).\n\n" +
        "MERGE ORDER: merge the customcinto feature PR first, THEN this one. " +
        "Feature PR: " + (featurePrUrl || "(unknown)") + "\n\n" +
        "Merging this points cinto's pinned customcinto dep at the new SHA and " +
        "deploys the change to app.ygdcbtmc4u.uk/cinto/customcinto.",
    },
  });
  return { t: "ok", cmd: "deploy-pr", result: pr.html_url };
}
