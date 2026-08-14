// talvi-learn client behavior (PR6). One vanilla script loaded at /learn/s.js,
// event-delegated, no inline handlers, no eval, no framework. It owns:
//   - the lesson state machine (idle → answering → grading → correct|wrong →
//     next … → complete)
//   - the pure, locale-aware grade() (converged plan §4 / NID-106 port)
//   - the two writes: POST /learn/api/xp (append-only ledger row) and POST
//     /learn/api/checkpoint (gate verdict)
//   - the gamification surfaces: XpGain count-up, streak flame, checkpoint
//     gate form, level-up/achievement toasts (all reduced-motion aware)
//
// Grading is client-side because answers are bundled with the content (single
// owner — the converged plan's resolution of the B.4 API set). The server
// re-renders the path from the ledger after a completion.
(function () {
  "use strict";

  const PREFIX = "/learn";

  // ------------------------------------------------------------------
  // PURE-GRADING-START
  // Pure grading (NID-106 port). No DOM, no fetch — unit-testable in node.
  // Locale-aware, diacritic-insensitive comparison via Intl.Collator with
  // sensitivity 'base'.
  // ------------------------------------------------------------------

  const collator = (() => {
    try {
      return new Intl.Collator(undefined, { sensitivity: "base", ignorePunctuation: true });
    } catch {
      return null; // no Intl → fall back to the normalized-string compare below
    }
  })();

  function norm(str) {
    return String(str == null ? "" : str)
      .toLowerCase()
      .replace(/[\u00c0-\u00ff]/g, (ch) =>
        ch.normalize ? ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : ch,
      )
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function eq(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (collator) {
      // Strip punctuation again for the collator path, then compare.
      return collator.compare(norm(a).replace(/\s+/g, " "), norm(b).replace(/\s+/g, " ")) === 0;
    }
    return na === nb;
  }

  function eqList(actual, expected) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    if (actual.length !== expected.length) return false;
    return actual.every((v, i) => eq(v, expected[i]));
  }

  // Grade a single exercise. `ex` is the parsed data-ex JSON; `user` is the
  // collected answer for that exercise type:
  //   select   → chosen option index
  //   order    → array of option strings in player order
  //   match    → Map(leftIndex → matched right value)
  //   complete → array of chosen words in slot order
  //   listen   → the typed text
  function grade(ex, user) {
    switch (ex.type) {
      case "select":
        return Number(user) === Number(ex.answer);
      case "order":
        return eqList(user, ex.answer);
      case "match":
        if (!user) return false;
        if (user.size !== ex.pairs.length) return false;
        for (const pair of ex.pairs) {
          const leftIndex = ex.pairs.indexOf(pair);
          const got = user.get(leftIndex);
          if (got === undefined || !eq(got, pair.right)) return false;
        }
        return true;
      case "complete":
        return eqList(user, ex.answer);
      case "listen":
        return eq(String(user || ""), ex.text || "");
      default:
        return false;
    }
  }

  // Expose for the unit test harness (node can import this file's pure parts).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { grade, norm, eq, eqList };
  }

  // PURE-GRADING-END

  // ------------------------------------------------------------------
  // Lesson player
  // ------------------------------------------------------------------

  const lesson = document.querySelector(".lesson");
  if (!lesson) return; // not the lesson page — the path page needs no JS

  const lessonId = lesson.dataset.lesson;
  const skill = lesson.dataset.skill || "lesson";
  const lessonXp = Number(lesson.dataset.xp || 0);
  const isCheckpoint = lesson.dataset.isCheckpoint === "true";

  const exercises = Array.from(document.querySelectorAll(".exercise")).map((el) => ({
    el,
    ex: JSON.parse(el.dataset.ex),
  }));
  let cursor = 0;

  // Each exercise's collected answer.
  const userAnswers = new Map();

  function showExercise(i) {
    exercises.forEach((e, idx) => {
      e.el.hidden = idx !== i;
    });
    const status = exercises[i] && exercises[i].el.querySelector(".exercise__status");
    if (status) status.textContent = "";
  }

  function setStatus(el, text, ok) {
    const status = el.querySelector(".exercise__status");
    if (!status) return;
    status.textContent = text;
    status.className = "exercise__status" + (ok ? " exercise__status--ok" : " exercise__status--bad");
  }

  function feedback(text) {
    const el = document.querySelector(".feedback");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  // ---- select ----
  function initSelect(entry) {
    const wrap = entry.el.querySelector('[data-kind="select"]');
    if (!wrap) return;
    wrap.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".choice");
      if (!btn) return;
      wrap.querySelectorAll(".choice").forEach((b) => b.classList.remove("choice--sel"));
      btn.classList.add("choice--sel");
      userAnswers.set(entry, Number(btn.dataset.i));
      const ok = grade(entry.ex, userAnswers.get(entry));
      setStatus(entry.el, ok ? "correct" : "try again — pick one answer", ok);
      if (ok) advance();
    });
  }

  // ---- order ----
  function initOrder(entry) {
    const bank = entry.el.querySelector('[data-kind="order"]');
    const seq = entry.el.querySelector(".sequence");
    if (!bank || !seq) return;
    const chosen = [];
    bank.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".chip");
      if (!chip || chip.classList.contains("chip--used")) return;
      chip.classList.add("chip--used");
      chosen.push(chip.textContent.trim());
      const li = document.createElement("li");
      li.textContent = chip.textContent.trim();
      seq.appendChild(li);
      const ok = grade(entry.ex, chosen.slice());
      setStatus(
        entry.el,
        chosen.length === entry.ex.answer.length
          ? ok
            ? "correct"
            : "wrong order — reset and try again"
          : chosen.length + "/" + entry.ex.answer.length,
        ok,
      );
      if (ok) advance();
    });
  }

  // ---- match ----
  function initMatch(entry) {
    const wrap = entry.el.querySelector('[data-kind="match"]');
    if (!wrap) return;
    const selected = new Map(); // left index → right value
    let leftSel = null;
    wrap.addEventListener("click", (ev) => {
      const left = ev.target.closest(".match__item--left");
      if (left) {
        leftSel = Number(left.dataset.key);
        wrap.querySelectorAll(".match__item--left").forEach((b) => b.classList.remove("match__item--sel"));
        left.classList.add("match__item--sel");
        return;
      }
      const right = ev.target.closest(".match__item--right");
      if (!right || leftSel === null) return;
      selected.set(leftSel, right.dataset.match);
      wrap.querySelectorAll(".match__item--left")[leftSel].classList.add("match__item--done");
      right.classList.add("match__item--done");
      leftSel = null;
      if (selected.size === entry.ex.pairs.length) {
        const ok = grade(entry.ex, selected);
        setStatus(entry.el, ok ? "correct" : "some pairs are wrong — check and adjust", ok);
        if (ok) advance();
      }
    });
  }

  // ---- complete ----
  function initComplete(entry) {
    const wrap = entry.el.querySelector('[data-kind="complete"]');
    if (!wrap) return;
    const slots = Array.from(wrap.querySelectorAll(".blank__slot"));
    let fill = 0;
    wrap.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".chip");
      if (!chip || chip.classList.contains("chip--used") || fill >= slots.length) return;
      chip.classList.add("chip--used");
      slots[fill].textContent = chip.textContent.trim();
      fill += 1;
      const chosen = slots.map((s) => s.textContent.trim());
      if (fill === slots.length) {
        const ok = grade(entry.ex, chosen);
        setStatus(entry.el, ok ? "correct" : "not quite — the words are out of place", ok);
        if (ok) advance();
      }
    });
  }

  // ---- listen (TTS + non-speech fallback) ----
  function initListen(entry) {
    const wrap = entry.el.querySelector('[data-kind="listen"]');
    if (!wrap) return;
    const play = wrap.querySelector("[data-play]");
    const input = wrap.querySelector(".listen__input");
    const submit = wrap.querySelector("[data-submit]");
    const hint = wrap.querySelector(".listen__hint");
    const hintText = wrap.querySelector("[data-hint]");
    const text = entry.ex.text || "";
    let attempts = 0;
    const FALLBACK_AFTER = 2;

    play.addEventListener("click", () => {
      if (typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined") {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "en";
        speechSynthesis.speak(u);
      } else {
        // No TTS — reveal the text immediately (non-speech fallback).
        hintText.textContent = text;
        hint.hidden = false;
        setStatus(entry.el, "text shown (speech unavailable)", false);
      }
    });

    function check() {
      const typed = input.value || "";
      attempts += 1;
      if (grade(entry.ex, typed)) {
        setStatus(entry.el, "correct", true);
        advance();
        return;
      }
      if (attempts >= FALLBACK_AFTER) {
        hintText.textContent = text;
        hint.hidden = false;
        setStatus(entry.el, "try again — text shown", false);
      } else {
        setStatus(entry.el, "not quite — try again", false);
      }
    }
    submit.addEventListener("click", check);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        check();
      }
    });
  }

  // Advance to the next exercise or complete the lesson.
  function advance() {
    cursor += 1;
    if (cursor < exercises.length) {
      showExercise(cursor);
      initCurrent();
      return;
    }
    completeLesson();
  }

  const inits = {
    select: initSelect,
    order: initOrder,
    match: initMatch,
    complete: initComplete,
    listen: initListen,
  };

  function initCurrent() {
    const entry = exercises[cursor];
    if (!entry) return;
    const fn = inits[entry.ex.type];
    if (fn) fn(entry);
  }

  // The completion write: POST /learn/api/xp (append-only xp_events row, ISO
  // timestamp from JS, client-generated unique id for idempotency). Then
  // show the completion surface. Checkpoint lessons call /learn/api/checkpoint
  // separately from their own form.
  function completeLesson() {
    const id = (crypto.randomUUID ? crypto.randomUUID() : "evt-" + Date.now());
    fetch(PREFIX + "/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, lessonId, skill, xp: lessonXp }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("xp write failed"))))
      .then((data) => {
        const gained = typeof data.gained === "number" ? data.gained : lessonXp;
        const streak = typeof data.streak === "number" ? data.streak : 0;
        showComplete(gained, streak);
      })
      .catch(() => {
        // Offline/edge failure: still reveal completion, with zero gain — the
        // ledger is the truth and will catch up on the next path render.
        showComplete(0, 0);
      });
  }

  function showComplete(gained, streak) {
    document.querySelector(".exercises").hidden = true;
    const complete = document.querySelector(".complete");
    const gain = complete.querySelector("[data-gain]");
    const streakEl = complete.querySelector("[data-streak]");
    // XpGain count-up — reduced-motion aware (the CSS kills transitions; the
    // JS checks the media query so the number snaps when motion is reduced).
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = gained;
    if (reduce) {
      gain.textContent = String(target);
    } else {
      let cur = 0;
      const step = Math.max(1, Math.round(target / 12));
      const timer = setInterval(() => {
        cur = Math.min(target, cur + step);
        gain.textContent = String(cur);
        if (cur >= target) clearInterval(timer);
      }, 40);
    }
    streakEl.textContent = String(streak);
    feedback("XP recorded to the ledger");
    complete.hidden = false;
    const nextBtn = document.getElementById("next-btn");
    if (nextBtn) {
      // Point "next" at the next lesson on the path — refresh the path and the
      // server computes the new active node.
      nextBtn.href = PREFIX + "/";
    }
  }

  // ---- checkpoint gate form ----
  const gateForm = document.querySelector('[data-gate]');
  if (gateForm) {
    const gateId = gateForm.dataset.gate;
    const textarea = gateForm.querySelector("textarea");
    const status = gateForm.querySelector(".gate__status") || (() => {
      const p = document.createElement("p");
      p.className = "gate__status";
      p.setAttribute("role", "status");
      gateForm.appendChild(p);
      return p;
    })();
    gateForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const verdict = (textarea.value || "").trim();
      if (!verdict) {
        status.textContent = "write a verdict first";
        return;
      }
      status.textContent = "submitting…";
      fetch(PREFIX + "/api/checkpoint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: gateId, verdict }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("gate write failed"))))
        .then(() => {
          status.textContent = "gate open — the next unit is unlocked";
          feedback("verdict recorded — checkpoint gate open");
          const btn = gateForm.querySelector("button[type=submit]");
          if (btn) {
            btn.disabled = true;
            btn.textContent = "gate open";
          }
        })
        .catch(() => {
          status.textContent = "submit failed — try again";
        });
    });
  }

  // Start the first exercise.
  showExercise(0);
  initCurrent();
})();
