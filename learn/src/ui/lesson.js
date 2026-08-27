// talvi-learn lesson player (blueprint B.3 / PR6). Server-rendered from the
// bundled curriculum: the exercise sequence arrives as HTML, each exercise's
// full definition (including its answer) rides in a data-ex attribute, and
// client.js owns the interaction state machine. No client framework, no inline
// handlers, no eval — the strict CSP is why the page links /learn/s.js.
import { ASSET_VERSION } from "../generated/assets.js";
import { esc, escAttr, dataJson } from "./html.js";
import { PREFIX } from "../prefix.js";
import { formatCitation } from "../lib/curriculum.js";

export function lessonPage({ lesson, player, heartsEnabled, position }) {
  const xp = typeof player.xp === "number" ? player.xp : 0;
  const streak = typeof player.streakDays === "number" ? player.streakDays : 0;
  const isGate = lesson.kind === "gate" || !(lesson.exercises && lesson.exercises.length);

const exercises = (lesson.exercises || []).map((ex, i) => renderExercise(ex, i)).join("");
  const facts = (lesson.facts || []).map((f, i) => renderCard(f, i, lesson.facts.length)).join("");

  // Progress ring SVG (segments = cards + exercises)
  // No inline styles — stroke-dasharray/dashoffset computed per segment count
  const factCount = (lesson.facts || []).length;
  const exerciseCount = (lesson.exercises || []).length;
  const totalSegments = factCount + exerciseCount;
  const circumference = 2 * Math.PI * 26; // ~163.4
  const perSegment = totalSegments > 0 ? circumference / totalSegments : 0;
  const dash = perSegment * totalSegments;
  const progressRing = totalSegments > 0
    ? `<svg class="progress-ring" viewBox="0 0 60 60" aria-label="Lesson progress" data-segments="${totalSegments}" data-facts="${factCount}">
          <circle class="progress-ring__bg" cx="30" cy="30" r="26" stroke-width="4" fill="none"/>
          <circle class="progress-ring__fill" cx="30" cy="30" r="26" stroke-width="4" fill="none"
            stroke-dasharray="${dash}" stroke-dashoffset="${dash}"/>
        </svg>`
    : "";

  const body = isGate
    ? gateForm(lesson)
    : // Step-by-step flow: cards → I'm Ready → exercises one at a time
      '<div class="cards" data-total="' + esc(String(factCount)) + '">' +
      facts +
      '</div>' +
      '<section class="exercises" data-total="' +
      esc(String(exerciseCount)) +
      '" data-gated="true" data-locked="true" hidden>' +
      exercises +
      '<button type="button" class="btn continue-btn" data-action="continue" hidden>continue</button>' +
      "</section>";

  // Completion screen with next lesson pre-fetch
  const nextLessonId = getNextLessonId(lesson.id);
  const nextLessonHref = nextLessonId ? `${PREFIX}/lesson/${nextLessonId}` : `${PREFIX}/`;
  const nextLessonLabel = nextLessonId ? "Next Lesson" : "Back to Path";

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
    header(player, xp, streak, heartsEnabled) +
    '<main class="lesson" data-lesson="' +
    escAttr(lesson.id) +
    '" data-skill="' +
    escAttr(lesson.skill || "") +
    '" data-xp="' +
    escAttr(String(lesson.xp || 0)) +
    '" data-is-gate="' +
    (isGate ? "true" : "false") +
    '" data-next-lesson="' +
    escAttr(nextLessonId || "") +
    '" data-step="0">' +
    lessonHeading(lesson, position) +
    progressRing +
    body +
    '<div class="feedback" role="status" aria-live="polite" hidden></div>' +
    '<section class="complete" hidden>' +
    "<h2>Lesson Complete!</h2>" +
    '<p class="complete__xp">+<span data-gain>0</span> XP</p>' +
    '<p class="complete__streak">streak <strong data-streak>0</strong>d</p>' +
    '<div class="complete__actions">' +
    (nextLessonId ? `<a class="btn" id="next-btn" href="${nextLessonHref}" data-prefetch>${nextLessonLabel}</a>` : '') +
    '<a class="btn" id="path-btn" href="' +
    PREFIX +
    '/">Back to Path</a>' +
    "</div>" +
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

// Determine next lesson ID for pre-fetch
function getNextLessonId(currentId) {
  // Simple sequential mapping for MVP
  const sequence = [
    "u1l1", "u1l2", "u1l3", "u1l4", "u1l5",
    "u2l1", "u2l2", "u2l3", "u2l4", "u2l5", "u2l6",
    "u3l1", "u3l2", "u3l3", "u3l4", "u3l5", "u3l6", "u3l7", "u3l8",
    "u4l1", "u4l2", "u4l3", "u4l4", "u4l5"
  ];
  const idx = sequence.indexOf(currentId);
  return idx >= 0 && idx < sequence.length - 1 ? sequence[idx + 1] : null;
}

function lessonHeading(lesson, position) {
  if (!position || !position.unitTitle) return "";
  return (
    '<div class="lesson__heading">' +
    '<span class="lesson__unit">unit ' +
    esc(String(position.unitIndex)) +
    " — " +
    esc(position.unitTitle) +
    "</span>" +
    "<h1 class=\"lesson__title\">" +
    esc(lesson.title) +
    "</h1>" +
    (position.lessonIndex
      ? '<span class="lesson__pos">lesson ' +
        esc(String(position.lessonIndex)) +
        " of " +
        esc(String(position.lessonTotal)) +
        "</span>"
      : "") +
    "</div>"
  );
}

// Minimal safe rich text for lesson facts: escape first, then map the two
// markdown-ish markers the curriculum uses (**bold**, `code`) to elements.
// No raw HTML from content ever reaches the page.
export function richText(text) {
  return esc(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderCard(fact, index, total) {
  const isLast = index === total - 1;
  const buttonLabel = isLast ? "I'm Ready" : "Next";
  const buttonAction = isLast ? "ready" : "card-next";
  const hidden = index > 0 ? " hidden" : "";
  return (
    '<article class="card"' + hidden + ' data-index="' + esc(String(index)) + '">' +
    '<p class="card__text">' +
    richText(fact.text || "") +
    '</p><cite class="card__cite">' +
    esc(formatCitation(fact.cite)) +
    "</cite>" +
    '<button type="button" class="btn card__next" data-action="' + escAttr(buttonAction) + '">' +
    esc(buttonLabel) +
    "</button>" +
    "</article>"
  );
}

function renderExercise(ex, index) {
  let body = "";
  if (ex.type === "select" || ex.type === "spot") {
    body =
      (ex.scenario ? '<p class="scenario">' + esc(ex.scenario) + "</p>" : "") +
      '<div class="choices" data-kind="select">' +
      (ex.options || []).map((o, i) => choice(o, i)).join("") +
      "</div>";
  } else if (ex.type === "tf") {
    body =
      '<div class="choices choices--tf" data-kind="tf">' +
      '<button type="button" class="choice" data-action="choose" data-i="1">true</button>' +
      '<button type="button" class="choice" data-action="choose" data-i="0">false</button>' +
      "</div>";
  } else if (ex.type === "order") {
    body =
      '<div class="bank" data-kind="order">' +
      (ex.options || []).map((o, i) => bankChip(o, i, "order-add")).join("") +
      "</div>" +
      '<ol class="sequence" aria-label="your order"></ol>' +
      '<button type="button" class="btn check-btn" data-action="check" disabled>check</button>';
  } else if (ex.type === "match") {
    body =
      '<div class="match" data-kind="match">' +
      '<div class="match__left">' +
      (ex.pairs || []).map((p, i) => matchLeft(p.left, i)).join("") +
      "</div>" +
      '<div class="match__right">' +
      shuffled(ex).map((p, i) => matchRight(p, i)).join("") +
      "</div>" +
      "</div>" +
      '<button type="button" class="btn check-btn" data-action="check" disabled>check</button>';
  } else if (ex.type === "complete") {
    const blanks = (ex.prompt.match(/___/g) || []).length;
    const promptHtml = esc(ex.prompt).replace(/___/g, '<span class="blank" data-action="blank-pop"></span>');
    body =
      '<div class="complete-ex" data-kind="complete">' +
      '<p class="complete-ex__prompt">' +
      promptHtml +
      "</p>" +
      '<div class="bank">' +
      (ex.bank || []).map((w, i) => bankChip(w, i, "bank-fill")).join("") +
      "</div>" +
      '<button type="button" class="btn check-btn" data-action="check" disabled>check</button>' +
      "<p class=\"complete-ex__hint\">tap words in order to fill the blanks</p>" +
      "</div>";
  }
  // Exercises start hidden; client.js will show the first one after "I'm Ready"
  const hidden = index > 0 ? " hidden" : "";
  return (
    '<article class="exercise"' + hidden + ' data-index="' + esc(String(index)) + '" data-ex="' +
    dataJson({ type: ex.type, prompt: ex.prompt, ...exerciseAnswer(ex) }) +
    '">' +
    '<h3 class="exercise__prompt">' +
    esc(ex.prompt) +
    "</h3>" +
    body +
    '<p class="exercise__status" role="status"></p>' +
    '<p class="exercise__cite" hidden>' +
    esc(ex.cite || "") +
    "</p>" +
    "</article>"
  );
}

function exerciseAnswer(ex) {
  // grade() renders the correct option text on a miss, so the options must
  // ride along — without them every select click threw and the lesson could
  // never complete (NID-100 live report).
  if (ex.type === "select" || ex.type === "spot") return { answer: ex.answer, options: ex.options || [] };
  if (ex.type === "tf") return { answer: ex.answer };
  if (ex.type === "order") return { answer: ex.answer };
  if (ex.type === "match") return { pairs: ex.pairs };
  if (ex.type === "complete") return { answer: ex.answer };
  return {};
}

function choice(label, i) {
  return (
    '<button type="button" class="choice" data-action="choose" data-i="' +
    esc(String(i)) +
    '">' +
    esc(label) +
    "</button>"
  );
}

function bankChip(label, i, action) {
  return (
    '<button type="button" class="chip" data-action="' +
    escAttr(action) +
    '" data-i="' +
    esc(String(i)) +
    '" data-value="' +
    escAttr(label) +
    '">' +
    esc(label) +
    "</button>"
  );
}

function matchLeft(label, i) {
  return (
    '<button type="button" class="match__item match__item--left" data-action="match-left" data-key="' +
    esc(String(i)) +
    '">' +
    esc(label) +
    "</button>"
  );
}

function matchRight(pair, i) {
  return (
    '<button type="button" class="match__item match__item--right" data-action="match-right" data-key="' +
    esc(String(i)) +
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
  const arr = (ex.pairs || []).slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (hash(String(arr[i].right)) + i) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// The checkpoint gate form — real form controls, handled by client.js via
// fetch (form-action 'none' forbids a native submit; the CSP never weakens).
function gateForm(lesson) {
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
    '<button type="button" class="btn" data-action="gate-submit">submit verdict</button>' +
    "</form>" +
    "</section>"
  );
}

function header(player, xp, streak, heartsEnabled) {
  const hearts = heartsEnabled
    ? '<span class="pill pill--hearts" title="hearts">&#9829; <strong>' +
      esc(player.hearts) +
      "</strong></span>"
    : "";
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
    '<span class="pill pill--streak" title="streak">&#128293; <strong>' +
    esc(streak) +
    "</strong></span>" +
    '<span class="pill pill--xp" title="xp">XP <strong>' +
    esc(xp) +
    "</strong></span>" +
    "</div>" +
    "</header>"
  );
}