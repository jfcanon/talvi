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
//   Client→server:  {t:"cmd", cmd:"write"|"read"|"ls", path, data?}
//   Server→client:  {t:"ready"}
//                   {t:"ok", cmd, result}
//                   {t:"err", code}        — "toolarge" | "badcmd" | "badpath"
//                                            | "io"
//
// Bounds mirror chat's (D11): origin-gated upgrade, socket cap, wire-frame
// cap. NOTHING HERE LOGS content — the workspace files are the record, not
// the logs.
import { withWorkspace, getWorkspace } from "@cloudflare/computer";

const MAX_SOCKETS = 16; // open sockets per agent — bounds memory
const MAX_WIRE_BYTES = 64 * 1024; // per-frame ceiling, UTF-8 bytes
const WORKSPACE_ROOT = "/workspace";

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
      const ws = await getWorkspace(this);
      await ws.fs.mkdir(WORKSPACE_ROOT, { recursive: true }).catch(() => {});
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
      console.log("agent msg", event.data.slice(0, 80));
      try {
        await this.handleFrame(server, ws, event.data);
        console.log("agent frame done");
      } catch (err) {
        console.log("agent fault", String(err?.message ?? err).slice(0, 120));
        this.send(server, { t: "err", code: "fault", detail: String(err?.message ?? err).slice(0, 120) });
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
      } else {
        this.send(server, { t: "err", code: "badcmd" });
      }
    } catch (err) {
      this.send(server, { t: "err", code: "io" });
    }
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

// Paths are absolute, inside the workspace root, and must not escape it. The
// fs surface already rejects absolute escapes; this is the routing gate.
function isWorkspacePath(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith(WORKSPACE_ROOT)) return false;
  if (p.includes("..")) return false;
  return true;
}
