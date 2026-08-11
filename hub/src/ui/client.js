// talvi hub — boots the 3D world and drives the blade (blueprint A2/A5).
//
// This file is the client entry and IS bundled by scripts/build-assets.mjs
// (esbuild: three.js + the scene modules + this file → the /h.js payload), so
// unlike the old raw-concatenated client it can use imports and an ES module
// graph. It owns its own DOMContentLoaded hook.
//
// Two jobs:
//   1. Boot the world if WebGL exists (the page still works without it: the
//      captions and the film overlays sit on the plain dark ground).
//   2. The blade: a class toggle on .blade (is-open) driven by a real
//      <button>. No inline handlers anywhere (CSP: script-src 'self' — which
//      is WHY the toggle is a button + addEventListener, not an onclick
//      attribute). The retract state is remembered in localStorage so the rail
//      stays the way the visitor left it.
import { bootScene } from "../scene/main.js";

(function () {
  "use strict";

  function bootWorld() {
    if (window.WebGLRenderingContext) bootScene();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWorld);
  } else {
    bootWorld();
  }

  const STORAGE_KEY = "talvi.hub.blade";
  const BLADE = document.querySelector(".blade");
  const TOGGLE = document.querySelector(".blade__toggle");

  if (!BLADE || !TOGGLE) return;

  // The toggle is an icon: the glyph says what the NEXT click does (» =
  // expand, « = collapse), and the aria-label says it in words for assistive
  // tech. On mobile the toggle is hidden by CSS and this is moot, but the
  // state must still be right if it is ever shown.
  function refreshToggle(open) {
    TOGGLE.textContent = open ? "«" : "»";
    TOGGLE.setAttribute("aria-label", open ? "collapse rail" : "expand rail");
    TOGGLE.setAttribute("aria-pressed", String(open));
  }

  // Restore: default collapsed. A saved "open" only applies when the visitor
  // explicitly opened it — absence of the key is not "open".
  const restored = localStorage.getItem(STORAGE_KEY) === "open";
  if (restored) BLADE.classList.add("is-open");
  refreshToggle(restored);

  TOGGLE.addEventListener("click", function () {
    const open = BLADE.classList.toggle("is-open");
    refreshToggle(open);
    try {
      if (open) localStorage.setItem(STORAGE_KEY, "open");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled — the toggle still works this page.
    }
  });

  bootAgentPanel();
})();

// The agent panel (blueprint PR2) — the agent's chat front door. The MORE
// blade button toggles it; when open, it connects to /agent/ws (same origin,
// CSP connect-src 'self' permits the upgrade — the chat precedent, D15) and
// speaks the PR2 command protocol: {t:"cmd", cmd, path, data}. The log is
// built here, never in HTML, and the input sends on Enter or the send button.
function bootAgentPanel() {
  const PANEL = document.getElementById("agent-panel");
  const TOGGLE = document.getElementById("agent-toggle");
  const INPUT = document.getElementById("agent-input");
  const SEND = document.getElementById("agent-send");
  const LOG = document.getElementById("agent-log");
  const STATUS = document.getElementById("agent-status");
  if (!PANEL || !TOGGLE || !INPUT || !SEND || !LOG || !STATUS) return;

  let ws = null;

  function setStatus(text) {
    STATUS.textContent = text;
  }

  function log(text) {
    const line = document.createElement("div");
    line.className = "agent__line";
    line.textContent = text;
    LOG.appendChild(line);
    LOG.scrollTop = LOG.scrollHeight;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/agent/ws");

    ws.addEventListener("open", () => {
      setStatus("connected");
      log("> connected");
    });
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.t === "ready") return;
      if (frame.t === "ok") log("ok  " + frame.result);
      else if (frame.t === "err") log("err " + frame.code + (frame.detail ? " — " + frame.detail : ""));
    });
    ws.addEventListener("close", () => {
      setStatus("offline");
      log("> closed");
      ws = null;
    });
    ws.addEventListener("error", () => {
      setStatus("error");
      log("> error");
    });
  }

  function send() {
    const value = INPUT.value;
    if (!value) return;
    INPUT.value = "";
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("> not connected");
      return;
    }
    log("> " + value);
    // Parse "cmd [args...]" from the input into a frame.
    const space = value.indexOf(" ");
    const cmd = space === -1 ? value : value.slice(0, space);
    const rest = space === -1 ? "" : value.slice(space + 1).trim();

    if (cmd === "chat") {
      // chat <message> — the whole rest is the user's natural-language text.
      ws.send(JSON.stringify({ t: "cmd", cmd: "chat", data: rest }));
      return;
    }

    if (cmd === "pr") {
      // pr <branch> <title> — ships everything staged under customcinto/.
      // pr <branch> "title with spaces" <path> [<path>…] — ships only the
      // listed workspace-absolute paths (e.g. /workspace/customcinto/
      // about/page.tsx), so leftovers never poison a PR.
      const bSpace = rest.indexOf(" ");
      const branch = bSpace === -1 ? rest : rest.slice(0, bSpace);
      const tail = bSpace === -1 ? "" : rest.slice(bSpace + 1).trim();
      if (!branch) {
        log("err pr needs a branch name: pr <branch> <title> [paths]");
        return;
      }
      // Quoted title: everything up to the closing quote is the title, the
      // remainder is the explicit file list.
      if (tail.startsWith('"')) {
        const close = tail.indexOf('"', 1);
        const title = close === -1 ? tail.slice(1) : tail.slice(1, close);
        const paths = close === -1
          ? []
          : tail.slice(close + 1).trim().split(/\s+/).filter(Boolean);
        ws.send(JSON.stringify({ t: "cmd", cmd: "pr", branch, title, paths }));
        return;
      }
      const title = tail || "customcinto: agent change";
      ws.send(JSON.stringify({ t: "cmd", cmd: "pr", branch, title }));
      return;
    }

    // write/read/ls/rm: "cmd path [data]"
    const restSpace = rest.indexOf(" ");
    const path = restSpace === -1 ? rest : rest.slice(0, restSpace);
    const data = restSpace === -1 ? undefined : rest.slice(restSpace + 1);
    ws.send(JSON.stringify({ t: "cmd", cmd, path, data }));
  }

  TOGGLE.addEventListener("click", () => {
    const open = PANEL.hidden;
    PANEL.hidden = !open;
    TOGGLE.setAttribute("aria-expanded", String(open));
    if (open) {
      connect();
      INPUT.focus();
    }
  });

  SEND.addEventListener("click", send);
  INPUT.addEventListener("keydown", (event) => {
    if (event.key === "Enter") send();
  });
}
