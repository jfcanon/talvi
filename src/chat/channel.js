// ChatChannel — one Durable Object per channel name.
//
// PR2 scope: full channel lifecycle on top of PR1's relay. Sessions carry a
// nick; the object emits ready/join/leave roster messages and relays
// {t:"msg"} frames between members. Plaintext only (D10) — the PIN gate
// (PR3) and client crypto (PR4) layer on without changing this shape.
//
// Wire protocol (blueprint §3):
//   Client→server:  {t:"join", nick}        — first frame after open
//                   {t:"msg", d}            — plaintext message
//   Server→client:  {t:"ready"}             — join accepted, socket live
//                   {t:"msg", from, d}      — relayed message
//                   {t:"join", nick}        — a member joined (incl. roster
//                                             replay on your own ready)
//                   {t:"leave", nick}
//                   {t:"error", code}       — "full" | "toolarge" | "badnick"
//
// Deliberately NON-hibernatable (D2): classic accept()+listeners keeps the
// object alive exactly while members are connected, and every field dies on
// eviction. The canonical workers-chat-demo uses Hibernation + state.storage
// because it persists history; this app's whole point is that it does not —
// so the simpler shape is correct here, not a shortcut. Zero state.storage
// writes: even though the free plan forced a SQLite-backed namespace
// (main.tf PR1b), we never write, so the "channel dies when last member
// leaves" property is literal.

import { isValidNick } from "./name.js";

// Per-frame ceiling (D11). Measured in UTF-8 bytes, not JS string length.
const MAX_WIRE_BYTES = 4096;

// Abuse bounds, in-DO (D11). Platform ratelimit bindings are known-inert
// (RUNBOOK §8) and are NOT relied on for chat.
const MAX_MEMBERS = 64; // joined sockets per channel
const MAX_SOCKETS = 128; // any open socket (incl. never-joining) — bounds memory

// Origin gate (D11, LOW finding). Browsers always send Origin on a WS
// upgrade; a cross-origin page must be refused. Non-browser clients (curl,
// node smoke scripts) may omit Origin — that is not the browser cross-origin
// threat this check exists for, so absent Origin is allowed, present-and-
// foreign is rejected. Channel names are unguessable secrets (D9), so a
// cross-site script that does not know the name has nothing to probe here.
const ALLOWED_ORIGINS = new Set([
  "https://talvi.ygdcbtmc4u.uk",
  "https://talvi-web.ygdcbtmc4u.workers.dev",
]);

const encoder = new TextEncoder();

export class ChatChannel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { nick: string|null }
  }

  // The Worker routes /chat/<name>/ws here. Only WebSocket upgrades are valid.
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response("forbidden", { status: 403 });
    }
    // Hard cap on open sockets, join or not. A flood of connecting-but-never-
    // joining clients would otherwise pin the object with idle sockets.
    if (this.sessions.size >= MAX_SOCKETS) {
      return new Response("channel full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(server) {
    server.accept();
    this.sessions.set(server, { nick: null });

    server.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (encoder.encode(event.data).length > MAX_WIRE_BYTES) {
        this.send(server, { t: "error", code: "toolarge" });
        return;
      }
      this.handleFrame(server, event.data);
    });

    server.addEventListener("close", () => this.drop(server));
    server.addEventListener("error", () => this.drop(server));
  }

  handleFrame(ws, raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // not ours; drop silently, never crash the relay
    }
    const session = this.sessions.get(ws);
    if (!session) return;

    if (!session.nick) {
      this.join(ws, session, frame);
      return;
    }
    if (frame?.t === "msg" && typeof frame.d === "string") {
      if (frame.d.length === 0) return;
      this.broadcast({ t: "msg", from: session.nick, d: frame.d }, ws);
    }
    // Anything else from a joined socket is dropped.
  }

  join(ws, session, frame) {
    if (frame?.t !== "join" || !isValidNick(frame.nick)) {
      this.send(ws, { t: "error", code: "badnick" });
      ws.close(1008, "bad nick"); // RFC 6455 policy violation
      return;
    }
    if (this.memberCount() >= MAX_MEMBERS) {
      this.send(ws, { t: "error", code: "full" });
      ws.close(1013, "channel full"); // try again later (RFC 6455 overloaded)
      return;
    }

    session.nick = frame.nick;
    this.send(ws, { t: "ready" });
    // Roster replay: every existing member announces itself to the newcomer.
    for (const [other, s] of this.sessions) {
      if (other !== ws && s.nick) this.send(ws, { t: "join", nick: s.nick });
    }
    this.broadcast({ t: "join", nick: frame.nick }, ws);
  }

  drop(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.nick) this.broadcast({ t: "leave", nick: session.nick }, ws);
  }

  memberCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.nick) n += 1;
    return n;
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      this.sessions.delete(ws);
    }
  }

  // Relay to every JOINED member except the sender. Unjoined sockets see
  // nothing until their own join succeeds — they are not members yet.
  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const [ws, s] of this.sessions) {
      if (!s.nick || ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // send() failed means this socket is already past the close/error
        // events. drop() is the single removal point: it deletes the socket
        // AND broadcasts {t:"leave"} so nobody keeps a ghost in their roster
        // (the platform close event that would have fired drop() never does
        // once the send path hit an error first).
        this.drop(ws);
      }
    }
  }
}
