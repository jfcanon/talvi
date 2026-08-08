// talvi — browser-side JS. Served at /s.js.
//
// A real, standalone .js file, not a JS template literal (B.9): the backticks
// and ${} below are ordinary source here, and build-assets.mjs JSON.stringify()s
// the whole file, so there is no hand-escaping step to get wrong.
//
// Never inlined: the CSP is `script-src 'self'` with no 'unsafe-inline'
// (B.7 item 3). That is why this is a file and not a <script> block.
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
      link.textContent = body.url;
      link.setAttribute("href", body.url);
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

    send.addEventListener("click", () => {
      if (!file || busy) return;
      busy = true;
      clearMsg();
      send.disabled = true;
      send.textContent = "SENDING";
      prog.className = "prog";
      fill.style.width = "0%";
      pct.textContent = "0%";

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("x-drop-ttl", ttlDays());
      // Percent-encoded: a header value must be ISO-8859-1, and a filename is
      // not. The Worker percent-decodes before sanitising (src/sanitise.js).
      xhr.setRequestHeader("x-drop-filename", encodeURIComponent(file.name));
      if (file.type) {
        xhr.setRequestHeader("x-drop-type", file.type);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(e.loaded, e.total);
      };

      xhr.upload.onload = () => {
        // Bytes are up; the Worker is still writing to R2 and D1.
        pct.textContent = "STORING — holding the line";
      };

      xhr.onerror = () => {
        // An XHR POST cannot follow the Cloudflare Access 302 to the
        // cross-origin PIN page — the browser blocks reading it and this
        // handler fires. The fix is a full-page navigation to /api/upload:
        // Access shows the email PIN, sets its cookie, and redirects back.
        // After that, a retry carries the cookie and uploads normally.
        window.location.href = "/api/upload";
      };

      xhr.onload = () => {
        busy = false;
        const body = parseBody(xhr.responseText);
        if (xhr.status === 200 && body?.url) {
          succeed(body);
          return;
        }
        fail(failureText(xhr.status, body));
      };

      xhr.send(file);
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
    initTyping();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
