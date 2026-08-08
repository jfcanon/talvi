// ChatChannel — one Durable Object per channel name.
//
// PR3 scope: the PIN gate on top of PR2's lifecycle. A channel is either open
// (no gate, plaintext relay — D10) or gated: its first joiner installs an
// `H_gate` value derived in their browser from the PIN (D6), and every later
// joiner must answer a fresh nonce with HMAC-SHA256(H_gate, nonce) before the
// object will treat them as a member (D7).
//
// The server never sees the PIN, and never can: H_gate is two KDF steps away
// from it, and the encryption key (PR4) is a sibling of H_gate that the server
// is never sent at all.
//
// Wire protocol (blueprint §3):
//   Client→server:  {t:"join", nick}                 — open channel
//                   {t:"join", nick, setgate:<hex>}  — create a gated channel
//                   {t:"join", nick, gate:<hex>}     — answer to a challenge
//                   {t:"msg", d}                     — plaintext message
//   Server→client:  {t:"challenge", nonce}           — gated channels only
//                   {t:"ready"}                      — join accepted
//                   {t:"msg", from, d}               — relayed message
//                   {t:"join", nick} / {t:"leave", nick}
//                   {t:"error", code}                — "full" | "toolarge"
//                                                      "badnick" | "notfirst"
//
// Deliberately NON-hibernatable (D2): classic accept()+listeners keeps the
// object alive exactly while members are connected, and every field dies on
// eviction — including the gate. The canonical workers-chat-demo uses
// Hibernation + state.storage because it persists history; this app's whole
// point is that it does not. Zero state.storage writes: even though the free
// plan forced a SQLite-backed namespace (main.tf PR1b), we never write, so
// "channel dies when last member leaves" is literal.
//
// NOTHING HERE LOGS. Not the gate, not a nonce, not a proof, not a nick, not
// an IP. The blueprint requires it (PR3 task 5) and the confidentiality claim
// leans on it — a log has a wider audience than this object.

import { isValidNick } from "./name.js";
import {
  CLOSE_GATE,
  CLOSE_GATE_REASON,
  GATE_LOCKOUT_MS,
  GATE_MAX_FAILS,
  fromHex,
  hmacHex,
  isGateHex,
  randomNonce,
  timingSafeEqualHex,
  toHex,
} from "./gate.js";

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
    this.sessions = new Map(); // WebSocket -> { nick, nonce, joining }

    // Gate state. All in memory, all gone on eviction (D4): the PIN is stored
    // nowhere, but it stays *derivable* from name+PIN, so the same PIN
    // re-gates a reclaimed name. The UI says exactly that (D13).
    this.gate = null; // Uint8Array H_gate, or null for an open channel
    this.gateFails = 0;
    this.lockedUntil = 0;
  }

  // The Worker routes /chat/<name>/ws here. Only WebSocket upgrades are valid.
  //
  // The upgrade ALWAYS succeeds for a well-formed request (D8): whether a
  // channel exists, whether it is gated, and whether it is locked out are all
  // invisible here. Only the gate exchange can refuse, and it refuses
  // uniformly. Otherwise this endpoint would be an oracle for probing which
  // channel names are live.
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
    const session = { nick: null, nonce: null, joining: false };
    this.sessions.set(server, session);

    // Gated channel: challenge immediately, so the client can derive its
    // answer while the user is still looking at the page. An open channel
    // sends nothing and the client just joins (D10).
    if (this.gate) this.challenge(server, session);

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

  challenge(ws, session) {
    const nonce = randomNonce();
    session.nonce = nonce;
    this.send(ws, { t: "challenge", nonce: toHex(nonce) });
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

    // join() awaits an HMAC, so a second frame can arrive mid-verification.
    // Without this guard that frame would re-enter join() (nick is still
    // null) and one socket could join twice.
    if (session.joining) return;

    if (!session.nick) {
      session.joining = true;
      this.join(ws, session, frame)
        .catch(() => {
          // join() awaits WebCrypto. If that ever rejects, the socket would
          // otherwise sit unjoined and silent forever with an unhandled
          // rejection behind it. Close it, and — on a gated channel — close it
          // with the SAME code as every other refusal, so a crash cannot
          // become the one response that says "this channel is gated".
          if (this.gate) this.refuseGate(ws);
          else ws.close(1011, "internal error");
        })
        .finally(() => {
          session.joining = false;
        });
      return;
    }
    if (frame?.t === "msg" && typeof frame.d === "string") {
      if (frame.d.length === 0) return;
      this.broadcast({ t: "msg", from: session.nick, d: frame.d }, ws);
    }
    // Anything else from a joined socket is dropped.
  }

  async join(ws, session, frame) {
    if (frame?.t !== "join" || !isValidNick(frame.nick)) {
      this.send(ws, { t: "error", code: "badnick" });
      ws.close(1008, "bad nick"); // RFC 6455 policy violation
      return;
    }

    if (this.gate) {
      if (!(await this.passesGate(ws, session, frame))) return;
    } else if (frame.setgate !== undefined) {
      if (!this.installGate(ws, frame.setgate)) return;
    }

    if (this.memberCount() >= MAX_MEMBERS) {
      this.send(ws, { t: "error", code: "full" });
      ws.close(1013, "channel full"); // try again later (RFC 6455 overloaded)
      return;
    }

    session.nick = frame.nick;
    session.nonce = null; // spent; never reused
    this.send(ws, { t: "ready" });
    // Roster replay: every existing member announces itself to the newcomer.
    for (const [other, s] of this.sessions) {
      if (other !== ws && s.nick) this.send(ws, { t: "join", nick: s.nick });
    }
    this.broadcast({ t: "join", nick: frame.nick }, ws);
  }

  // D9 first-joiner-sets-gate. Only a joiner who finds the channel EMPTY may
  // install a gate — otherwise a latecomer could seize an open conversation
  // and lock its existing members out on their next reconnect.
  //
  // Refusing is loud on purpose: the creator asked for a PIN channel, and
  // quietly joining them to an open one would hand them a confidentiality
  // guarantee that does not exist. Better a visible "pick another name".
  installGate(ws, setgate) {
    if (!isGateHex(setgate) || this.memberCount() > 0) {
      this.send(ws, { t: "error", code: "notfirst" });
      ws.close(1008, "cannot set gate");
      return false;
    }
    this.gate = fromHex(setgate);
    return true;
  }

  // D7 challenge-response + D8 lockout. Every refusal below closes with the
  // SAME code and the SAME reason: a caller cannot distinguish a wrong PIN
  // from a malformed frame from a locked-out channel.
  async passesGate(ws, session, frame) {
    if (Date.now() < this.lockedUntil) {
      this.refuseGate(ws);
      return false;
    }

    // A join frame carrying NO gate field at all is not a failed attempt — it
    // is a client that has not seen a challenge yet. Two ways that happens:
    // the socket connected before the gate existed (never challenged), or its
    // join frame and our challenge crossed on the wire, which is the ordinary
    // case since the client sends join as soon as it opens. Answer with a
    // challenge and charge nothing.
    //
    // A WRONG answer is a different thing entirely and does count (below).
    // The distinction is safe: replaying this path teaches a caller only that
    // the channel is gated, which the challenge itself already says, and it
    // neither resets nor evades the lockout counter.
    if (frame.gate === undefined || !session.nonce) {
      this.challenge(ws, session);
      return false;
    }

    if (!isGateHex(frame.gate)) {
      this.failGate(ws);
      return false;
    }
    const expected = await hmacHex(this.gate, session.nonce);
    if (!timingSafeEqualHex(frame.gate, expected)) {
      this.failGate(ws);
      return false;
    }

    this.gateFails = 0; // a correct answer clears the streak
    return true;
  }

  // D8: five misses arm a 60 s backoff for the whole channel.
  //
  // Per-channel, not per-socket, because per-socket is no bound at all — a
  // guesser just reconnects. The cost, accepted and recorded (D12): anyone who
  // knows the channel name can wedge it shut for 60 s at a time by failing on
  // purpose. Against an unguessable name (D9) that is a nuisance available to
  // someone already invited, not a way in.
  failGate(ws) {
    this.gateFails += 1;
    if (this.gateFails >= GATE_MAX_FAILS) {
      this.lockedUntil = Date.now() + GATE_LOCKOUT_MS;
      this.gateFails = 0;
    }
    this.refuseGate(ws);
  }

  refuseGate(ws) {
    ws.close(CLOSE_GATE, CLOSE_GATE_REASON);
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

  // Relay to every JOINED member except the sender. Unjoined sockets — which
  // includes every socket still facing a challenge — see nothing at all.
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
