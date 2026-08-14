// talvi-learn lesson player (blueprint B.3 / PR6). Server-rendered from the
// bundled curriculum: the exercise sequence arrives as HTML, the correct
// answers ride along as JSON data attributes (bundled content, single owner —
// the converged plan's client-side grading resolution), and client.js owns the
// interaction state machine. No client framework, no inline handlers.
import { ASSET_VERSION } from "../generated/assets.js";
import { esc, escAttr, dataJson } from "./html.js";
import { PREFIX } from "../prefix.js";

// Render the lesson page. `lesson` is the enriched lesson record from
// curriculum.js; `player` the reduced player_state; `progressIndex` is the
// 1-based "lesson N" position within its unit for the progress bar;
// `unitTotal` the number of lessons in the unit.
export function lessonPage({ lesson, player, progressIndex, unitTotal }) {
  const xp = typeof player.xp === "number" ? player.xp : 0;
  const isCheckpoint = !lesson.exercises || lesson.exercises.length === 0;
  const exercises = (lesson.exercises || []).map(renderExercise).join("");

  return (
    "<!doctype html><html lang=\"en\"><head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>talvi learn — " +
    esc(lesson.title) +
    "</title>" +
    '<link rel="stylesheet" href="' +
    PREFIX +
    "/s.css?v=" +
    escAttr(ASSET_VERSION) +
    '">' +
    "</head><body>" +
    '<div class="shell">' +
    header(player, xp, lesson, progressIndex, unitTotal) +
    '<main class="lesson" data-lesson="' +
    escAttr(lesson.id) +
    '" data-skill="' +
    escAttr(lesson.skill || "") +
    '" data-xp="' +
    escAttr(String(lesson.xp || 0)) +
    '" data-is-checkpoint="' +
    (isCheckpoint ? "true" : "false") +
    '">' +
    '<div class="lesson__facts">' +
    (lesson.facts || [])
      .map(
        (f) =>
          '<article class="fact"><p>' +
          esc(f.text) +
          '</p><cite>' +
          esc(f.cite) +
          "</cite></article>",
      )
      .join("") +
    "</div>" +
    (isCheckpoint
      ? checkpointForm(lesson)
      : '<section class="exercises" data-total="' +
        (lesson.exercises || []).length +
        '">' +
        exercises +
        "</section>") +
    '<div class="feedback" role="status" aria-live="polite" hidden></div>' +
    '<section class="complete" hidden>' +
    "<h2>Lesson complete</h2>" +
    '<p class="complete__xp">+<span data-gain>0</span> XP</p>' +
    '<p class="complete__streak">streak <strong data-streak>0</strong>d</p>' +
    '<div class="complete__actions"><a class="btn" id="next-btn" href="' +
    PREFIX +
    '/">back to path</a></div>' +
    "</section>" +
    "</main>" +
    "</div>" +
    '<script src="' +
    PREFIX +
    "/s.js?v=" +
    escAttr(ASSET_VERSION) +
    '"></script>' +
    "</body></html>"
  );
}

function renderExercise(ex) {
  let body = "";
  if (ex.type === "select") {
    body =
      '<div class="choices" data-kind="select">' +
      ex.options.map((o, i) => choice(o, i)).join("") +
      "</div>";
  } else if (ex.type === "order") {
    body =
      '<div class="bank" data-kind="order">' +
      ex.options.map((o, i) => bankChip(o, i)).join("") +
      "</div>" +
      '<ol class="sequence" data-answer=""></ol>';
  } else if (ex.type === "match") {
    body =
      '<div class="match" data-kind="match">' +
      '<div class="match__left">' +
      ex.pairs.map((p, i) => matchLeft(p.left, i)).join("") +
      "</div>" +
      '<div class="match__right">' +
      shuffled(ex).map((p, i) => matchRight(p, i)).join("") +
      "</div>" +
      "</div>";
  } else if (ex.type === "complete") {
    body =
      '<div class="complete-ex" data-kind="complete">' +
      '<div class="blank">' +
      ex.bank
        .map((w, i) => '<button type="button" class="blank__slot" data-slot="' + i + '"></button>')
        .join("") +
      "</div>" +
      '<div class="bank">' +
      ex.bank.map((w, i) => bankChip(w, i)).join("") +
      "</div>" +
      "</div>";
  } else if (ex.type === "listen") {
    body =
      '<div class="listen" data-kind="listen">' +
      '<button type="button" class="btn listen__play" data-play>&#9654; play</button>' +
      '<input class="listen__input" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="type what you hear">' +
      '<button type="button" class="btn listen__submit" data-submit>check</button>' +
      '<p class="listen__hint" hidden>text: <em data-hint></em></p>' +
      "</div>";
  }
  return (
    '<article class="exercise" data-ex="' +
    dataJson({ type: ex.type, prompt: ex.prompt, ...exerciseAnswer(ex) }) +
    '">' +
    "<h3 class=\"exercise__prompt\">" +
    esc(ex.prompt) +
    "</h3>" +
    body +
    '<p class="exercise__status" role="status"></p>' +
    "</article>"
  );
}

function exerciseAnswer(ex) {
  if (ex.type === "select") return { answer: ex.answer };
  if (ex.type === "order") return { answer: ex.answer };
  if (ex.type === "match") return { pairs: ex.pairs };
  if (ex.type === "complete") return { answer: ex.answer };
  if (ex.type === "listen") return { text: ex.text };
  return {};
}

function choice(label, i) {
  return (
    '<button type="button" class="choice" data-i="' +
    i +
    '">' +
    esc(label) +
    "</button>"
  );
}

function bankChip(label, i) {
  return (
    '<button type="button" class="chip" data-i="' +
    i +
    '">' +
    esc(label) +
    "</button>"
  );
}

function matchLeft(label, i) {
  return (
    '<button type="button" class="match__item match__item--left" data-key="' +
    i +
    '">' +
    esc(label) +
    "</button>"
  );
}

function matchRight(pair, i) {
  return (
    '<button type="button" class="match__item match__item--right" data-key="' +
    i +
    '" data-match="' +
    escAttr(String(pair.right)) +
    '">' +
    esc(pair.right) +
    "</button>"
  );
}

// Right column is shuffled server-side (deterministic from the answer) so the
// match isn't trivially ordered — grading is by the pair mapping, not order.
function shuffled(ex) {
  const arr = ex.pairs.slice();
  // A small deterministic shuffle by string hash so SSR output is stable.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (hash(arr[i].right) + i) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// The checkpoint gate form — real form controls (blueprint B.5: "real form
// controls"), handled by client.js via fetch (form-action 'none' forbids a
// native submit; the CSP never weakens).
function checkpointForm(lesson) {
  return (
    '<section class="gate">' +
    "<h2 class=\"gate__title\">" +
    esc(lesson.title) +
    "</h2>" +
    '<p class="gate__prompt">' +
    esc(lesson.prompt || "") +
    "</p>" +
    '<form class="gate__form" data-gate="' +
    escAttr(lesson.id) +
    '">' +
    '<label class="gate__label" for="verdict">your verdict</label>' +
    '<textarea id="verdict" name="verdict" rows="4" required></textarea>' +
    '<button type="submit" class="btn">submit verdict</button>' +
    "</form>" +
    "</section>"
  );
}

function header(player, xp, lesson, progressIndex, unitTotal) {
  const hearts = player.heartsEnabled
    ? '<span class="pill pill--hearts" title="hearts">&#9829; ' + esc(player.hearts) + "</span>"
    : "";
  const pct = unitTotal ? Math.round(((progressIndex - 1) / unitTotal) * 100) : 0;
  return (
    '<header class="head">' +
    '<a class="sign" href="' +
    PREFIX +
    '/">talvi<span class="sign__dot">_</span></a>' +
    '<nav class="head__nav">' +
    '<a class="head__link" href="' +
    PREFIX +
    '/">path</a>' +
    "</nav>" +
    '<div class="head__meta">' +
    hearts +
    '<span class="pill" title="streak">&#128293; <strong>' +
    esc(player.streak) +
    "</strong></span>" +
    '<span class="pill" title="xp">XP <strong>' +
    esc(xp) +
    "</strong></span>" +
    "</div>" +
    "</header>" +
    '<div class="lesson-progress"><div class="progress"><div class="progress__bar" role="progressbar" aria-valuenow="' +
    pct +
    '" aria-valuemin="0" aria-valuemax="100" style="width:' +
    pct +
    '%"></div></div>' +
    "<span>lesson " +
    esc(progressIndex) +
    " of " +
    esc(unitTotal) +
    "</span></div>"
  );
}
