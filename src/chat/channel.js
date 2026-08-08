// ChatChannel — one Durable Object per channel name.
//
// PR1 scope: WebSocket relay only. Sessions live in memory; the object relays
// each incoming frame to every other connected socket. No gate, no nick
// handling, no storage — later PRs layer those on top.
//
// Deliberately NON-hibernatable (decision D2, plans/talvi-chat-blueprint.md):
// the classic accept()+listeners shape keeps this object alive exactly while
// members are connected, and every field dies on eviction. The canonical
// workers-chat-demo uses the Hibernation API plus state.storage because it
// persists history; this app's whole point is that it does not — so the
// simpler shape is the correct one here, not a shortcut.

// Per-frame ceiling (refined into the full bounds set in PR2).
const MAX_WIRE_BYTES = 4096;

export class ChatChannel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> session object (empty in PR1)
  }

  // The Worker routes /chat/<name>/ws here. Only WebSocket upgrades are valid.
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(server) {
    server.accept();
    this.sessions.set(server, {});

    server.addEventListener("message", (event) => {
      // Text frames only for now; binary frames are dropped.
      if (typeof event.data !== "string") return;
      if (event.data.length > MAX_WIRE_BYTES) return; // full bounds in PR2
      this.broadcast(event.data, server);
    });

    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });
    server.addEventListener("error", () => {
      this.sessions.delete(server);
    });
  }

  broadcast(text, except) {
    for (const [ws] of this.sessions) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // send() failed means this socket is already past the close/error
        // events — drop it from the roster so it stops receiving.
        this.sessions.delete(ws);
      }
    }
  }
}
