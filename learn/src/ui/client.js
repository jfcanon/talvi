// talvi-learn client behavior (PR6). One vanilla script, event-delegated, no
// inline handlers, no eval, no framework. Served at /learn/s.js (the strict
// CSP is why behavior is a file, not inline).
//
// Owns:
//   - the lesson player state machine (exercise widgets + grading)
//   - the checkpoint gate form
//   - gamification wiring: XP/streak HUD + lesson completion
//   - hearts (optional-off) + celebrations (class-toggle, never inline)
//   - onboarding: welcome modal, guided tour, pre-read gate, progress ring
//
// The server is truth for gamification. The client NEVER computes XP or streak:
// it POSTs completion to /learn/api/complete and renders the numbers the server
// returns (PR4 store: recordCompletion evaluates server-side, idempotent per
// lesson; streak increments once/day server-side). Hearts are a client-side
// session mechanic rendered from server player.hearts (locked decision 6: the
// PR4 API surface is state+complete only, so a heart lost is tracked in-page,
// not persisted — documented in the PR body).
//
// Answers ride in data-ex attributes (bundled content, single owner, client
// grading). Grading below is pure: grade(ex, answer) → { ok, correct }.
const PREFIX = "/learn";

// Hearts are optional-off (locked decision 6). One flag — flip to false to drop
// the hearts HUD and the wrong-answer penalty. Must match index.js's
// HEARTS_ENABLED used for server-side rendering of the pill.
const HEARTS_ENABLED = true;

// Per-session hearts, seeded from the server's player.hearts (readState). Not
// persisted: the PR4 API surface has no hearts write endpoint (see PR body).
let hearts = 5;

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === "choose") return onChoose(event, btn);
  if (action === "order-add") return onOrderAdd(btn);
  if (action === "order-remove") return onOrderRemove(btn);
  if (action === "match-left") return onMatchLeft(btn);
  if (action === "match-right") return onMatchRight(btn);
  if (action === "bank-fill") return onBankFill(btn);
  if (action === "blank-pop") return onBlankPop(btn);
  if (action === "check") return onCheck(btn);
  if (action === "continue") return onContinue(btn);
  if (action === "gate-submit") return onGateSubmit(event, btn);
  if (action === "onboard-start") return onOnboardStart(btn);
  if (action === "ready") return onReady(btn);
  if (action === "begin-lesson") return onBeginLesson(btn);
});

// Initialize onboarding features
function initOnboarding() {
  // Welcome modal: show once per browser
  const modal = document.getElementById("welcome-modal");
  const backdrop = document.getElementById("welcome-backdrop");
  if (modal && backdrop) {
    const onboarded = localStorage.getItem("tl_onboarded");
    if (!onboarded) {
      modal.hidden = false;
      backdrop.hidden = false;
      modal.querySelector("[data-action='onboard-start']").focus();
    } else {
      modal.remove();
      backdrop.remove();
    }
  }

  // Guided tour: spotlight first lesson on path page
  const guidedBtn = document.getElementById("guided-tour-btn");
  const tooltip = document.getElementById("guided-tooltip");
  const firstLessonNode = document.querySelector('[data-guided="first-lesson"]');
  if (guidedBtn && tooltip && firstLessonNode) {
    const onboarded = localStorage.getItem("tl_onboarded");
    if (!onboarded) {
      guidedBtn.hidden = false;
      tooltip.hidden = false;
      // Position tooltip near the first lesson node
      positionTooltip(firstLessonNode, tooltip);
    } else {
      guidedBtn.remove();
      tooltip.remove();
    }
  }

  // Pre-read gate: the server renders the gate visible and the exercises
  // section locked (data-locked → CSS dims it and blocks pointer events);
  // onReady() is the only transition. Nothing to do at init.

  // Progress ring: initialize
  updateProgressRing(0);

  // Pre-fetch next lesson on completion screen
  const nextBtn = document.querySelector("#next-btn[data-prefetch]");
  if (nextBtn) {
    const href = nextBtn.href;
    if (href) {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    }
  }
}

function onOnboardStart(btn) {
  const modal = document.getElementById("welcome-modal");
  const backdrop = document.getElementById("welcome-backdrop");
  const guidedBtn = document.getElementById("guided-tour-btn");
  const tooltip = document.getElementById("guided-tooltip");

  localStorage.setItem("tl_onboarded", "true");

  if (modal) modal.hidden = true;
  if (backdrop) backdrop.hidden = true;
  if (guidedBtn) guidedBtn.hidden = false;
  if (tooltip) tooltip.hidden = false;

  // If on path page, navigate to first lesson after brief delay
  if (window.location.pathname === PREFIX + "/") {
    setTimeout(() => {
      window.location.href = btn.dataset.href || (PREFIX + "/lesson/u1l1");
    }, 300);
  }
}

function onBeginLesson(btn) {
  onOnboardStart(btn);
}

function onReady(btn) {
  const prereadGate = btn.closest(".preread-gate");
  const exercisesSection = document.querySelector(".exercises[data-gated='true']");
  if (prereadGate) prereadGate.hidden = true;
  if (exercisesSection) exercisesSection.removeAttribute("data-locked");
  // Focus first exercise
  const firstChoice = document.querySelector(".exercise .choice, .exercise .chip, .exercise .match__item");
  if (firstChoice) firstChoice.focus();
}

function positionTooltip(target, tooltip) {
  const rect = target.getBoundingClientRect();
  const scrollY = window.scrollY || document.documentElement.scrollTop;
  tooltip.style.top = (rect.bottom + scrollY + 8) + "px";
  tooltip.style.left = (rect.left + rect.width / 2) + "px";
  tooltip.style.transform = "translateX(-50%)";
}

function updateProgressRing(completedCount) {
  const ring = document.querySelector(".progress-ring__fill");
  const svg = document.querySelector(".progress-ring");
  if (!ring || !svg) return;
  const segments = parseInt(svg.dataset.segments) || 3;
  const circumference = 2 * Math.PI * 26; // ~163.4
  const perSegment = circumference / segments;
  const offset = circumference - (completedCount * perSegment);
  ring.style.strokeDashoffset = offset;
}

function readEx(exercise) {
  return JSON.parse(exercise.dataset.ex);
}

// ---- Exercise widgets ----

function onChoose(event, btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state) return;
  const ex = readEx(exercise);
  if (ex.type !== "select" && ex.type !== "spot" && ex.type !== "tf") return;

  const choices = btn.closest(".choices");
  for (const c of choices.querySelectorAll(".choice")) {
    c.removeAttribute("aria-pressed");
    c.classList.remove("choice--wrong");
  }
  btn.setAttribute("aria-pressed", "true");

  const answer = ex.type === "tf" ? btn.dataset.i === "1" : Number(btn.dataset.i);
  const res = grade(ex, answer);
  if (res.ok) {
    settle(exercise, res, true);
  } else {
    btn.classList.add("choice--wrong");
    settle(exercise, res, false);
  }
}

function onOrderAdd(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state) return;
  const seq = exercise.querySelector(".sequence");
  const value = btn.dataset.value ?? btn.textContent;
  if (btn.dataset.used) return;
  btn.dataset.used = "1";
  btn.classList.add("chip--used");
  const item = document.createElement("li");
  item.className = "sequence__item";
  item.textContent = value;
  item.dataset.value = value;
  item.setAttribute("data-action", "order-remove");
  item.setAttribute("tabindex", "0");
  seq.appendChild(item);
  syncCheck(exercise);
}

function onOrderRemove(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state) return;
  const value = btn.dataset.value;
  btn.remove();
  const bank = exercise.querySelector(".bank");
  for (const chip of bank.querySelectorAll(".chip")) {
    if ((chip.dataset.value ?? chip.textContent) === value && chip.dataset.used) {
      delete chip.dataset.used;
      chip.classList.remove("chip--used");
      break;
    }
  }
  syncCheck(exercise);
}

let pendingLeft = null;

function onMatchLeft(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state || btn.hasAttribute("data-paired")) return;
  const container = btn.closest(".match");
  for (const l of container.querySelectorAll(".match__item--left")) {
    l.removeAttribute("aria-pressed");
  }
  btn.setAttribute("aria-pressed", "true");
  pendingLeft = btn;
}

function onMatchRight(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state || !pendingLeft || btn.hasAttribute("data-paired")) return;
  const leftKey = pendingLeft.dataset.key;
  const rightText = btn.dataset.match;
  const map = (exercise._matchMap = exercise._matchMap || {});
  map[leftKey] = rightText;
  btn.setAttribute("data-paired", "true");
  pendingLeft.setAttribute("data-paired", "true");
  pendingLeft.removeAttribute("aria-pressed");
  pendingLeft = null;
  syncCheck(exercise);
}

function onBankFill(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state || btn.dataset.used) return;
  const blank = exercise.querySelector(".blank:not([data-filled])");
  if (!blank) return;
  const value = btn.dataset.value ?? btn.textContent;
  btn.dataset.used = "1";
  btn.classList.add("chip--used");
  blank.textContent = value;
  blank.dataset.value = value;
  blank.setAttribute("data-filled", "1");
  syncCheck(exercise);
}

function onBlankPop(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state) return;
  const value = btn.dataset.value;
  delete btn.dataset.filled;
  delete btn.dataset.value;
  btn.textContent = "";
  const bank = exercise.querySelector(".bank");
  for (const chip of bank.querySelectorAll(".chip")) {
    if ((chip.dataset.value ?? chip.textContent) === value && chip.dataset.used) {
      delete chip.dataset.used;
      chip.classList.remove("chip--used");
      break;
    }
  }
  syncCheck(exercise);
}

// Enable the check button once the widget is fully assembled.
function syncCheck(exercise) {
  const check = exercise.querySelector("[data-action='check']");
  if (!check) return;
  const ex = readEx(exercise);
  let ready = false;
  if (ex.type === "order") {
    ready = exercise.querySelectorAll(".sequence__item").length === (ex.answer || []).length;
  } else if (ex.type === "match") {
    ready = exercise.querySelectorAll(".match__item--right[data-paired]").length === (ex.pairs || []).length;
  } else if (ex.type === "complete") {
    ready = exercise.querySelectorAll(".blank[data-filled]").length === (ex.answer || []).length;
  }
  check.disabled = !ready;
}

function onCheck(btn) {
  const exercise = btn.closest(".exercise");
  if (!exercise || exercise.dataset.state) return;
  const ex = readEx(exercise);
  let answer;
  if (ex.type === "order") {
    answer = [...exercise.querySelectorAll(".sequence__item")].map((i) => i.dataset.value ?? i.textContent);
  } else if (ex.type === "match") {
    const map = exercise._matchMap || {};
    answer = Object.keys(map).map((k) => ({ left: k, right: map[k] }));
  } else if (ex.type === "complete") {
    answer = [...exercise.querySelectorAll(".blank")].map((b) => b.dataset.value ?? b.textContent);
  } else {
    return;
  }
  const res = grade(ex, answer);
  settle(exercise, res, res.ok);
}

// Grade against the bundled answer. Deterministic; content is code reviewed in
// the PR, answers ride server-rendered data-ex attributes.
function grade(ex, answer) {
  if (ex.type === "tf") return { ok: answer === ex.answer, correct: ex.answer ? "true" : "false" };
  if (ex.type === "select" || ex.type === "spot") {
    return { ok: answer === ex.answer, correct: String((ex.options || [])[ex.answer] ?? "") };
  }
  if (ex.type === "order") {
    return { ok: sameArr(answer, ex.answer), correct: ex.answer.join(" → ") };
  }
  if (ex.type === "match") {
    const wanted = new Map((ex.pairs || []).map((p, i) => [String(i), p.right]));
    const ok =
      Array.isArray(answer) &&
      (answer.length === (ex.pairs || []).length) &&
      answer.every((m) => wanted.get(String(m.left)) === m.right);
    return { ok, correct: ex.pairs.map((p) => p.left + " = " + p.right).join("; ") };
  }
  if (ex.type === "complete") {
    return { ok: sameArr(answer, ex.answer), correct: ex.answer.join(", ") };
  }
  return { ok: false, correct: "" };
}

function sameArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => String(v).trim().toLowerCase() === String(b[i]).trim().toLowerCase());
}

// Mark an exercise correct/wrong, reveal the citation on a miss, and advance
// the sequence. A wrong answer costs a heart (optional-off).
function settle(exercise, res, ok) {
  if (!ok && HEARTS_ENABLED) hearts = Math.max(0, hearts - 1);
  exercise.dataset.state = ok ? "correct" : "wrong";
  const status = exercise.querySelector(".exercise__status");
  const cite = exercise.querySelector(".exercise__cite");
  if (status) {
    status.dataset.state = ok ? "correct" : "wrong";
    status.textContent = ok ? "correct" : "not quite — " + res.correct;
  }
  if (cite) cite.hidden = ok;
  if (!ok) updateHearts();

  // Lock the wrong choice visual and reveal the right one.
  if (!ok) revealAnswer(exercise);

  // Update progress ring
  const section = exercise.closest(".exercises");
  if (section) {
    const all = [...section.querySelectorAll(".exercise")];
    const answered = all.filter((e) => e.dataset.state).length;
    updateProgressRing(answered);

    // Advance when every exercise has been answered (correct OR wrong — a wrong
    // answer costs a heart and the lesson still completes; the streak/XP come
    // from the server). This is the Duolingo model: you finish the lesson, not
    // every answer perfectly.
    const allAnswered = all.every((e) => e.dataset.state);
    if (allAnswered) {
      const cont = section.querySelector("[data-action='continue']");
      if (cont) cont.hidden = false;
    }
  }
}

function revealAnswer(exercise) {
  const ex = readEx(exercise);
  if (ex.type === "select" || ex.type === "spot") {
    const choices = exercise.querySelector(".choices");
    const correct = choices?.querySelector(".choice[data-i='" + ex.answer + "']");
    if (correct) correct.classList.add("choice--correct");
  } else if (ex.type === "tf") {
    const choices = exercise.querySelector(".choices");
    const correct = choices?.querySelector(".choice[data-i='" + (ex.answer ? "1" : "0") + "']");
    if (correct) correct.classList.add("choice--correct");
  }
}

// ---- Continue: after the last correct exercise, complete the lesson ----
function onContinue(btn) {
  const main = btn.closest("main[data-lesson]");
  if (main) completeLesson(main);
}

// Complete the lesson: POST /learn/api/complete (server evaluates; response
// carries authoritative player state) then celebrate. Idempotent per lesson
// (double-POST does not double-XP — the store backs this at the storage layer).
//
// Transient POST failures (worker version swap mid-deploy, one-off D1 blip)
// used to dead-end the lesson behind "completion failed". Retries ride the
// server's idempotency — a replayed completion can never double-award XP —
// so short backoff before surfacing the error is always safe (NID-411 live
// report: u1l3 completion failed exactly once, inside a deploy window).
const COMPLETE_RETRY_DELAYS_MS = [800, 2000];

function completeLesson(main) {
  if (!main || main.dataset.completed) return;
  const lessonId = main.dataset.lesson;
  const skill = main.dataset.skill || "lesson";
  const isGate = main.dataset.isGate === "true";
  if (isGate) return; // gates complete via their own submit

  main.dataset.completed = "1";
  postComplete(main, lessonId, skill, 0);
}

function postComplete(main, lessonId, skill, attempt) {
  fetch(PREFIX + "/api/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lesson_id: lessonId, skill }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      const gain = Number(data.gained) || 0;
      const player = data.player || {};
      const complete = main.querySelector(".complete");
      if (complete) {
        const gainEl = complete.querySelector("[data-gain]");
        const streakEl = complete.querySelector("[data-streak]");
        if (gainEl) gainEl.textContent = String(gain);
        if (streakEl) streakEl.textContent = String(player.streakDays ?? 0);
        complete.hidden = false;
        updateHud(player);
        const next = main.querySelector("#next-btn");
        if (next) next.focus();
      }
      celebrate(main);
    })
    .catch(() => {
      if (attempt < COMPLETE_RETRY_DELAYS_MS.length) {
        window.setTimeout(
          () => postComplete(main, lessonId, skill, attempt + 1),
          COMPLETE_RETRY_DELAYS_MS[attempt],
        );
        return;
      }
      delete main.dataset.completed;
      const fb = main.querySelector(".feedback");
      if (fb) {
        fb.hidden = false;
        fb.textContent = "completion failed — click continue again to retry";
      }
    });
}

// ---- Checkpoint gate ----
function onGateSubmit(event, btn) {
  event.preventDefault();
  const main = btn.closest("main[data-lesson]");
  const form = btn.closest("form[data-gate]");
  const verdict = form.querySelector("textarea")?.value.trim() || "";
  if (!verdict) return;
  const gateId = form.dataset.gate;
  const feedback = main?.querySelector(".feedback");
  btn.disabled = true;

  // The gate is a lesson-like node: passing it records completion through the
  // same idempotent /api/complete ledger (PR4 API surface — no separate
  // verdict endpoint exists; see PR body).
  fetch(PREFIX + "/api/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lesson_id: gateId, skill: "gate" }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = data.gained ? "gate passed — +" + data.gained + " XP" : "gate passed";
      }
      updateHud(data.player || {});
      const next = main?.querySelector("#next-btn");
      if (next) {
        next.hidden = false;
        next.focus();
      }
      celebrate(main);
    })
    .catch(() => {
      btn.disabled = false;
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = "gate submission failed — try again";
      }
    });
}

// ---- HUD sync from server truth ----
function updateHud(player) {
  const meta = document.querySelector(".head__meta");
  if (!meta) return;
  const xp = meta.querySelector(".pill--xp strong");
  const streak = meta.querySelector(".pill--streak strong");
  if (xp && typeof player.xp === "number") xp.textContent = String(player.xp);
  if (streak && typeof player.streakDays === "number") streak.textContent = String(player.streakDays);
}

function updateHearts() {
  const el = document.querySelector(".pill--hearts strong");
  if (el && HEARTS_ENABLED) el.textContent = String(hearts);
}

// Seed the per-session hearts from the server's player.hearts. Best-effort;
// the HUD already rendered server-side, so a failure leaves the rendered value.
function seedHearts() {
  const main = document.querySelector("main[data-lesson]");
  const pill = document.querySelector(".pill--hearts strong");
  if (!main || !pill) return;
  fetch(PREFIX + "/api/state")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && typeof data.player?.hearts === "number") {
        hearts = data.player.hearts;
        pill.textContent = String(hearts);
      }
    })
    .catch(() => {});
}

// Celebration: class-toggle on the shell (CSS keyframes; removed under
// prefers-reduced-motion).
function celebrate(main) {
  const shell = main?.closest(".shell");
  if (!shell) return;
  shell.classList.add("celebrate");
  window.setTimeout(() => shell.classList.remove("celebrate"), 1200);
}

function readEx(exercise) {
  return JSON.parse(exercise.dataset.ex);
}

seedHearts();
initOnboarding();
