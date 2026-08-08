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
  const GATE_STORAGE = "talvi.chat.gate";
  const CHANNEL_RE = /^[a-z0-9-]{1,64}$/;
  const MAX_WIRE_BYTES = 4096;
  const CLOSE_GATE = 4003; // uniform gate refusal (D8)
  const encoder = new TextEncoder();

  function $(id) {
    return document.getElementById(id);
  }

  // Mirrors isValidNick in src/chat/name.js (server is authoritative; this is
  // a courtesy so a bad nick fails before a socket opens). Whitespace OR
  // control chars — NUL, backspace, DEL — all reject.
  function validNick(s) {
    return (
      typeof s === "string" &&
      s.length >= 1 &&
      s.length <= 32 &&
      !/[\s\u0000-\u001f\u007f]/.test(s)
    );
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
    const create = $("create");
    const msg = $("msg");
    if (!channel || !nick || !join) return; // not this page

    const gate = window.talviGate;

    function say(text) {
      msg.textContent = text;
      msg.className = "msg";
    }

    // D9. A created channel gets a 100-bit name, because "first joiner sets
    // the gate" means a guessable name can be claimed before its owner ever
    // arrives. Typing your own name is still allowed for joining one you were
    // given — it is generating them that must not be guessable.
    function newChannel() {
      channel.value = gate.randomSlug();
      say("NAME GENERATED — share it with the people you want, and nobody else.");
      if (pin) pin.focus();
    }

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
        say("NICK — one word, no spaces, up to 32 characters.");
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
        if (create) create.disabled = true;
        say("DERIVING KEY — a moment.");
        try {
          const master = await gate.deriveMasterHex(secret, name);
          if (!writeStore(GATE_STORAGE, JSON.stringify({ name, master }))) {
            say("STORAGE BLOCKED — cannot carry the key into the room.");
            join.disabled = false;
            if (create) create.disabled = false;
            return;
          }
        } catch {
          say("KEY FAILED — this browser refused the crypto this needs.");
          join.disabled = false;
          if (create) create.disabled = false;
          return;
        }
      } else {
        // No PIN: an open channel (D10). Clear any key left from a previous
        // channel so the room does not answer a challenge with a stale value.
        try {
          window.sessionStorage.removeItem(GATE_STORAGE);
        } catch {
          /* nothing stored to clear */
        }
      }

      window.location.href = "/chat/" + name;
    }

    function onEnter(e) {
      if (e.key === "Enter") go();
    }
    nick.addEventListener("keydown", onEnter);
    channel.addEventListener("keydown", onEnter);
    if (pin) pin.addEventListener("keydown", onEnter);
    join.addEventListener("click", () => go());
    if (create) create.addEventListener("click", newChannel);
  }

  // ---------------------------------------------------------------- room

  function initRoom() {
    const msgs = $("msgs");
    const text = $("text");
    const send = $("send");
    const msg = $("msg");
    const mode = $("mode"); // encryption disclosure, filled in after the handshake
    if (!msgs || !text || !send) return; // not this page

    const gate = window.talviGate;
    const channelName = window.location.pathname.replace(/^\/chat\//, "");

    // A nick is picked on the landing page. Direct visits (shared link, no
    // landing) have none — bounce once.
    const nick = readStore(NICK_STORAGE);
    if (!validNick(nick)) {
      window.location.href = "/chat";
      return;
    }

    // Key material, if the landing derived any. It is bound to the channel it
    // was derived for: a stale blob from another channel would produce a
    // wrong gate answer and burn a lockout attempt, so it is ignored.
    let keys = null;
    try {
      const raw = readStore(GATE_STORAGE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.name === channelName) keys = parsed;
    } catch {
      keys = null; // malformed blob — treat as no key
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

    const ws = new WebSocket(wsUrl);

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
    ws.addEventListener("open", () => {
      const frame = { t: "join", nick };
      if (!keys) {
        ws.send(JSON.stringify(frame));
        return;
      }
      gate
        .gateHex(keys.master, channelName)
        .then((h) => {
          frame.setgate = h;
          ws.send(JSON.stringify(frame));
        })
        .catch(() => ws.send(JSON.stringify(frame)));
    });

    async function answerChallenge(nonce) {
      if (!keys) {
        lastError =
          "LOCKED — this channel needs a PIN. Go back and enter it with the " +
          "channel name.";
        say(lastError);
        ws.close();
        return;
      }
      try {
        const h = await gate.gateHex(keys.master, channelName);
        const answer = await gate.answerHex(h, nonce);
        ws.send(JSON.stringify({ t: "join", nick, gate: answer }));
      } catch {
        lastError = "KEY FAILED — this browser refused the crypto this needs.";
        say(lastError);
        ws.close();
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
          ws.close();
          return;
        }
      }
      // Say which kind of room this turned out to be, now that the handshake
      // has settled it. The page shipped without a claim precisely so this one
      // could be true (D13).
      if (mode) {
        mode.textContent = cryptoKey
          ? "ENCRYPTED — sealed in your browser with the PIN before it is sent. " +
            "This app relays it and cannot read it. What carries it still sees " +
            "who is talking, and when."
          : "NOT ENCRYPTED — no PIN on this channel, so messages are relayed " +
            "exactly as you typed them.";
      }
      open = true;
      send.disabled = false;
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

    ws.addEventListener("message", (event) => {
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
      if (frame.t === "msg") {
        show(frame);
        return;
      }
      if (frame.t === "join" && typeof frame.nick === "string") {
        line("join", frame.nick, "joined");
        return;
      }
      if (frame.t === "leave" && typeof frame.nick === "string") {
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
      open = false;
      send.disabled = true;
      // D8: one close code for every gate refusal — wrong PIN, malformed
      // answer, or a channel locked out by someone else's guessing. The
      // server does not say which, so neither does this.
      if (!lastError && event && event.code === CLOSE_GATE) {
        lastError =
          "REFUSED — wrong PIN, or too many attempts on this channel. " +
          "Wait a minute and try again.";
      }
      say(lastError ?? "DISCONNECTED — the room is gone or the link dropped. Reload.");
      lastError = null;
    }
    ws.addEventListener("close", closed);
    ws.addEventListener("error", () => closed(null));

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
