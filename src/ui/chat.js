// Chat — landing navigation and room WebSocket client. PR2: plaintext relay
// (D10); the PIN gate (PR3) and client crypto (PR4) build on this file.
//
// Self-booting plain script, not an ES module: /s.js is CONCATENATED from raw
// files by scripts/build-assets.mjs rather than bundled, so `export` would be
// a syntax error in the browser and cross-file calls are impossible. This
// file therefore owns its own DOMContentLoaded hook and shares nothing with
// client.js or ambient.js.
//
// Every message the server relays arrives as a JSON frame; every string it
// carries (nick, text) is rendered with textContent, never innerHTML — the
// channel relays exactly what members typed, and none of it is trusted HTML.
//
// The server is the authority on nick and channel-name validity; the client
// checks mirror it as a courtesy so a bad name fails before a socket opens.

(function () {
  "use strict";

  const NICK_STORAGE = "talvi.chat.nick";
  const CHANNEL_RE = /^[a-z0-9-]{1,64}$/;
  const MAX_WIRE_BYTES = 4096;
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

  // -------------------------------------------------------------- landing

  function initLanding() {
    const channel = $("channel");
    const nick = $("nick");
    const join = $("join");
    const msg = $("msg");
    if (!channel || !nick || !join) return; // not this page

    function say(text) {
      msg.textContent = text;
      msg.className = "msg";
    }

    function go() {
      const name = channel.value.trim().toLowerCase();
      const who = nick.value.trim();
      if (!CHANNEL_RE.test(name)) {
        say("NAME — lowercase letters, numbers, hyphens, up to 64.");
        return;
      }
      if (!validNick(who)) {
        say("NICK — one word, no spaces, up to 32 characters.");
        return;
      }
      try {
        window.sessionStorage.setItem(NICK_STORAGE, who);
      } catch {
        // Private mode: fall back to a query parameter. The nick leaves the
        // URL after join (history.replaceState), so it is not left behind.
        try {
          window.location.href =
            "/chat/" + name + "?nick=" + encodeURIComponent(who);
        } catch {
          window.location.href = "/chat/" + name;
        }
        return;
      }
      window.location.href = "/chat/" + name;
    }

    nick.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    channel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    join.addEventListener("click", go);
  }

  // ---------------------------------------------------------------- room

  function initRoom() {
    const msgs = $("msgs");
    const text = $("text");
    const send = $("send");
    const msg = $("msg");
    if (!msgs || !text || !send) return; // not this page

    // A nick is picked on the landing page. Direct visits (shared link, no
    // landing) have none — bounce once. A query ?nick= is honoured only as
    // the private-mode fallback above, then scrubbed.
    let nick = null;
    try {
      nick = window.sessionStorage.getItem(NICK_STORAGE);
    } catch {
      /* sessionStorage unavailable — ?nick fallback below */
    }
    if (!nick) {
      const q = new URLSearchParams(window.location.search).get("nick");
      if (validNick(q)) {
        nick = q;
        window.history.replaceState(null, "", window.location.pathname);
      } else {
        window.location.href = "/chat";
        return;
      }
    }

    const wsUrl =
      (window.location.protocol === "https:" ? "wss://" : "ws://") +
      window.location.host +
      window.location.pathname +
      "/ws";

    function say(text) {
      msg.textContent = text;
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

    function emit() {
      const t = text.value;
      if (!t.trim()) return;
      const body = JSON.stringify({ t: "msg", d: t });
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

    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "join", nick }));
    });

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return; // malformed frame; never crash the client on garbage
      }
      if (frame.t === "ready") {
        open = true;
        send.disabled = false;
        text.focus();
        return;
      }
      if (frame.t === "msg" && typeof frame.d === "string") {
        line("them", frame.from ?? "?", frame.d);
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
          say("CHANNEL FULL — 64 members. Try later.");
          lastError = "CHANNEL FULL — 64 members. The link is closed.";
        } else if (frame.code === "toolarge") {
          say("REFUSED — message too long.");
        } else {
          say("REFUSED — " + (frame.code ?? "unknown reason") + ".");
          lastError = "REFUSED — " + (frame.code ?? "unknown reason") + ".";
        }
      }
    });

    // The server sends {t:"error"} and then closes 1008/1013 back-to-back for a
    // rejected join. Without this, `closed()` would stamp over the actionable
    // message (CHANNEL FULL, bad nick) with the generic DISCONNECTED before
    // anyone read it. So remember the last terminal error and let the close
    // handler show it instead of the generic line.
    let lastError = null;

    function closed() {
      open = false;
      send.disabled = true;
      say(lastError ?? "DISCONNECTED — the room is gone or the link dropped. Reload.");
      lastError = null;
    }
    ws.addEventListener("close", closed);
    ws.addEventListener("error", closed);

    send.addEventListener("click", () => {
      if (open) emit();
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && open) emit();
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
