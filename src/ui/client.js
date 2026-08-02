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

(function () {
  "use strict";

  var MAX_BYTES = 25 * 1024 * 1024; // mirrors MAX_BYTES in src/index.js

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
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "expired";
    var mins = Math.round(ms / 60000);
    if (mins < 60) return "in " + mins + (mins === 1 ? " minute" : " minutes");
    var hours = Math.round(mins / 60);
    if (hours < 48) return "in " + hours + (hours === 1 ? " hour" : " hours");
    var days = Math.round(hours / 24);
    return "in " + days + (days === 1 ? " day" : " days");
  }

  function absolute(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
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

  function copyText(text, button, doneLabel) {
    var restore = button.textContent;

    function confirmed() {
      button.textContent = doneLabel;
      button.classList.add("is-done");
      window.setTimeout(function () {
        button.textContent = restore;
        button.classList.remove("is-done");
      }, 2000);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(confirmed, function () {
        selectFallback(text, button, confirmed);
      });
      return;
    }
    selectFallback(text, button, confirmed);
  }

  // Fallback for a browser without the async clipboard API, or one that
  // refuses it (it needs a secure context and can be permission-gated):
  // select the link text so the user can copy it with the keyboard, and say so.
  function selectFallback(text, button, confirmed) {
    var target = $("link");
    if (target && window.getSelection && document.createRange) {
      var range = document.createRange();
      range.selectNodeContents(target);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = "PRESS COPY KEYS";
      window.setTimeout(function () {
        button.textContent = "COPY LINK";
      }, 2600);
      return;
    }
    confirmed();
  }

  // ------------------------------------------------------------ upload page

  function initUpload() {
    var drop = $("drop");
    var input = $("file");
    var chosen = $("chosen");
    var send = $("send");
    var prog = $("prog");
    var fill = $("fill");
    var pct = $("pct");
    var msg = $("msg");
    var result = $("result");
    var link = $("link");
    var copy = $("copy");
    var expiry = $("expiry");
    if (!drop || !input || !send) return; // not this page

    var file = null;
    var busy = false;

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
      chosen.textContent = f.name + " · " + humanSize(f.size);
      // Client-side size check is a courtesy, not a control — the Worker
      // rejects oversize with 413 regardless of what this does.
      if (f.size > MAX_BYTES) {
        say("That file is " + humanSize(f.size) + ". The ceiling is 25 MB.", true);
        send.disabled = true;
        return;
      }
      clearMsg();
      send.disabled = false;
    }

    input.addEventListener("change", function () {
      choose(input.files && input.files[0] ? input.files[0] : null);
    });

    // Drag and drop. dragover must be prevented or the browser navigates to
    // the dropped file instead of handing it over.
    ["dragenter", "dragover"].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        drop.classList.add("is-over");
      });
    });

    ["dragleave", "dragend"].forEach(function (evt) {
      drop.addEventListener(evt, function () {
        drop.classList.remove("is-over");
      });
    });

    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("is-over");
      if (busy) return;
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        // Keep the real <input> in sync so the form control and the visible
        // state never disagree. DataTransfer assignment is supported wherever
        // drag-and-drop of files is.
        try {
          input.files = dt.files;
        } catch (err) {
          /* older browser — the local `file` reference below still carries it */
        }
        choose(dt.files[0]);
      }
    });

    function ttlDays() {
      var picked = document.querySelector('input[name="ttl"]:checked');
      return picked ? picked.value : "1";
    }

    function setProgress(loaded, total) {
      var ratio = total > 0 ? loaded / total : 0;
      var whole = Math.min(100, Math.round(ratio * 100));
      fill.style.width = whole + "%";
      pct.textContent = whole + "% · " + humanSize(loaded) + " of " + humanSize(total);
    }

    function fail(text) {
      busy = false;
      send.disabled = false;
      send.textContent = "SEND IT";
      prog.className = "prog hidden";
      say(text, true);
    }

    send.addEventListener("click", function () {
      if (!file || busy) return;
      busy = true;
      clearMsg();
      send.disabled = true;
      send.textContent = "SENDING";
      prog.className = "prog";
      fill.style.width = "0%";
      pct.textContent = "0%";

      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("x-drop-ttl", ttlDays());
      // Percent-encoded: a header value must be ISO-8859-1, and a filename is
      // not. The Worker percent-decodes before sanitising (src/sanitise.js).
      xhr.setRequestHeader("x-drop-filename", encodeURIComponent(file.name));
      if (file.type) {
        xhr.setRequestHeader("x-drop-type", file.type);
      }

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setProgress(e.loaded, e.total);
      };

      xhr.upload.onload = function () {
        // Bytes are up; the Worker is still writing to R2 and D1.
        pct.textContent = "STORING";
      };

      xhr.onerror = function () {
        fail("The connection dropped. Nothing was stored — try again.");
      };

      xhr.onload = function () {
        busy = false;
        var body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (err) {
          body = null;
        }

        if (xhr.status === 200 && body && body.url) {
          // Stays disabled until another file is chosen — the label names the
          // next action, the disabled state says what it still needs.
          send.textContent = "SEND ANOTHER";
          send.disabled = true;
          prog.className = "prog hidden";
          link.textContent = body.url;
          link.setAttribute("href", body.url);
          expiry.textContent =
            "Expires " + absolute(body.expires_at) + " — " + relative(body.expires_at) + ".";
          result.className = "panel";
          file = null;
          chosen.textContent = "";
          input.value = "";
          return;
        }

        if (xhr.status === 413) {
          fail("Too big. The ceiling is 25 MB per file.");
          return;
        }
        if (xhr.status === 503) {
          fail("Closed for the day — the daily budget is spent. Try tomorrow.");
          return;
        }
        if (xhr.status === 429) {
          fail("Too many uploads too fast. Wait a minute and try again.");
          return;
        }
        if (xhr.status === 400 || xhr.status === 411) {
          fail(
            body && body.error
              ? "Rejected: " + body.error + "."
              : "Rejected. Check the file and try again.",
          );
          return;
        }
        fail("Upload failed (" + xhr.status + "). Nothing was stored.");
      };

      xhr.send(file);
    });

    if (copy) {
      copy.addEventListener("click", function () {
        copyText(link.textContent, copy, "COPIED");
      });
    }
  }

  // -------------------------------------------------------------- view page

  // Progressive enhancement: the server already rendered an absolute expiry in
  // UTC. This upgrades it to the reader's own locale plus a relative phrase.
  // With JS off, the page still says exactly when the file dies.
  function initView() {
    var when = $("expires");
    if (!when) return;
    var iso = when.getAttribute("data-expires");
    if (!iso) return;
    var rel = relative(iso);
    when.textContent = absolute(iso) + (rel ? " — " + rel : "");
  }

  function boot() {
    initUpload();
    initView();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
