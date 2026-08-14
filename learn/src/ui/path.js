// talvi-learn path-graph page (decision 6 / PR6). Server-rendered from the
// curriculum structure (the _moc.md shape) plus the reduced D1 state. The rail
// is the learning path: unit banners, lesson nodes, checkpoint gates. Node
// state machine: locked | active | mastered | legendary (crowns 1/2/3).
// No client framework, no inline handlers — css/js live at /learn/s.css and
// /learn/s.js because the CSP forbids inlining (decision 2 / B.5).
import { ASSET_VERSION } from "../generated/assets.js";
import { esc, escAttr } from "./html.js";
import { PREFIX } from "../prefix.js";
import { buildRail, completionPct, activeNode } from "../lib/curriculum.js";

const CROWN = "&#9889;";

export function pathPage({ player, lessons, heartsEnabled }) {
  const rail = buildRail(lessons);
  const activeId = activeNode(lessons);
  const xp = typeof player.xp === "number" ? player.xp : 0;
  const streak = typeof player.streakDays === "number" ? player.streakDays : 0;
  const pct = completionPct(lessons);

  let seq = 0;
  const nodes = rail
    .map((n) => {
      if (n.kind !== "banner") seq += 1;
      return renderNode(n, activeId, seq);
    })
    .join("");
  const next = rail.find((n) => n.status === "active");
  const nextLabel = next ? next.title : "all nodes mastered — the path is complete";

  return (
    "<!doctype html><html lang=\"en\"><head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>talvi learn — path</title>" +
    '<link rel="stylesheet" href="' +
    PREFIX +
    "/s.css?v=" +
    escAttr(ASSET_VERSION) +
    '">' +
    "</head><body>" +
    '<div class="shell">' +
    header(player, xp, streak, heartsEnabled, "path") +
    '<main class="path" data-page="path">' +
    '<section class="path__intro">' +
    '<h1 class="path__title">Tribunal Learn</h1>' +
    '<p class="path__sub">the machinery of the Living Tribunal — one lesson at a time.</p>' +
    "</section>" +
    progressBar(pct) +
    '<ol class="rail">' +
    nodes +
    "</ol>" +
    '<p class="path__next">next: <strong>' +
    esc(nextLabel) +
    "</strong></p>" +
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

function renderNode(node, activeId, seq) {
  if (node.kind === "banner") {
    return (
      '<li class="banner">' +
      '<span class="banner__tag">UNIT</span>' +
      '<span class="banner__title">' +
      esc(node.title) +
      (node.gated ? ' <span class="banner__gated">GATED</span>' : "") +
      "</span></li>"
    );
  }

  let href;
  let inner;
  if (node.kind === "gate") {
    href = PREFIX + "/gate/" + escAttr(node.id);
    const label =
      node.status === "mastered"
        ? "gate passed"
        : node.status === "legendary"
          ? "gate passed"
          : node.status === "active"
            ? "open gate"
            : "locked";
    inner =
      '<span class="node__num">&#9873;</span>' +
      '<span class="node__label">' +
      esc(node.title.split(" — ")[1] || node.title) +
      "</span>" +
      '<span class="node__meta">' +
      esc(label) +
      "</span>";
  } else {
    href = PREFIX + "/lesson/" + escAttr(node.id);
    const crowns =
      node.status === "legendary"
        ? CROWN + CROWN + CROWN
        : node.status === "mastered"
          ? CROWN
          : "";
    const skill = node.skill ? " — " + esc(node.skill) : "";
    inner =
      '<span class="node__num">' +
      esc(String(seq)) +
      "</span>" +
      '<span class="node__label">' +
      esc(node.title) +
      "</span>" +
      '<span class="node__meta">' +
      esc(node.status) +
      crowns +
      skill +
      "</span>";
  }

  const cls = "node node--" + node.status + (node.id === activeId ? " node--front" : "");
  return (
    '<li class="node-wrap"><a class="' +
    cls +
    '" href="' +
    href +
    '" aria-label="' +
    escAttr(node.title) +
    '">' +
    inner +
    "</a></li>"
  );
}

function progressBar(pct) {
  return (
    '<div class="progress">' +
    '<div class="progress__label">path progress</div>' +
    '<progress class="progress__track" value="' +
    pct +
    '" max="100" aria-label="path progress">' +
    pct +
    "%</progress>" +
    '<div class="progress__value">' +
    pct +
    "%</div>" +
    "</div>"
  );
}

// The shared page header: brand + gamification HUD (XP, streak flame, hearts).
function header(player, xp, streak, heartsEnabled, page) {
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
    '<a class="head__link' +
    (page === "path" ? " head__link--on" : "") +
    '" href="' +
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
