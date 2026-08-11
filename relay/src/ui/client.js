// talvi — browser-side JS. Served at /relay/s.js. The relay mounts at
// app.ygdcbtmc4u.uk/relay (blueprint A2), so the upload endpoint is
// /relay/api/upload. This file is concatenated raw into /s.js (no module
// loader), hence the literal prefix here rather than an import.
//
// A real, standalone .js file, not a JS template literal (B.9): the backticks
// and ${} below are ordinary source here, and build-assets.mjs JSON.stringify()s
// the whole file, so there is no hand-escaping step to get wrong.
//
// Never inlined: the CSP is `script-src 'self'` — no inline <script> block is
// allowed (B.7 item 3). That is why this is a file and not a <script> block.
//
// XMLHttpRequest, not fetch — a deliberate, slightly unfashionable choice with
// one concrete reason: xhr.upload.onprogress reports upload progress and fetch
// does not. On a 25 MiB cap, the progress readout is most of what makes the
// upload feel like anything at all.
//
// Written in modern syntax (const/let, optional chaining). The first draft used
// `var` throughout out of habit for browser code — pointless here: every
// browser with the drag-and-drop, clipboard, and XHR-progress APIs this file
// depends on has supported const/let for years. SonarQube flagged all 33 of
// them, correctly.

(function () {
  "use strict";

  const MAX_BYTES = 25 * 1024 * 1024; // mirrors MAX_BYTES in src/index.js

  function $(id) {
    return document.getElementById(id);
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // "in 29 days" / "in 4 hours" / "in 12 minutes". Used on both pages.
  function relative(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return "";
    if (ms <= 0) return "expired";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return "in " + mins + (mins === 1 ? " minute" : " minutes");
    const hours = Math.round(mins / 60);
    if (hours < 48) return "in " + hours + (hours === 1 ? " hour" : " hours");
    const days = Math.round(hours / 24);
    return "in " + days + (days === 1 ? " day" : " days");
  }

  function absolute(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Locale-formatted, but never the raw ISO string with its T and Z.
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ---------------------------------------------------------------- copying

  // Fallback for a browser without the async clipboard API, or one that
  // refuses it (it needs a secure context and can be permission-gated):
  // select the link text so the user can copy it with the keyboard, and say so.
  function selectFallback(button, confirmed) {
    const target = $("link");
    if (target && window.getSelection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = "PRESS COPY KEYS";
      window.setTimeout(() => {
        button.textContent = "COPY LINK";
      }, 2600);
      return;
    }
    confirmed();
  }

  function copyText(text, button, doneLabel) {
    const restore = button.textContent;

    function confirmed() {
      button.textContent = doneLabel;
      button.classList.add("is-done");
      window.setTimeout(() => {
        button.textContent = restore;
        button.classList.remove("is-done");
      }, 2000);
    }

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(confirmed, () => selectFallback(button, confirmed));
      return;
    }
    selectFallback(button, confirmed);
  }

  // ------------------------------------------------------------ upload page

  function initUpload() {
    const drop = $("drop");
    const input = $("file");
    const chosen = $("chosen");
    const send = $("send");
    const prog = $("prog");
    const fill = $("fill");
    const pct = $("pct");
    const msg = $("msg");
    const result = $("result");
    const link = $("link");
    const copy = $("copy");
    const expiry = $("expiry");
    // The encrypted-share fragment key (B1). Set inside the send handler after
    // a successful encrypted upload; succeed() reads it to build the share
    // URL. Declared HERE (initUpload scope) — a `let` inside the click handler
    // was invisible to succeed(), so a successful upload threw a ReferenceError
    // and the link never rendered.
    let fragment = "";
    if (!drop || !input || !send) return; // not this page

    let file = null;
    let busy = false;

    function say(text, bad) {
      msg.textContent = text;
      msg.className = bad ? "msg msg--bad" : "msg";
    }

    function clearMsg() {
      msg.textContent = "";
      msg.className = "msg hidden";
    }

    function choose(f) {
      file = f;
      if (!f) {
        chosen.textContent = "";
        send.disabled = true;
        return;
      }
      chosen.textContent = f.name + "  " + humanSize(f.size);
      // Client-side size check is a courtesy, not a control — the Worker
      // rejects oversize with 413 regardless of what this does.
      if (f.size > MAX_BYTES) {
        say("REFUSED — that file is " + humanSize(f.size) + ". Ceiling is 25 MB.", true);
        send.disabled = true;
        return;
      }
      clearMsg();
      send.disabled = false;
    }

    input.addEventListener("change", () => {
      choose(input.files?.[0] ?? null);
    });

    // Drag and drop. dragover must be prevented or the browser navigates to
    // the dropped file instead of handing it over.
    for (const evt of ["dragenter", "dragover"]) {
      drop.addEventListener(evt, (e) => {
        e.preventDefault();
        drop.classList.add("is-over");
      });
    }

    for (const evt of ["dragleave", "dragend"]) {
      drop.addEventListener(evt, () => drop.classList.remove("is-over"));
    }

    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      if (busy) return;
      const dropped = e.dataTransfer?.files?.[0];
      if (!dropped) return;
      // Keep the real <input> in sync so the form control and the visible
      // state never disagree. Feature-detected rather than wrapped in a
      // try/catch: a swallowed exception here would hide a real failure, and
      // `choose()` below carries the file either way.
      const settable =
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set !==
        undefined;
      if (settable) input.files = e.dataTransfer.files;
      choose(dropped);
    });

    function ttlDays() {
      return document.querySelector('input[name="ttl"]:checked')?.value ?? "1";
    }

    function setProgress(loaded, total) {
      const ratio = total > 0 ? loaded / total : 0;
      const whole = Math.min(100, Math.round(ratio * 100));
      fill.style.width = whole + "%";
      pct.textContent =
        "UPLINK " + whole + "% — " + humanSize(loaded) + " of " + humanSize(total);
    }

    function fail(text) {
      busy = false;
      send.disabled = false;
      send.textContent = "SEND IT";
      prog.className = "prog hidden";
      say(text, true);
    }

    function succeed(body) {
      // Stays disabled until another file is chosen — the label names the
      // next action, the disabled state says what it still needs.
      send.textContent = "SEND ANOTHER";
      send.disabled = true;
      prog.className = "prog hidden";
      // Encrypted drops: the share link carries the fragment key. Appending it
      // here (not before upload) keeps the key off the wire entirely.
      const shareUrl = body.url + (fragment || "");
      link.textContent = shareUrl;
      link.setAttribute("href", shareUrl);
      expiry.textContent =
        "EXPIRES " + absolute(body.expires_at) + " — " + relative(body.expires_at) + ".";
      result.className = "panel";
      file = null;
      chosen.textContent = "";
      input.value = "";
    }

    // Status -> message. 503 is not an error the user caused, and does not read
    // like one; 429 arrives once Step 6's rate limits exist.
    function failureText(status, body) {
      if (status === 401) return "REFUSED — sign in to upload.";
      if (status === 413) return "REFUSED — over the 25 MB ceiling.";
      if (status === 503) {
        return "CLOSED FOR THE DAY — the daily budget is spent. Try tomorrow.";
      }
      if (status === 429) return "THROTTLED — too many uploads too fast. Wait a minute.";
      if (status === 400 || status === 411) {
        return body?.error
          ? "REFUSED — " + body.error + "."
          : "REFUSED. Check the file and try again.";
      }
      return "FAILED (" + status + "). Nothing was stored.";
    }

    function parseBody(text) {
      try {
        return JSON.parse(text);
      } catch {
        // A non-JSON body means the response did not come from the API path
        // (an edge error page, say). Not recoverable here, and not silently
        // ignored: the caller falls through to failureText(), which reports
        // the status code it did get.
        return null;
      }
    }

    send.addEventListener("click", async () => {
      if (!file || busy) return;
      busy = true;
      clearMsg();
      send.disabled = true;
      send.textContent = "SENDING";
      prog.className = "prog";
      fill.style.width = "0%";
      pct.textContent = "0%";

      // Optional download PIN (Workstream E): derive H_gate from the PIN and
      // send only the proof. The PIN itself never leaves the page. chatcrypto
      // is present because /s.js now concatenates it.
      let pinGate = null;
      const pin = $("pin");
      if (pin && pin.value) {
        const problem = window.talviGate?.pinProblem(pin.value);
        if (problem) {
          busy = false;
          send.disabled = false;
          send.textContent = "SEND IT";
          prog.className = "prog hidden";
          say(problem, true);
          return;
        }
        const name = "relay"; // must match the derivation name on the view page
        const master = await window.talviGate.deriveMasterHex(pin.value, name);
        pinGate = window.talviGate.gateHex(master, name);
      }

      // Fragment-key E2E encryption (blueprint B1): default ON. If enabled,
      // encrypt the file's bytes in this browser with a fresh AES-256-GCM key,
      // send the ciphertext, and append the key to the share URL as #k=… so it
      // never crosses the wire. The server stores ciphertext + the flag.
      let body = file;
      fragment = "";
      const encryptBox = $("encrypt");
      const encryptOn = encryptBox ? encryptBox.checked : false;
      if (encryptOn) {
        if (!window.talviCrypto) {
          busy = false;
          send.disabled = false;
          send.textContent = "SEND IT";
          prog.className = "prog hidden";
          say("ENCRYPTION UNAVAILABLE — retry.", true);
          return;
        }
        send.textContent = "ENCRYPTING";
        try {
          const bytes = await file.arrayBuffer();
          const key = window.talviCrypto.newKey();
          const ciphertext = await window.talviCrypto.encrypt(key, bytes);
          body = new Blob([ciphertext], { type: "application/octet-stream" });
          fragment = "#k=" + key;
        } catch {
          busy = false;
          send.disabled = false;
          send.textContent = "SEND IT";
          prog.className = "prog hidden";
          say("ENCRYPTION FAILED — nothing was sent.", true);
          return;
        }
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/relay/api/upload", true);
      xhr.setRequestHeader("x-drop-ttl", ttlDays());
      // Percent-encoded: a header value must be ISO-8859-1, and a filename is
      // not. The Worker percent-decodes before sanitising (src/sanitise.js).
      xhr.setRequestHeader("x-drop-filename", encodeURIComponent(file.name));
      if (file.type) {
        xhr.setRequestHeader("x-drop-type", file.type);
      }
      if (pinGate) {
        xhr.setRequestHeader("x-drop-pin-gate", pinGate);
      }
      if (encryptOn) {
        xhr.setRequestHeader("x-drop-encrypted", "1");
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(e.loaded, e.total);
      };

      xhr.upload.onload = () => {
        // Bytes are up; the Worker is still writing to R2 and D1.
        pct.textContent = "STORING — holding the line";
      };      xhr.onerror = () => {
        // A network/edge failure (not a status we can read — the request
        // never completed). Navigate to the upload page so the visitor can
        // retry; the chosen file is lost, and the message says so.
        fail("FAILED — connection error. Nothing was stored.");
      };

      xhr.onload = () => {
        busy = false;
        const body = parseBody(xhr.responseText);
        if (xhr.status === 200 && body?.url) {
          succeed(body);
          return;
        }
        // 401 = no (or invalid) __session cookie. Full-page navigation to the
        // sign-in page so clerk-js can run the flow and set the cookie.
        if (xhr.status === 401) {
          window.location.href = "/relay/sign-in";
          return;
        }
        fail(failureText(xhr.status, body));
      };

      xhr.send(body);
    });

    copy?.addEventListener("click", () => copyText(link.textContent, copy, "COPIED"));
  }

  // -------------------------------------------------------------- view page

  // Progressive enhancement: the server already rendered an absolute expiry in
  // UTC. This upgrades it to the reader's own locale plus a relative phrase.
  // With JS off, the page still says exactly when the file dies.
  function initView() {
    const when = $("expires");
    const iso = when?.getAttribute("data-expires");
    if (!iso) return;
    const rel = relative(iso);
    when.textContent = absolute(iso) + (rel ? " — " + rel : "");

    // "as markdown" feedback (markdown sidequest). A plain link that navigates
    // to /:slug/md works with JS off; with it on, the click relabels the button
    // while the server converts. A successful conversion downloads (attachment)
    // so the page stays; the label reverts on a timer because a navigation-based
    // download offers no completion event to hook.
    const md = document.querySelector("a[data-md]");
    if (md) {
      const label = md.textContent;
      md.addEventListener("click", () => {
        md.textContent = "converting…";
        md.setAttribute("aria-busy", "true");
        window.setTimeout(() => {
          md.textContent = label;
          md.removeAttribute("aria-busy");
        }, 10000);
      });
    }

    // Fragment-key E2E encryption (blueprint B1). The server rendered a
    // "Decrypt & download" button whose href still points at /d (ciphertext).
    // Intercept it: fetch the ciphertext, decrypt in this browser with the key
    // from the link's #k= fragment, and offer the plaintext as a download. The
    // key never leaves the page — it is read from location.hash, which no
    // request ever carries.
    // Shared by both encrypted actions below (decrypt-download and
    // decrypt-then-OCR): the message line, the filename element, and the
    // message writer. Hoisted to initView scope — encSay lived inside the
    // first handler's block, which made the "as markdown" handler crash with
    // "encSay is not defined" (owner report 2026-08-11).
    const msg = $("encmsg");
    const nameEl = document.querySelector(".hud__value--verbatim");

    function encSay(text, isError) {
      if (!msg) return;
      msg.textContent = text;
      msg.classList.remove("hidden");
      msg.classList.toggle("msg--bad", Boolean(isError));
    }

    const enc = document.querySelector("a.dl[data-encrypted]");
    if (enc && window.talviCrypto) {
      const slug = enc.getAttribute("href");

      enc.addEventListener("click", async (e) => {
        e.preventDefault();
        // A gated drop: the server cookie from the PIN answer is required for
        // the /d fetch. If the button was revealed by initGate, the cookie is
        // set; otherwise the fetch 401s and we hand back to the server.
        const keyStr = window.talviCrypto.parseFragmentKey(window.location.hash);
        if (!keyStr) {
          encSay(
            "NO KEY IN THIS LINK — the #k= fragment is missing. Ask the sender " +
              "for the full link.",
            true,
          );
          return;
        }
        if (enc.classList.contains("hidden")) return;
        enc.disabled = true;
        enc.textContent = "DECRYPTING…";
        try {
          const res = await fetch(slug);
          if (!res.ok) {
            // No gate cookie / expired drop: let the server route decide.
            window.location.href = slug;
            return;
          }
          const ciphertext = await res.arrayBuffer();
          const plain = await window.talviCrypto.decrypt(keyStr, ciphertext);
          const blob = new Blob([plain], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = nameEl?.textContent?.trim() || "file";
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
          enc.textContent = "DOWNLOADING…";
        } catch {
          // GCM tag failure = wrong key or tampered ciphertext.
          encSay(
            "WRONG KEY — this link's #k= fragment does not decrypt this file. " +
              "Check the link is complete.",
            true,
          );
          enc.textContent = "Decrypt & download";
        }
        enc.disabled = false;
      });
    }

    // Encrypted drop → "as markdown" (owner 2026-08-11). The server cannot OCR
    // ciphertext, so this decrypts the image here, POSTs the plaintext to
    // /md (processed, never stored), and offers the .md result as a download.
    const encMd = document.querySelector("a.dl--alt[data-encrypted-md]");
    if (encMd && window.talviCrypto) {
      const mdHref = encMd.getAttribute("href");
      const mdLabel = "as markdown";
      encMd.addEventListener("click", async (e) => {
        e.preventDefault();
        const keyStr = window.talviCrypto.parseFragmentKey(window.location.hash);
        if (!keyStr) {
          encSay(
            "NO KEY IN THIS LINK — the #k= fragment is missing. Ask the sender " +
              "for the full link.",
            true,
          );
          return;
        }
        encMd.textContent = "CONVERTING…";
        try {
          const cipher = await fetch(mdHref.replace(/\/md$/, "/d"));
          if (!cipher.ok) {
            window.location.href = mdHref;
            return;
          }
          const plain = await window.talviCrypto.decrypt(
            keyStr,
            await cipher.arrayBuffer(),
          );
          const mdRes = await fetch(mdHref, { method: "POST", body: plain });
          if (!mdRes.ok) {
            encSay("CONVERSION FAILED — try again.", true);
            return;
          }
          const stem = (nameEl?.textContent?.trim() || "file").replace(
            /\.[A-Za-z0-9]{1,5}$/,
            "",
          );
          const url = URL.createObjectURL(await mdRes.blob());
          const a = document.createElement("a");
          a.href = url;
          a.download = stem + ".md";
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch {
          encSay("CONVERSION FAILED — wrong key or the server refused.", true);
        }
        encMd.textContent = mdLabel;
      });
    }
  }

  // ------------------------------------------------------- download PIN gate

  // A gated drop (Workstream E): the server rendered a PIN prompt instead of
  // the download buttons. On UNLOCK, derive H_gate from the PIN (same KDF chat
  // uses, published by chatcrypto.js on window.talviGate), prove it over the
  // challenge-response endpoint, and on success reveal the download links. The
  // server's Set-Cookie does the actual granting — this JS only drives the
  // round trip and flips the visibility.
  function initGate() {
    const unlock = $("unlock");
    const pin = $("pin");
    if (!unlock || !pin || !window.talviGate) return;

    const slug = window.location.pathname.split("/").filter(Boolean).pop();
    const msg = $("pinmsg");

    function say(text, isError) {
      if (!msg) return;
      msg.textContent = text;
      msg.classList.toggle("hidden", false);
      msg.classList.toggle("msg--err", Boolean(isError));
    }

    unlock.addEventListener("click", async () => {
      unlock.disabled = true;
      say("CHECKING…", false);
      try {
        const problem = window.talviGate.pinProblem(pin.value);
        if (problem) {
          say(problem, true);
          unlock.disabled = false;
          return;
        }
        const name = "relay"; // must match the derivation name used at upload
        const master = await window.talviGate.deriveMasterHex(pin.value, name);
        const gate = window.talviGate.gateHex(master, name);

        // Challenge.
        const ch = await fetch("/relay/" + slug + "/gate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "challenge" }),
        });
        if (!ch.ok) {
          say("LOCKED — try again later.", true);
          unlock.disabled = false;
          return;
        }
        const { nonce } = await ch.json();

        // Answer.
        const answer = await window.talviGate.answerHex(gate, nonce);
        const ans = await fetch("/relay/" + slug + "/gate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "answer", nonce, answer }),
        });
        if (!ans.ok) {
          say("PIN NOT ACCEPTED.", true);
          unlock.disabled = false;
          return;
        }

        // Admitted — reveal the download actions (the gate cookie is set).
        say("OPEN.", false);
        const dl = document.querySelector(".dl");
        if (dl) dl.classList.remove("hidden");
        const md = document.querySelector(".dl--alt");
        if (md) md.classList.remove("hidden");
        const gateBox = document.querySelector(".gate");
        if (gateBox) gateBox.classList.add("hidden");
      } catch {
        say("GATE ERROR — try again.", true);
        unlock.disabled = false;
      }
    });
  }

  // ------------------------------------------------------- typed reveal

  // Types out elements marked [data-type]. Progressive enhancement done
  // honestly: the full text is already in the DOM from the server, so a
  // screen reader, a search crawler, and a JS-off reader all get the complete
  // string. This only *re-reveals* text that is already there — it never
  // supplies content, so nothing is lost when it does not run.
  function initTyping() {
    const targets = document.querySelectorAll("[data-type]");
    if (!targets.length) return;

    // Honoured here as well as in CSS: typing is motion, and a user who asked
    // for less of it should get the finished text immediately, not a fast
    // version of the same effect.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) return;

    for (const [index, el] of [...targets].entries()) {
      const full = el.textContent;
      el.textContent = "";
      const cursor = document.createElement("span");
      cursor.className = "cursor";
      el.appendChild(cursor);

      let i = 0;
      const startAt = 220 + index * 260; // after the element's own light-up
      window.setTimeout(() => {
        const tick = window.setInterval(() => {
          i += 1;
          cursor.remove();
          el.textContent = full.slice(0, i);
          if (i >= full.length) {
            window.clearInterval(tick);
            return;
          }
          el.appendChild(cursor);
        }, 14);
      }, startAt);
    }
  }

  function boot() {
    initUpload();
    initView();
    initGate();
    initTyping();
  }

  // CRITICAL ordering bug (fixed 2026-08-11): with `defer`, this script runs
  // when readyState is already "interactive", so the old `else { boot(); }`
  // fired boot() IMMEDIATELY — while client.js is the FIRST file in the /s.js
  // concatenation and chatcrypto.js/fragmentcrypto.js run AFTER it. At boot
  // time window.talviGate / window.talviCrypto were still undefined, so the
  // download-PIN gate and the encrypted "Decrypt & download" handler never
  // attached — gated drops asked for no PIN, and an encrypted drop's button
  // just navigated to /d and downloaded the CIPHERTEXT (unusable file).
  //
  // Always wait for DOMContentLoaded, which fires after the whole /s.js has
  // executed, so every concatenated helper exists. The `complete` branch is
  // only for a script loaded without defer after the page finished.
  if (document.readyState === "complete") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
