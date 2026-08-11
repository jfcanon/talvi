// AgentDO — the agent's front door (blueprint PR2).
//
// One Durable Object per agent, created on first use (getByName semantics).
// The object owns a @cloudflare/computer Workspace — in PR2 a filesystem-only
// workspace (no exec backend yet): the whole point is to prove the fs
// round-trip through the chat panel before the sandbox (PR3) and the PR path
// (PR4) land.
//
// The WS protocol is the agent's chat surface. PR2 ships a tiny command loop —
// write/read/ls — so "write a note" genuinely lands in the workspace and
// "read it back" round-trips through the DO. This is the smallest thing that
// proves the DO + workspace + panel wiring; the AI brain and exec come later.
//
// Wire protocol (JSON frames):
//   Client→server:  {t:"cmd", cmd:"write"|"read"|"ls"|"chat"|"pr", path, data?}
//   Server→client:  {t:"ready"}
//                   {t:"ok", cmd, result}
//                   {t:"err", code}        — "toolarge" | "badcmd" | "badpath"
//                                            | "io" | "noai" | "empty"
//
//   chat <message>   — natural language → Workers AI (free model). The model
//                      is grounded in the workspace/customcinto context and
//                      may PROPOSE code, but never runs anything (PR3b).
//   pr <branch> <title> [files...] — open a PR on jfcanon/customcinto. Files
//                      are read from the workspace subtree and shipped via
//                      the GitHub API (PR4). See src/agent/brain.js.
//
// Bounds mirror chat's (D11): origin-gated upgrade, socket cap, wire-frame
// cap. NOTHING HERE LOGS content — the workspace files are the record, not
// the logs.
import { withWorkspace, getWorkspace } from "@cloudflare/computer";
import { isWorkspacePath, WORKSPACE_ROOT } from "./paths.js";
import { chat, openCustomCintoPR } from "./brain.js";

const MAX_SOCKETS = 16; // open sockets per agent — bounds memory
const MAX_WIRE_BYTES = 64 * 1024; // per-frame ceiling, UTF-8 bytes
const MAX_ACTION_CONTENT = 32 * 1024; // per-file bytes the model may author

// Origin gate — structural, same as chat: a browser's WS upgrade always sends
// Origin, and it must match the host the request arrived on. Absent Origin is
// allowed (non-browser clients are permitted for smoke tests).
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  let host = request.headers.get("Host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }
  return originHost === host;
}

class AgentBase {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

const WrappedAgent = withWorkspace(AgentBase, (self) => ({
  storage: self.ctx.storage,
}));

export class AgentDO extends WrappedAgent {
  constructor(ctx, env) {
    super(ctx, env);
    this.sockets = new Set();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!sameOrigin(request)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.sockets.size >= MAX_SOCKETS) {
      return new Response("agent busy", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(server) {
    server.accept();
    this.sockets.add(server);

    try {
      // getWorkspace(this) resolves the local Workspace and awaits ready()
      // internally (the client surface has fs/runtime/git — no ready()). The
      // workspace root must exist before the first write; idempotent.
      //
      // Stored on the instance, NOT captured in the message-listener closure:
      // esbuild's minifier hit a genuine name-collision bug renaming a closure
      // variable shared with three.js's `ws` class (the deployed bundle
      // referenced an undefined `ws` at the call site). A property access
      // mangles consistently.
      this.ws = await getWorkspace(this);
      await this.ws.fs.mkdir(WORKSPACE_ROOT, { recursive: true }).catch(() => {});
      server.send(JSON.stringify({ t: "ready" }));
    } catch (err) {
      // Surface the failure to the client instead of hanging: close 4401 with
      // a code in the reason so a smoke client can report the DO's init error.
      try {
        server.close(4401, "agent init failed: " + String(err?.message ?? err).slice(0, 120));
      } catch {
        server.close(4401);
      }
      this.drop(server);
      return;
    }

    server.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;
      if (new TextEncoder().encode(event.data).length > MAX_WIRE_BYTES) {
        this.send(server, { t: "err", code: "toolarge" });
        return;
      }
      try {
        await this.handleFrame(server, this.ws, event.data);
      } catch (err) {
        // handleFrame is fully guarded; a listener-level fault is a bug. Report
        // the code without content — the workspace files are the record, never
        // the logs (the DO's no-logging contract).
        this.send(server, { t: "err", code: "fault" });
      }
    });

    server.addEventListener("close", () => this.drop(server));
    server.addEventListener("error", () => this.drop(server));
  }

  async handleFrame(server, ws, raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // not ours; drop silently, never crash the agent
    }
    if (frame?.t !== "cmd") return;

    const { cmd, path } = frame;
    if (cmd === "write" && typeof frame.data !== "string") {
      this.send(server, { t: "err", code: "badpath" });
      return;
    }
    if ((cmd === "read" || cmd === "ls" || cmd === "write") && !isWorkspacePath(path)) {
      this.send(server, { t: "err", code: "badpath" });
      return;
    }

    try {
      if (cmd === "write") {
        // Create the parent directory chain before writing — writes to a
        // not-yet-existing path throw `io` otherwise. Idempotent recursive
        // mkdir; the fs surface handles it.
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        if (isWorkspacePath(parent)) {
          await ws.fs.mkdir(parent, { recursive: true }).catch(() => {});
        }
        await ws.fs.writeFile(path, frame.data);
        this.send(server, { t: "ok", cmd, result: "wrote " + path });
      } else if (cmd === "read") {
        const text = await ws.fs.readFile(path, "utf8");
        this.send(server, { t: "ok", cmd, result: text });
      } else if (cmd === "ls") {
        const entries = await ws.fs.readdir(path);
        const names = entries
          .map((e) => (e.isDirectory ? e.name + "/" : e.name))
          .join("\n");
        this.send(server, { t: "ok", cmd, result: names });
      } else if (cmd === "chat") {
        const out = await chat(this.env, ws, frame.data || "", (action) => this.runAction(action));
        this.send(server, out);
      } else if (cmd === "pr") {
        const out = await this.handlePr(frame);
        this.send(server, out);
      } else {
        this.send(server, { t: "err", code: "badcmd" });
      }
    } catch (err) {
      this.send(server, { t: "err", code: "io" });
    }
  }

  // pr — open a PR on jfcanon/customcinto. Ships EVERY file staged under
  // /workspace/customcinto/ (the route-group subtree) as the PR's diff. The
  // agent authors in the sandbox; this command turns the staged bytes into a
  // real, reviewable PR — the change-management boundary is never bypassed.
  async handlePr(frame) {
    const branch = String(frame.branch ?? "").trim();
    const title = String(frame.title ?? "").trim();
    if (!branch || !title) return { t: "err", code: "badcmd" };
    if (!this.env.GITHUB_TOKEN) return { t: "err", code: "notoken" };

    const files = {};
    const root = WORKSPACE_ROOT + "/customcinto";
    const entries = await this.walk(root);
    for (const p of entries) {
      const rel = p.slice(WORKSPACE_ROOT.length + 1);
      if (!rel.startsWith("customcinto/")) continue;
      try {
        files[rel] = await this.ws.fs.readFile(p, "utf8");
      } catch {
        return { t: "err", code: "io" };
      }
    }
    if (Object.keys(files).length === 0) return { t: "err", code: "nofiles" };

    return openCustomCintoPR(this.env, {
      branch,
      title,
      body: "Opened by the talvi agent. Review before merging.",
      files,
    });
  }

  // runAction — the model's tool loop. The chat brain may request `write`
  // (path-locked to the customcinto subtree, size-capped) and `pr`. This is
  // the controlled boundary: the model proposes, the DO executes within the
  // locked surface, and a human still reviews the resulting PR (D3/D6).
  async runAction(action) {
    if (action.op === "write") {
      const path = String(action.path ?? "").trim();
      const content = String(action.content ?? "");
      // The model may only author inside /workspace/customcinto/<feature>/…
      if (!isWorkspacePath(path)) return { t: "err", code: "badpath" };
      const rel = path.slice(WORKSPACE_ROOT.length + 1);
      if (!rel.startsWith("customcinto/") || rel === "customcinto") {
        return { t: "err", code: "badpath" };
      }
      if (new TextEncoder().encode(content).length > MAX_ACTION_CONTENT) {
        return { t: "err", code: "toolarge" };
      }
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (isWorkspacePath(parent)) {
        await this.ws.fs.mkdir(parent, { recursive: true }).catch(() => {});
      }
      await this.ws.fs.writeFile(path, content);
      return { t: "ok", result: "wrote " + rel };
    }
    if (action.op === "pr") {
      const branch = String(action.branch ?? "").trim();
      const title = String(action.title ?? "").trim();
      if (!branch || !title) return { t: "err", code: "badcmd" };
      return this.handlePr({ branch, title });
    }
    return { t: "err", code: "badcmd" };
  }

  // Recursively list every file under a workspace path.
  async walk(path) {
    const out = [];
    const entries = await this.ws.fs.readdir(path).catch(() => []);
    for (const e of entries) {
      const full = path.replace(/\/$/, "") + "/" + e.name;
      if (e.isDirectory) out.push(...(await this.walk(full)));
      else out.push(full);
    }
    return out;
  }

  send(server, frame) {
    try {
      server.send(JSON.stringify(frame));
    } catch {
      // socket gone mid-send; the close listener drops it
    }
  }

  drop(server) {
    this.sockets.delete(server);
  }
}
