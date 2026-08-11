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

export const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
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
    "To DO something, reply with ONLY a JSON object, no markdown fences, no " +
    "prose around it. Two shapes: {\"reply\":\"...\"} to just talk, or " +
    "{\"actions\":[{\"op\":\"write\",\"path\":\"customcinto/<feature>/<file>\",\"content\":\"...\"}]} " +
    "to write a file, and/or {\"actions\":[{\"op\":\"pr\",\"branch\":\"<branch>\",\"title\":\"<title>\"}]} " +
    "to open a pull request shipping everything staged under customcinto/. " +
    "All paths must start with customcinto/. You CANNOT run code, build, or " +
    "typecheck; do not claim you did. Keep replies short. " +
    "Never ask for secrets or tokens."
  );
}

// Parse the model's reply into either plain text or a list of actions.
// Returns { reply } or { actions }. Tolerates a single markdown code fence
// around the JSON; otherwise falls back to treating the whole output as a
// reply if it is not valid JSON in the expected shape.
export function parseModelOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { reply: "" };
  // Strip ```json … ``` (or ``` … ```) around the payload if present.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { reply: trimmed };
  }
  if (typeof parsed?.reply === "string") return { reply: parsed.reply };
  if (Array.isArray(parsed?.actions)) {
    const actions = parsed.actions
      .slice(0, MAX_ACTIONS)
      .filter((a) => a && typeof a === "object" && (a.op === "write" || a.op === "pr"));
    if (actions.length) return { actions };
  }
  return { reply: trimmed };
}

export async function chat(env, ws, message, runAction) {
  if (!env.AI) return { t: "err", code: "noai" };
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  try {
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: message },
    ];

    let results = await env.AI.run(model, { messages });
    let text = String(results?.response ?? "").trim();
    if (!text) return { t: "err", code: "empty" };

    // The free 8B model truncates long JSON action blocks. If the output
    // looks like an incomplete JSON action payload, retry ONCE with a nudge
    // to finish it — then fall back to the text reply. One retry bounds cost.
    if (looksLikeTruncatedActions(text)) {
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

// Heuristic: the model started emitting an actions array but the reply is
// not complete JSON — either it ends inside the array, or JSON.parse of the
// candidate failed while the raw text mentions "actions". Cheap, bounded.
function looksLikeTruncatedActions(text) {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  if (!candidate.startsWith("{") || !candidate.includes('"actions"')) return false;
  try {
    JSON.parse(candidate);
    return false; // valid JSON — parseModelOutput will handle it
  } catch {
    return true; // started actions JSON but invalid → truncated
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
