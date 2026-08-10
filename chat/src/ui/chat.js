// Chat — landing navigation and room WebSocket client. PR3: the PIN gate.
// Message bodies are still plaintext (D10); PR4 encrypts them with K_enc, the
// sibling of the gate key derived in chatcrypto.js.
//
// Self-booting plain script, not an ES module: /s.js is CONCATENATED from raw
// files by scripts/build-assets.mjs rather than bundled, so `export` would be
// a syntax error in the browser. The one seam between concat files is the
// frozen `window.talviGate` object that chatcrypto.js publishes — every KDF
// call below goes through it.
//
// Every message the server relays arrives as a JSON frame; every string it
// carries (nick, text) is rendered with textContent, never innerHTML — the
// channel relays exactly what members typed, and none of it is trusted HTML.
//
// The server is the authority on nick and channel-name validity; the client
// checks mirror it as a courtesy so a bad name fails before a socket opens.
//
// What is NEVER stored: the PIN itself. The landing derives K_master from it
// once (PBKDF2 is slow, and doing it here keeps the room instant) and puts
// only that derived value in sessionStorage — tab-scoped, gone when the tab
// closes. That is not a security boundary against script running on this
// origin, and is not claimed as one; it is the same trust boundary as the
// page, which under `script-src 'self'` with no inline and no eval is the
// whole point of never weakening the CSP.

(function () {
  "use strict";

  const NICK_STORAGE = "talvi.chat.nick";
  const GATES_STORE = "talvi.chat.gates"; // per-channel derived keys (tab-scoped)
  const MEMBER_STORAGE = "talvi.chat.id"; // per-tab presence id (C5)
  const CHANNELS_STORE = "talvi.chat.channels"; // names only — the PIN is never stored
  const MAX_CHANNELS = 20;
  const CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
  const CHANNEL_RE = /^[a-z0-9-]{1,64}$/;
  const MAX_WIRE_BYTES = 4096;
  const CLOSE_GATE = 4003; // uniform gate refusal (D8)
  const encoder = new TextEncoder();

  // Default channel names (owner 2026-08-10): at most 5 chars, lowercase
  // letters and digits — short enough to type and say aloud. Recorded tradeoff:
  // ~26 bits is GUESSABLE, so a default channel leans on its PIN gate; typed
  // names can still be the full 64 chars.
  const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  // Nicks (owner 2026-08-10): at most 5 lowercase letters, no caps, no digits.
  // The server enforces ^[a-z]{1,5}$ (src/chat/name.js); this generates a
  // conforming one.
  const NICK_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

  function $(id) {
    return document.getElementById(id);
  }

  function randomName() {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    let s = "";
    for (const b of bytes) s += NAME_ALPHABET[b % NAME_ALPHABET.length];
    return s;
  }

  function randomNick() {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    let s = "";
    for (const b of bytes) s += NICK_ALPHABET[b % NICK_ALPHABET.length];
    return s;
  }

  // Per-channel derived key (and the generated PIN, when this tab made it).
  // sessionStorage is tab-scoped and gone when the tab closes — same trust
  // boundary as the page. Keyed by channel name so a channel you have entered
  // never asks for its PIN again in this tab (owner 2026-08-10).
  function readKey(name) {
    try {
      const raw = window.sessionStorage.getItem(GATES_STORE);
      const map = raw ? JSON.parse(raw) : {};
      const k = map[name];
      return k && typeof k.master === "string" ? k : null;
    } catch {
      return null;
    }
  }

  function writeKey(name, data) {
    try {
      const raw = window.sessionStorage.getItem(GATES_STORE);
      const map = raw ? JSON.parse(raw) : {};
      map[name] = data;
      window.sessionStorage.setItem(GATES_STORE, JSON.stringify(map));
      return true;
    } catch {
      return false;
    }
  }

  function removeKey(name) {
    try {
      const raw = window.sessionStorage.getItem(GATES_STORE);
      const map = raw ? JSON.parse(raw) : {};
      delete map[name];
      window.sessionStorage.setItem(GATES_STORE, JSON.stringify(map));
    } catch {
      /* nothing to clear */
    }
  }

  // The per-tab presence id (C5). Survives a dropped socket so the server can
  // tell "the same tab came back" from "a new person arrived"; sessionStorage
  // (tab-scoped) is exactly the right lifetime.
  function memberId() {
    let id = readStore(MEMBER_STORAGE);
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = "m" + [...bytes].map((b) => b.toString(36)).join("");
      writeStore(MEMBER_STORAGE, id);
    }
    return id;
  }

  // A fresh random 4-digit PIN. `byte % 10` is biased but that is irrelevant
  // for a gate; what matters is it clears the weak-PIN blocklist, so reject and
  // re-roll if pinProblem complains. The fallback is unreachable in practice.
  function randomPin() {
    const gate = window.talviGate;
    for (let attempt = 0; attempt < 6; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(4));
      const p = bytes.map((b) => String(b % 10)).join("");
      if (!gate.pinProblem(p)) return p;
    }
    return "8437";
  }

  // ---- sidebar: this browser's channels (names only) ----
  // Persisted in localStorage so the list survives a reload; entries older
  // than 24h are dropped (the room would be gone anyway). The PIN is never
  // here — reopening a gated room means typing the PIN you know.
  function readChannels() {
    try {
      const raw = window.localStorage.getItem(CHANNELS_STORE);
      const list = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      return list
        .filter((c) => c && typeof c.name === "string" && now - (c.lastSeen || 0) < CHANNEL_TTL_MS)
        .slice(0, MAX_CHANNELS);
    } catch {
      return [];
    }
  }

  function saveChannel(name, nick) {
    try {
      const next = readChannels().filter((c) => c.name !== name);
      next.unshift({ name, nick, lastSeen: Date.now() });
      window.localStorage.setItem(CHANNELS_STORE, JSON.stringify(next.slice(0, MAX_CHANNELS)));
      renderSide();
    } catch {
      // storage blocked — the sidebar just won't persist; chat still works
    }
  }

  function renderSide() {
    const list = $("sidelist");
    const side = $("side");
    if (!list || !side) return;
    const channels = readChannels();
    const current = window.location.pathname.replace(/^\/chat\//, "");
    list.textContent = "";
    for (const c of channels) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "/chat/" + c.name;
      a.textContent = c.name;
      if (c.name === current) a.setAttribute("aria-current", "page");
      li.appendChild(a);
      list.appendChild(li);
    }
    side.hidden = channels.length === 0;
  }

  // Mirrors isValidNick in src/chat/name.js (server is authoritative; this is
  // a courtesy so a bad nick fails before a socket opens). Owner 2026-08-10:
  // at most 5 lowercase letters, no caps, no digits.
  function validNick(s) {
    return typeof s === "string" && /^[a-z]{1,5}$/.test(s);
  }

  // Mask/unmask toggle for a PIN input (owner 2026-08-10). Masked by default;
  // the button flips input.type and its own label, and reports the state in
  // aria-pressed. Real <button>, no inline handlers (CSP).
  function wirePinEye(inputId, eyeId) {
    const input = $(inputId);
    const eye = $(eyeId);
    if (!input || !eye) return;
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.setAttribute("aria-pressed", String(show));
      eye.textContent = show ? "HIDE" : "SHOW";
      input.focus();
    });
  }

  // sessionStorage is unavailable in some private modes. Every call site
  // treats a miss as "no stored value" rather than an error — chat still
  // works, the user just re-enters things.
  function readStore(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- landing

  function initLanding() {
    const channel = $("channel");
    const nick = $("nick");
    const pin = $("pin");
    const join = $("join");
    const msg = $("msg");
    if (!channel || !nick || !join) return; // not this page

    const gate = window.talviGate;

    function say(text) {
      msg.textContent = text;
      msg.className = "msg";
    }

    // Autopopulate, per the owner: name, nick and PIN are prefilled with fresh
    // random values, everything stays editable, ENTER joins. A short name
    // (owner: ≤5 chars) and a uniform 4-digit PIN (clears the weak-PIN floor
    // by construction) — the two things a person is worst at making up are
    // the two this generates.
    let pinAuto = true; // true while the PIN is the generated one
    if (!channel.value) channel.value = randomName();
    if (!nick.value) nick.value = randomNick();
    if (pin && !pin.value) pin.value = randomPin();
    if (pin) {
      pin.addEventListener("input", () => {
        pinAuto = false; // a typed PIN is the user's own knowledge
      });
    }
    wirePinEye("pin", "pin-eye");

    // There is no "create" mode, deliberately. Supplying a PIN IS the intent,
    // and the server resolves what that means from the channel's actual state:
    // empty channel → this PIN sets the gate; already gated → answer its
    // challenge; already open with members → refused as `notfirst`.
    //
    // The alternative — a create/join toggle — has a trapdoor. Pick "join",
    // type a PIN, and be the first one there, and you would silently land in
    // an OPEN channel with a PIN you believed was protecting it. Deriving
    // intent from the PIN itself makes that state unreachable.
    async function go() {
      const name = channel.value.trim().toLowerCase();
      const who = nick.value.trim();
      const secret = pin ? pin.value : "";

      if (!CHANNEL_RE.test(name)) {
        say("NAME — lowercase letters, numbers, hyphens, up to 64.");
        return;
      }
      if (!validNick(who)) {
        say("NICK — up to 5 lowercase letters, no numbers.");
        return;
      }

      // D5, the review's CRITICAL. Nothing server-side can check PIN strength
      // — it only ever sees a 256-bit KDF output — so a weak PIN is refused
      // here or the confidentiality claim is worthless. Applied to EVERY PIN,
      // not just creation: any PIN may turn out to be creating (the channel
      // could be empty), and a PIN that passed the floor at creation passes it
      // again when a second member types the same one.
      if (secret) {
        const problem = gate.pinProblem(secret);
        if (problem) {
          say(problem);
          return;
        }
      }

      if (!writeStore(NICK_STORAGE, who)) {
        say("STORAGE BLOCKED — this browser refuses sessionStorage, which " +
          "chat needs to carry your nick into the room.");
        return;
      }

      if (secret) {
        // PBKDF2 at 300k iterations is deliberately slow. Do it here, once,
        // while the user is still on this page, so the room joins instantly.
        join.disabled = true;
        say("DERIVING KEY — a moment.");
        try {
          const master = await gate.deriveMasterHex(secret, name);
          // The key rides per-channel in sessionStorage, so this room never
          // asks for its PIN again in this tab. The PIN rides alongside only
          // so the room can show the first line when this tab generated it.
          if (!writeKey(name, { master, pin: secret, generated: pinAuto })) {
            say("STORAGE BLOCKED — cannot carry the key into the room.");
            join.disabled = false;
            return;
          }
        } catch {
          say("KEY FAILED — this browser refused the crypto this needs.");
          join.disabled = false;
          return;
        }
      } else {
        // No PIN: an open channel (D10). Clear any key left for this name so
        // the room does not answer a challenge with a stale value.
        removeKey(name);
      }

      // Remember this channel in the sidebar (names only — never the PIN).
      saveChannel(name, who);
      window.location.href = "/chat/" + name;
    }

    function onEnter(e) {
      if (e.key === "Enter") go();
    }
    nick.addEventListener("keydown", onEnter);
    channel.addEventListener("keydown", onEnter);
    if (pin) pin.addEventListener("keydown", onEnter);
    join.addEventListener("click", () => go());
    renderSide();
  }

  // ---------------------------------------------------------------- room

  function initRoom() {
    const msgs = $("msgs");
    const text = $("text");
    const send = $("send");
    const msg = $("msg");
    const mode = $("mode"); // encryption disclosure, filled in after the handshake
    const members = $("members");
    const reconnect = $("reconnect");
    if (!msgs || !text || !send) return; // not this page

    const gate = window.talviGate;
    const channelName = window.location.pathname.replace(/^\/chat\//, "");

    // A nick is picked on the landing page. Direct visits (shared link, no
    // landing) have none — bounce once.
    // A shared room link is the PRIMARY way people arrive — that is the whole
    // point of a channel name being the secret. So arriving without credentials
    // is the normal case, not an error, and it is answered in place.
    //
    // This used to redirect to /chat, which made the link actively hostile:
    // you clicked a link containing the channel name and were bounced to a page
    // demanding you type that same name back in from memory. The name is 20
    // random characters. Nobody retypes that correctly, and the person who
    // shared it has already done the only hard part.
    let nick = readStore(NICK_STORAGE);

    // Presence id (C5): stable per tab, so the server can resume this
    // member's presence after a socket drop instead of treating them as a
    // newcomer. Cleared on an explicit DISCONNECT so a rejoin is fresh.
    const myId = memberId();

    // Key material for THIS channel, if this tab ever entered it (per-channel
    // in sessionStorage — a channel you have entered never asks for its PIN
    // again in this tab).
    let keys = readKey(channelName);
    // The generated PIN rides with the key so the room can show the first
    // line ("this channel's PIN") when THIS tab generated it — the user may
    // have connected without ever unmasking the field. A typed PIN is the
    // user's own knowledge; it never prints back.
    const generatedPin = keys?.generated ? keys.pin || null : null;
    let pinLineShown = false;

    // The in-room join form. Shown whenever this tab cannot yet join: no nick,
    // or a gated channel we hold no key for. The channel name is NOT asked for
    // — it is already in the URL, which is how the person got here.
    const joinbox = $("joinbox");
    const roomnick = $("roomnick");
    const roompin = $("roompin");
    const roomjoin = $("roomjoin");

    function showJoin(message) {
      if (joinbox) joinbox.hidden = false;
      if (message) say(message);
      if (roomnick) {
        // Autofill the nick (a fresh random one if this tab has none) — the
        // PIN is deliberately NOT autofilled: it is user knowledge (owner Q2).
        if (!nick) {
          nick = randomNick();
          writeStore(NICK_STORAGE, nick);
        }
        roomnick.value = nick;
        roomnick.focus();
      }
    }

    function hideJoin() {
      if (joinbox) joinbox.hidden = true;
    }

    const wsUrl =
      (window.location.protocol === "https:" ? "wss://" : "ws://") +
      window.location.host +
      window.location.pathname +
      "/ws";

    function say(t) {
      msg.textContent = t;
      msg.className = "msg";
    }

    function line(kind, who, what) {
      const li = document.createElement("li");
      li.className = "chat__line chat__line--" + kind;
      const whoEl = document.createElement("span");
      whoEl.className = "chat__who";
      whoEl.textContent = who;
      li.appendChild(whoEl);
      const whatEl = document.createElement("span");
      whatEl.className = "chat__text";
      whatEl.textContent = what;
      li.appendChild(whatEl);
      msgs.appendChild(li);
      msgs.scrollTop = msgs.scrollHeight;
    }

    // On a gated channel this holds K_enc and every message is sealed with it
    // before it reaches the socket. On an open channel it stays null and
    // messages go as plaintext (D10) — which the UI says out loud.
    let cryptoKey = null;

    // History replay (C5): the server sends the room's last messages as one
    // {t:"history"} frame to a genuinely new member. On a gated channel the
    // payloads are sealed, so they are held here until ready() has derived
    // K_enc — otherwise a frame racing the WebCrypto derivation would be
    // silently dropped and the room's history lost.
    let pendingHistory = null;

    function flushHistory() {
      if (!pendingHistory) return;
      for (const m of pendingHistory) {
        if (!m || typeof m.from !== "string") continue;
        if (m.env !== undefined) show({ from: m.from, env: m.env });
        else if (typeof m.d === "string") line("them", m.from, m.d);
      }
      pendingHistory = null;
    }

    async function emit() {
      const t = text.value;
      if (!t.trim()) return;

      // Encrypt FIRST, then measure, then send. The ciphertext is what has to
      // fit MAX_WIRE_BYTES, and it is bigger than the plaintext (base64 of the
      // text plus a 16-byte tag plus the IV) — measuring the plaintext would
      // let a message through that the server then refuses as `toolarge`,
      // which reads to the user as the message vanishing.
      let body;
      if (cryptoKey) {
        try {
          body = JSON.stringify({ t: "msg", env: await gate.seal(cryptoKey, t) });
        } catch {
          // Refuse rather than fall back to plaintext. A sealed room that
          // quietly sends one line in the clear is worse than a room that
          // admits it cannot send.
          say("NOT SENT — encryption failed. Nothing was sent in the clear.");
          return;
        }
      } else {
        body = JSON.stringify({ t: "msg", d: t });
      }

      if (encoder.encode(body).length > MAX_WIRE_BYTES) {
        say("REFUSED — that message is too long.");
        return;
      }
      ws.send(body);
      line("me", nick, t);
      text.value = "";
      text.focus();
    }

    let open = false;
    let lastError = null;
    // Set when the server challenges a tab that holds no key, so the close
    // handler knows to ask for a PIN rather than report a dropped link.
    let needsPin = false;
    // Set when the user clicked DISCONNECT, so closed() says so instead of
    // stamping the generic link-dropped message over a deliberate leave.
    let leaving = false;

    // The socket is rebuilt on every connect, so this is a `let`. Everything
    // that sends goes through the CURRENT one.
    let ws = null;

    // Who is in the room. Rebuilt from scratch on each connect: the server
    // replays the full roster to a newcomer, so after a reconnect the fresh
    // replay is the truth and anything remembered from the previous socket is
    // stale by definition.
    const roster = new Set();

    function renderMembers() {
      if (!members) return;
      const others = [...roster].filter((n) => n !== nick);
      members.textContent = others.length
        ? "IN THE ROOM — you, " + others.join(", ")
        : "IN THE ROOM — just you.";
    }

    function connect() {
      // Retire any previous socket FIRST, and detach it by nulling `ws` before
      // closing it. Every listener in wire() bails on `sock !== ws`, so the old
      // connection goes silent immediately rather than running its close
      // handler and painting disconnect UI over the connection we are in the
      // middle of making.
      const previous = ws;
      ws = null;
      if (previous) {
        try {
          previous.close();
        } catch {
          /* already closing or closed */
        }
      }

      // A new attempt never inherits the last one's flags. needsPin especially:
      // it is one shared flag, not per-socket, and a superseded socket returns
      // from closed() before reaching the reset — so it would stay true and the
      // next ordinary disconnect would claim the channel needs a PIN.
      needsPin = false;
      lastError = null;
      open = false;

      roster.clear();
      roster.add(nick);
      renderMembers();
      if (reconnect) reconnect.hidden = true;
      say("CONNECTING…");

      ws = new WebSocket(wsUrl);
      wire(ws);
    }

    function wire(sock) {

    // Send the join as soon as the socket opens, carrying H_gate as `setgate`
    // whenever we hold a key. The server decides what that means:
    //
    //   channel empty        → this installs the gate (we are the first in)
    //   channel gated        → setgate ignored; it challenges us instead
    //   channel open, in use → refused `notfirst`, because a PIN cannot be
    //                          bolted onto a conversation already in progress
    //
    // So the same frame both creates and joins, and the object's real state —
    // not a guess made on the landing page — settles which happened.
    sock.addEventListener("open", () => {
      if (sock !== ws) return; // superseded before it finished opening
      const frame = { t: "join", nick, id: myId };
      if (!keys) {
        sock.send(JSON.stringify(frame));
        return;
      }
      gate
        .gateHex(keys.master, channelName)
        .then((h) => {
          frame.setgate = h;
          sock.send(JSON.stringify(frame));
        })
        .catch(() => sock.send(JSON.stringify(frame)));
    });

    async function answerChallenge(nonce) {
      if (!keys) {
        // Gated, and this tab has no key. Ask for the PIN right here — the
        // person followed a link to THIS channel, so sending them back to a
        // page that demands the channel name again is the worst possible
        // answer to "what is the PIN?".
        needsPin = true;
        sock.close();
        return;
      }
      try {
        const h = await gate.gateHex(keys.master, channelName);
        const answer = await gate.answerHex(h, nonce);
        sock.send(JSON.stringify({ t: "join", nick, id: myId, gate: answer }));
      } catch {
        lastError = "KEY FAILED — this browser refused the crypto this needs.";
        say(lastError);
        sock.close();
      }
    }

    // Admitted. On a gated channel, derive K_enc before enabling the input —
    // the button must not be live for a message we could not seal.
    // Holding a key and reaching `ready` means this channel IS gated, always:
    // with a key we always offer `setgate`, so an empty channel becomes gated,
    // an already-gated one challenges us, and an open one with members refuses
    // us outright with `notfirst`. There is no path to `ready` that holds a key
    // and is not encrypted.
    async function ready() {
      if (keys) {
        try {
          cryptoKey = await gate.encKey(keys.master, channelName);
        } catch {
          say("KEY FAILED — this browser refused the crypto this needs.");
          sock.close();
          return;
        }
        // K_enc is ready — render any history that arrived while it was being
        // derived (C5).
        flushHistory();
      }
      // Say which kind of room this turned out to be, now that the handshake
      // has settled it. The page shipped without a claim precisely so this one
      // could be true (D13).
      if (mode) {
        mode.textContent = cryptoKey
          ? "ENCRYPTED — sealed in your browser with the PIN before it is sent; " +
            "nothing readable crosses the wire."
          : "NOT ENCRYPTED — no PIN on this channel, so messages are relayed " +
            "exactly as you typed them.";
      }
      open = true;
      send.disabled = false;
      if (reconnect) reconnect.hidden = true;
      say("");
      // Admitted → remember this channel for the sidebar (names only).
      saveChannel(channelName, nick);
      // Automatic first line (owner 2026-08-10): when THIS tab generated the
      // channel's PIN, show it in the transcript so it is not lost even if
      // the user connected without ever unmasking the field. Local to this
      // tab — the PIN is not broadcast to the room.
      if (generatedPin && !pinLineShown) {
        pinLineShown = true;
        const rule = document.createElement("li");
        rule.className = "chat__line chat__line--rule";
        rule.textContent = "PIN " + generatedPin + " — share it with the people you let in.";
        msgs.appendChild(rule);
      }
      renderMembers();
      text.focus();
    }

    // Render a relayed message. `env` on gated channels, `d` on open ones —
    // and never the other way round, because the server refuses to relay the
    // mismatched kind at all.
    async function show(frame) {
      const who = frame.from ?? "?";
      if (frame.env !== undefined) {
        if (!cryptoKey) return; // not our channel's shape; nothing to do
        const plain = await gate.unseal(cryptoKey, frame.env);
        // Silent drop (blueprint §3). A failed tag means the sender used a
        // different PIN — they are not in this conversation, and rendering a
        // "could not decrypt" line for every frame they send would let anyone
        // who knows the channel name spam the room with error text.
        if (plain === null) return;
        line("them", who, plain);
        return;
      }
      if (typeof frame.d === "string") line("them", who, frame.d);
    }

    sock.addEventListener("message", (event) => {
      // An orphaned socket must not touch shared state — roster, cryptoKey,
      // the transcript, the mode line — on its way out. Only the current
      // connection speaks for this room.
      if (sock !== ws) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return; // malformed frame; never crash the client on garbage
      }
      if (frame.t === "challenge" && typeof frame.nonce === "string") {
        answerChallenge(frame.nonce);
        return;
      }
      if (frame.t === "ready") {
        ready();
        return;
      }
      if (frame.t === "history" && Array.isArray(frame.msgs)) {
        pendingHistory = frame.msgs;
        if (cryptoKey) flushHistory();
        return;
      }
      if (frame.t === "msg") {
        show(frame);
        return;
      }
      if (frame.t === "join" && typeof frame.nick === "string") {
        roster.add(frame.nick);
        renderMembers();
        line("join", frame.nick, "joined");
        return;
      }
      if (frame.t === "leave" && typeof frame.nick === "string") {
        roster.delete(frame.nick);
        renderMembers();
        line("leave", frame.nick, "left");
        return;
      }
      if (frame.t === "error") {
        if (frame.code === "full") {
          lastError = "CHANNEL FULL — 64 members. The link is closed.";
          say(lastError);
        } else if (frame.code === "toolarge") {
          say("REFUSED — message too long.");
        } else if (frame.code === "notfirst") {
          lastError =
            "TAKEN — that channel is already open, and only its first " +
            "member can set a PIN. Pick another name.";
          say(lastError);
        } else {
          lastError = "REFUSED — " + (frame.code ?? "unknown reason") + ".";
          say(lastError);
        }
      }
    });

    // The server sends {t:"error"} and then closes back-to-back for a rejected
    // join, so remember the actionable message and let close() show it rather
    // than stamping the generic DISCONNECTED over it before anyone reads it.
    function closed(event) {
      if (sock !== ws) return; // a superseded socket closing; not our business
      open = false;
      send.disabled = true;
      roster.clear();
      renderMembers();

      // A deliberate DISCONNECT: the presence is gone server-side; the room
      // stays for 24h or until everyone else leaves too.
      if (leaving) {
        leaving = false;
        say("YOU LEFT — the room stays for 24h, or until everyone else leaves.");
        showJoin();
        return;
      }

      // D8: one close code for every gate refusal — wrong PIN, malformed
      // answer, or a channel locked out by someone else's guessing. The
      // server does not say which, so neither does this.
      const refusedByGate = event && event.code === CLOSE_GATE;
      if (!lastError && refusedByGate) {
        lastError =
          "REFUSED — wrong PIN, or too many attempts on this channel. " +
          "Wait a minute and try again.";
      }
      // Presence model (C5): a dropped link is not the end of the room — it
      // lives 24h after the last message. The copy says so, and reconnect is
      // the way back in.
      say(lastError ?? "LINK DROPPED — you're still in the room. Reconnect to get back in.");

      // Offer a button rather than retrying on a timer. An automatic retry
      // against a gated channel spends a lockout attempt every time, so a room
      // that refused you once would be hammered shut by its own client. The
      // person decides, having read why they were dropped.
      // A wrong PIN needs a different PIN, not another attempt at the same one
      // — and every retry of the same wrong value spends a lockout attempt.
      // So a gate refusal re-opens the form; only a plain dropped connection
      // gets a reconnect button.
      if (needsPin) {
        needsPin = false;
        showJoin("LOCKED — this channel needs a PIN. Enter it to join.");
      } else if (refusedByGate) {
        showJoin(
          "REFUSED — wrong PIN, or too many attempts on this channel. " +
            "Check the PIN and try again; if it keeps failing, wait a minute.",
        );
      } else if (reconnect) {
        reconnect.hidden = false;
        reconnect.textContent = "RECONNECT";
      }
      lastError = null;
    }
    sock.addEventListener("close", closed);
    sock.addEventListener("error", () => closed(null));
    }

    // emit() is async now (sealing awaits WebCrypto). Nothing waits on it, so
    // catch here or a rejection goes unhandled and the message disappears with
    // no trace for the person who typed it.
    function trySend() {
      if (!open) return;
      emit().catch(() => say("NOT SENT — something went wrong sending that."));
    }
    send.addEventListener("click", trySend);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") trySend();
    });

    // Joining from the room page itself. The channel name is never asked for —
    // it is in the URL. Only what this tab is missing: a nick, and a PIN if the
    // channel turns out to be gated.
    let submitting = false;

    // Enter fires this directly, and #roomnick/#roompin are never disabled, so
    // the button's own disabled flag guarded nothing against a second Enter
    // during the ~300ms PBKDF2 derivation. Two runs would derive twice, both
    // reassign `keys`, and both call connect() — opening two sockets and
    // spending a gate attempt with whichever PIN lost the race.
    async function submitJoin() {
      if (submitting) return;
      submitting = true;
      try {
        await doSubmitJoin();
      } finally {
        submitting = false;
      }
    }

    async function doSubmitJoin() {
      const who = roomnick ? roomnick.value.trim() : "";
      const secret = roompin ? roompin.value : "";

      if (!validNick(who)) {
        say("NICK — one word, no spaces, up to 32 characters.");
        return;
      }
      // D5 floor applies here exactly as on the landing: this join may turn out
      // to be the one that CREATES the gate, if the channel is empty.
      if (secret) {
        const problem = gate.pinProblem(secret);
        if (problem) {
          say(problem);
          return;
        }
      }
      if (!writeStore(NICK_STORAGE, who)) {
        say("STORAGE BLOCKED — this browser refuses sessionStorage, which chat " +
          "needs to hold your nick.");
        return;
      }
      nick = who;

      if (secret) {
        if (roomjoin) roomjoin.disabled = true;
        say("DERIVING KEY — a moment.");
        try {
          const master = await gate.deriveMasterHex(secret, channelName);
          keys = { master, pin: secret, generated: false };
          writeKey(channelName, keys);
        } catch {
          say("KEY FAILED — this browser refused the crypto this needs.");
          if (roomjoin) roomjoin.disabled = false;
          return;
        }
        if (roomjoin) roomjoin.disabled = false;
      } else {
        // No PIN offered: clear any stale key so we do not answer a challenge
        // with the wrong value and spend a lockout attempt doing it.
        keys = null;
        removeKey(channelName);
      }

      hideJoin();
      connect();
    }

    if (roomjoin) roomjoin.addEventListener("click", () => submitJoin());
    // The reconnect (↻) icon beside the PIN input — the owner's affordance for
    // reopening a channel from the sidebar: type the PIN you know, click ↻.
    // It is the same join as ENTER.
    const roomreconnect = $("roomreconnect");
    if (roomreconnect) roomreconnect.addEventListener("click", () => submitJoin());
    wirePinEye("roompin", "roompin-eye");
    for (const el of [roomnick, roompin, roomreconnect]) {
      if (el) {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submitJoin();
        });
      }
    }
    renderSide();

    if (reconnect) {
      reconnect.hidden = true;
      reconnect.addEventListener("click", () => {
        // A reconnect is a RESUMPTION (C5): the room and this tab's presence
        // survived the drop. The server skips history replay for a resuming
        // member, so the transcript on screen stays this tab's own record,
        // with a rule drawn so nobody reads across the gap as one conversation.
        const rule = document.createElement("li");
        rule.className = "chat__line chat__line--rule";
        rule.textContent = "— reconnected —";
        msgs.appendChild(rule);
        connect();
      });
    }

    // DISCONNECT (owner 2026-08-10) — the explicit leave. The only thing that
    // removes this tab's presence server-side; if it was the last one, the
    // room ends now instead of waiting out its 24h.
    const disconnectBtn = $("disconnect");
    if (disconnectBtn) {
      disconnectBtn.addEventListener("click", () => {
        leaving = true;
        try {
          if (ws && open) ws.send(JSON.stringify({ t: "leave" }));
        } catch {
          /* socket already gone */
        }
        // Back to the landing (owner 2026-08-10). The per-channel key stays in
        // sessionStorage, so returning to this channel won't ask for the PIN
        // again — but the presence id is reset so a rejoin is a fresh arrival.
        try {
          window.sessionStorage.removeItem(MEMBER_STORAGE);
        } catch {
          /* nothing stored to clear */
        }
        try {
          if (ws) ws.close(1000, "bye");
        } catch {
          /* already closing */
        }
        window.location.href = "/chat/";
      });
    }

    // Arrived with a nick already (came via the landing, or joined earlier in
    // this tab) → straight in. Otherwise ask, here, on this page.
    if (validNick(nick)) {
      hideJoin();
      connect();
    } else {
      showJoin();
    }
  }

  function boot() {
    initLanding();
    initRoom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
