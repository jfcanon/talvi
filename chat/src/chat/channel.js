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
//   Client→server:  {t:"join", nick, id}              — open channel
//                   {t:"join", nick, id, setgate:hex} — create a gated channel
//                   {t:"join", nick, id, gate:hex}    — answer to a challenge
//                   {t:"msg", d}                      — plaintext message
//                   {t:"leave"}                       — explicit disconnect
//   Server→client:  {t:"challenge", nonce}           — gated channels only
//                   {t:"ready"}                      — join accepted
//                   {t:"history", msgs}              — replay for a new member
//                   {t:"msg", from, d}               — relayed message
//                   {t:"join", nick} / {t:"leave", nick}
//                   {t:"error", code}                — "full" | "toolarge"
//                                                      "badnick" | "notfirst"
//
// Lifecycle (owner decision 2026-08-10, presence model — blueprint
// plans/talvi-hub-auth-chat-blueprint.md A9/A9a). A dropped WebSocket is NOT
// leaving: a member's presence survives socket drops (phone lock, laptop
// sleep, minutes of inactivity) until they explicitly DISCONNECT ({t:"leave"})
// or the room's 24-hour clock ends everything. The gate, the presence roster,
// and the last 200 messages (ciphertext only — gated channels) persist in
// state.storage, and a DO alarm fires 24h after the last activity and deletes
// the room: gate, history, presence — all of it. The room also ends
// immediately when the last member disconnects.
//
// The join/gate/challenge logic below is the settled, security-reviewed code
// (PR3/D5-D8) and is deliberately UNCHANGED in behavior — persistence, the
// alarm, presence, and history are additive around it. The PIN is still
// nowhere: H_gate stays two KDF steps from it and the server never sees the
// key.
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
const MAX_MEMBERS = 64; // member PRESENCE per channel (idle members count)
const MAX_SOCKETS = 128; // any open socket (incl. never-joining) — bounds memory

// Room lifetime (owner 2026-08-10): 24h after the last activity (a message or
// a join), the alarm deletes the room. Gated history is capped at the last
// MAX_HISTORY messages.
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 200;

// A member id is client-generated (sessionStorage) and opaque. Restrict the
// shape so a malformed value never reaches storage; anything else falls back
// to a server-generated id.
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Origin gate (D11, LOW finding). Browsers always send Origin on a WS upgrade,
// so a cross-origin page must be refused. Channel names are unguessable secrets
// (D9), so a cross-site script that does not know the name has nothing to probe
// here anyway — this closes the case where it somehow does.
//
// Same-origin is checked STRUCTURALLY, against the host the request actually
// arrived on — not against a list of hostnames.
//
// This used to be a hardcoded Set of the two hosts talvi was served from, and
// that was a trap with a fuse on it: the moment the site gains a hostname the
// list does not know about — a public-release domain, a blue/green staging
// host, a preview URL — every WebSocket upgrade from that host is refused 403
// and chat dies there, silently, for those users only. Pages render fine, so
// it looks like a chat bug rather than a config one.
//
// There is nothing to configure here. The CSP already says `connect-src
// 'self'`, so a legitimate browser client's Origin is ALWAYS the site's own
// origin; comparing Origin's host to the request's own host enforces exactly
// that and is correct on every hostname, forever, including ones nobody has
// bought yet.
//
// Absent Origin stays allowed — the recorded decision from PR2. Browsers
// always send Origin on a WS upgrade, so the cross-origin threat this exists
// for is closed; curl and the node smoke clients simply are not that threat.
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // unparseable Origin is not a same-origin request
  }

  // Host header first (what the browser addressed), request.url as the
  // fallback. The Worker forwards the original Request to the stub, so both
  // are the client's, not something rewritten in between.
  let host = request.headers.get("Host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false; // no host to compare against — refuse rather than guess
    }
  }
  return originHost === host;
}

const encoder = new TextEncoder();

// A join frame is an ANSWER only if it actually carries a gate field. Absent
// is "not yet"; present-but-wrong is a failed attempt. Keeping that one
// distinction in a named helper is deliberate — conflating the two is what
// turns honest joiners into lockout fodder.
function answered(frame) {
  return frame.gate !== undefined;
}

// Envelope shape check (blueprint §3). The server cannot read an envelope and
// never tries — it only refuses to relay anything that is not shaped like one,
// so a member's client is handed either a decryptable envelope or nothing.
// Verifying the payload is the receiving CLIENT's job, and GCM does it.
//
// The ceiling is the same MAX_WIRE_BYTES the whole frame is already held to;
// this second, tighter check on `ct` alone keeps a single envelope from being
// padded out to fill the frame with fields nobody reads.
const MAX_CT_CHARS = 4096;

function isEnvelope(env) {
  return (
    env !== null &&
    typeof env === "object" &&
    env.v === 1 &&
    typeof env.iv === "string" &&
    env.iv.length === 16 && // 12 bytes, base64url, unpadded
    typeof env.ct === "string" &&
    env.ct.length > 0 &&
    env.ct.length <= MAX_CT_CHARS
  );
}

export class ChatChannel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { nick, nonce, joining, memberId }

    // Gate state. Restored from storage when a real DO (ctx.storage present);
    // in the offline tests ctx is a mock and this stays in-memory only.
    this.gate = null; // Uint8Array H_gate, or null for an open channel
    this.gateFails = 0;
    this.lockedUntil = 0;

    // Presence (owner 2026-08-10): memberId -> { nick }. A member stays here
    // after their socket drops; only an explicit DISCONNECT removes them, and
    // the room dies when this map empties or the 24h alarm fires.
    this.members = new Map();
    // Gated-channel ciphertext history (last MAX_HISTORY), replayed to a
    // genuinely new member. Open channels store none (A9a).
    this.history = [];
    this.lastActivity = null;

    this._storage = ctx.storage || null;
    this._restored = this._storage ? this._restore() : Promise.resolve();
  }

  // Load persisted room state. Called once, cached as this._restored and
  // awaited at the top of fetch() so the gate exists before any challenge.
  async _restore() {
    const [g, m, h, last] = await Promise.all([
      this._storage.get("gate"),
      this._storage.get("members"),
      this._storage.get("history"),
      this._storage.get("lastActivity"),
    ]);
    if (g) {
      this.gate = g.h ? fromHex(g.h) : null;
      this.gateFails = g.fails || 0;
      this.lockedUntil = g.lockedUntil || 0;
    }
    if (Array.isArray(m)) {
      for (const x of m) if (x && x.id) this.members.set(x.id, { nick: x.nick });
    }
    if (Array.isArray(h)) this.history = h;
    if (last) {
      this.lastActivity = last;
      // Defensive re-arm: the alarm should already be pending, but a restore
      // after an eviction must not rely on that.
      const at = new Date(last).getTime();
      if (at + ROOM_TTL_MS > Date.now()) {
        await this._storage.setAlarm(at + ROOM_TTL_MS).catch(() => {});
      }
    }
  }

  // ---- persistence (no-op in the offline tests) ----

  async _persistGate() {
    if (!this._storage) return;
    await this._storage
      .put("gate", {
        h: this.gate ? toHex(this.gate) : null,
        fails: this.gateFails,
        lockedUntil: this.lockedUntil,
      })
      .catch(() => {});
  }

  async _persistMembers() {
    if (!this._storage) return;
    await this._storage
      .put("members", [...this.members].map(([id, m]) => ({ id, nick: m.nick })))
      .catch(() => {});
  }

  async _persistHistory() {
    if (!this._storage) return;
    await this._storage.put("history", this.history).catch(() => {});
  }

  // Reset the room's 24h clock and re-arm the alarm. Called on joins and on
  // accepted messages — the two kinds of activity that keep a room alive.
  async _touchActivity() {
    if (!this._storage) return;
    this.lastActivity = new Date().toISOString();
    try {
      await this._storage.put("lastActivity", this.lastActivity);
      await this._storage.setAlarm(Date.now() + ROOM_TTL_MS);
    } catch {
      // a failed clock write must never take the relay down
    }
  }

  // Append a gated-channel message to history (ciphertext payload) and reset
  // the clock. Capped at MAX_HISTORY, oldest dropped first.
  async _appendHistory(from, payload) {
    if (!this._storage) return;
    this.history.push({ from, ...payload, ts: Date.now() });
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    await this._persistHistory();
    await this._touchActivity();
  }

  // The room is over: everything gone, alarm cancelled. Called when the last
  // member disconnects, and by alarm().
  async _endRoom() {
    if (!this._storage) {
      // Offline tests: just reset in-memory state.
      this.gate = null;
      this.gateFails = 0;
      this.lockedUntil = 0;
      this.members.clear();
      this.history = [];
      this.lastActivity = null;
      return;
    }
    try {
      await this._storage.cancelAlarm();
      await this._storage.deleteAll();
    } catch {
      // best effort — storage unavailable must not wedge the object
    }
    this.gate = null;
    this.gateFails = 0;
    this.lockedUntil = 0;
    this.members.clear();
    this.history = [];
    this.lastActivity = null;
  }

  // 24h after the last activity: the room is gone — gate, history, presence,
  // everything. Any socket still open is closed so no client sits in a room
  // that no longer exists.
  async alarm() {
    for (const ws of [...this.sessions.keys()]) {
      try {
        ws.close(1000, "room ended");
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
    await this._endRoom();
  }

  // The Worker routes /chat/<name>/ws here. Only WebSocket upgrades are valid.
  //
  // The upgrade ALWAYS succeeds for a well-formed request (D8): whether a
  // channel exists, whether it is gated, and whether it is locked out are all
  // invisible here. Only the gate exchange can refuse, and it refuses
  // uniformly. Otherwise this endpoint would be an oracle for probing which
  // channel names are live.
  async fetch(request) {
    // The persisted gate/presence/history must be in memory before the first
    // challenge or join is handled. One storage read, cached.
    await this._restored;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!sameOrigin(request)) {
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
    if (frame?.t !== "msg" && frame?.t !== "leave") return;

    // Explicit DISCONNECT (owner 2026-08-10): the only thing that removes a
    // member's presence. A dropped socket never does — that is the point of
    // the presence model.
    if (frame.t === "leave") {
      this.disconnect(ws, session);
      return;
    }

    // A channel carries exactly ONE kind of payload, decided by whether it has
    // a gate, and the mismatched kind is DROPPED rather than relayed.
    //
    // This is the "never silently downgrade" rule in code. On a gated channel
    // the members' whole expectation is that the wire holds ciphertext; a
    // stray plaintext `d` — from a stale tab, a hand-built frame, a future
    // bug — would be relayed to everyone and would look exactly like a normal
    // message, quietly making the room's guarantee false for that line. The
    // server cannot read `env`, but it can refuse to carry anything else, and
    // that refusal is the only part of the guarantee it is able to enforce.
    if (this.gate) {
      if (!isEnvelope(frame.env)) return;
      this.broadcast({ t: "msg", from: session.nick, env: frame.env }, ws);
      this._appendHistory(session.nick, { env: frame.env });
      return;
    }
    if (typeof frame.d === "string" && frame.d.length > 0) {
      this.broadcast({ t: "msg", from: session.nick, d: frame.d }, ws);
      // Open channels store no history (A9a) but the 24h clock still applies.
      this._touchActivity();
    }
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

    // Presence: a member id identifies THIS tab's session. A known id is a
    // resume (socket dropped, room alive) — no history replay, the tab kept
    // its transcript. A new id is a fresh member — history is replayed.
    const memberId =
      typeof frame.id === "string" && MEMBER_ID_RE.test(frame.id)
        ? frame.id
        : toHex(randomNonce()); // legacy/absent id: treat as a fresh member
    const resuming = this.members.has(memberId);
    this.members.set(memberId, { nick: frame.nick });
    this._persistMembers();
    this._touchActivity();

    session.nick = frame.nick;
    session.memberId = memberId;
    session.nonce = null; // spent; never reused
    this.send(ws, { t: "ready" });

    // Roster replay from PRESENCE (idle members included), not just connected
    // sockets: a newcomer sees everyone who is in the room, not only those
    // with a live socket.
    for (const m of this.members.values()) {
      if (m.nick && m.nick !== frame.nick) this.send(ws, { t: "join", nick: m.nick });
    }

    // History replay for a genuinely new member — the room's record of the
    // last MAX_HISTORY messages (ciphertext on a gated channel). Sent as one
    // frame so the client can hold it until its encryption key is ready.
    if (!resuming && this.history.length) {
      this.send(ws, { t: "history", msgs: this.history });
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
    this._persistGate(); // fire-and-forget; the gate must survive eviction
    this._touchActivity();
    return true;
  }

  // D7 challenge-response + D8 lockout. Every refusal closes with the SAME
  // code, the SAME reason, and — see below — the same amount of work, so a
  // caller cannot distinguish a wrong PIN from a malformed frame from a
  // locked-out channel by any means.
  async passesGate(ws, session, frame) {
    const locked = Date.now() < this.lockedUntil;

    // A join frame carrying NO gate field is not a failed attempt — it is a
    // client that has not answered yet. Two ways that happens: the socket
    // connected before the gate existed (never challenged), or its join frame
    // and our challenge crossed on the wire, which is the ORDINARY case, since
    // the client sends join the moment it opens.
    //
    // Challenge only if this socket has never been challenged. Re-issuing a
    // nonce to a socket that already has one outstanding would overwrite
    // session.nonce and invalidate the answer the client is at that moment
    // computing for the FIRST nonce — so its correct answer would arrive,
    // compare against the replacement, and be counted a failure. Every honest
    // join to a gated channel would fail that way, and five of them would lock
    // the channel with no attacker involved at all.
    if (!answered(frame) && !locked) {
      if (!session.nonce) this.challenge(ws, session);
      return false;
    }

    // From here every path either admits or refuses, and every one pays for
    // the same HMAC first — including the paths that do not need it.
    //
    // The close code and reason were already uniform; the DURATION was not. A
    // locked-out channel returned instantly while a wrong answer paid for a
    // WebCrypto importKey+sign, so an attacker timing the difference could
    // tell "the channel is locked" from "my guess was wrong" and pace guessing
    // around the 60 s backoff instead of wasting attempts inside it. Same
    // reasoning as the constant-time compare below: uniform answers are worth
    // nothing if the clock still tells them apart.
    const expected = await hmacHex(this.gate, session.nonce ?? randomNonce());

    const ok =
      !locked &&
      session.nonce !== null &&
      isGateHex(frame.gate) &&
      timingSafeEqualHex(frame.gate, expected);

    if (!ok) {
      // A locked channel refuses without deepening its own lockout — only a
      // real attempt counts against the budget, or an attacker could hold a
      // channel shut indefinitely by hammering it while it is already closed.
      if (locked) this.refuseGate(ws);
      else this.failGate(ws);
      return false;
    }

    this.gateFails = 0; // a correct answer clears the streak
    this._persistGate(); // lockout state must survive an eviction too
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
    this._persistGate(); // lockout must survive eviction — it is the whole point
    this.refuseGate(ws);
  }

  refuseGate(ws) {
    ws.close(CLOSE_GATE, CLOSE_GATE_REASON);
  }

  // Socket closed or errored — a drop, NOT a leave (presence model). The
  // member's presence stays in this.members, no {t:"leave"} is broadcast, and
  // the roster keeps them. Their reconnect with the same memberId resumes the
  // presence; the room stays alive for them.
  drop(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    // No broadcast. Deliberately: a phone-locked tab or a laptop that slept
    // is still in the room (owner 2026-08-10). Only {t:"leave"} ends a
    // presence.
  }

  // Explicit DISCONNECT — the only thing that removes a member's presence.
  // If it was the last presence, the room ends NOW, not in 24h.
  disconnect(ws, session) {
    const nick = session.nick;
    if (session.memberId) this.members.delete(session.memberId);
    this.sessions.delete(ws);
    this._persistMembers();
    if (nick) this.broadcast({ t: "leave", nick }, ws);
    if (this.members.size === 0) this._endRoom();
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
  }

  memberCount() {
    return this.members.size;
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
