// talvi-learn path-graph page (blueprint B.3 / decision 6). Server-rendered
// from the curriculum structure (the _moc.md shape) plus the reduced D1 state.
// No client framework, no inline handlers, no inline scripts — the strict CSP
// (default-src 'none') is the reason css/js live at /learn/s.css and /learn/s.js.
import { ASSET_VERSION } from "../generated/assets.js";
import { esc, escAttr } from "./html.js";
import { PREFIX } from "../prefix.js";
import { buildRail } from "../lib/curriculum.js";

const CROWN = "&#9889;";

// The path-graph page. `lessons` is the reduced lesson_progress map,
// `player` the reduced player_state, `openGates` a Set of open checkpoint
// ids, `activeId` the active (next-to-play) lesson id or null.
export function pathPage({ lessons, player, openGates, activeId }) {
  const rail = buildRail(openGates, lessons);

  // Total XP shown in the header: the sum of xp from the reduction. The store
  // already folds XP into player.xp; guard here so a stale shape never prints
  // "undefined".
  const xp = typeof player.xp === "number" ? player.xp : 0;

  const nodes = rail.map(renderNode(activeId)).join("");
  const unitCount = rail.filter((n) => n.kind === "unit-banner").length;
  const done = rail.filter(
    (n) => n.kind === "lesson" && (n.status === "mastered" || n.status === "legendary"),
  ).length;
  const total = rail.filter((n) => n.kind === "lesson").length || 1;
  const pct = Math.round((done / total) * 100);

  const active = activeId ? rail.find((n) => n.id === activeId) : null;
  const nextLabel = active ? active.title : "unit complete — all nodes mastered";

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
    header(player, xp, "path") +
    '<main class="path">' +
    '<section class="path__intro">' +
    '<h1 class="path__title">Tribunal Learn</h1>' +
    '<p class="path__sub">the machinery of the Living Tribunal — one lesson at a time.</p>' +
    "</section>" +
    '<div class="progress"><div class="progress__bar" role="progressbar" aria-valuenow="' +
    pct +
    '" aria-valuemin="0" aria-valuemax="100" style="width:' +
    pct +
    '%"></div></div>' +
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

// Node state machine (converged plan §3): locked | available | started |
// mastered | legendary, plus the checkpoint's open/locked.
function nodeState(node, activeId) {
  if (node.kind === "unit-banner") return "banner";
  if (node.kind === "checkpoint") return node.gated ? "gated" : node.open ? "open" : "closed";
  if (node.status === "legendary") return "legendary";
  if (node.status === "mastered") return "mastered";
  if (node.id === activeId) return "active";
  return "locked";
}

function renderNode(activeId) {
  return (node) => {
    const state = nodeState(node, activeId);

    if (node.kind === "unit-banner") {
      return (
        '<li class="banner">' +
        '<span class="banner__tag">UNIT</span>' +
        "<span class=\"banner__title\">" +
        esc(node.title) +
        (node.gated ? ' <span class="banner__gated">GATED</span>' : "") +
        "</span></li>"
      );
    }

    let inner;
    if (node.kind === "checkpoint") {
      const label = node.gated ? "GATED" : node.open ? "gate open" : "gate";
      inner =
        '<span class="node__num">&#9873;</span>' +
        '<span class="node__label">' +
        esc(node.title.split(" — ")[1] || node.title) +
        "</span>" +
        '<span class="node__meta">' +
        esc(label) +
        "</span>";
    } else {
      const crowns =
        state === "legendary" ? CROWN + CROWN + CROWN : state === "mastered" ? CROWN : "";
      const skill = node.skill ? " — " + esc(node.skill) : "";
      inner =
        '<span class="node__num">' +
        esc(String(node.passes + 1)) +
        "</span>" +
        '<span class="node__label">' +
        esc(node.title) +
        "</span>" +
        '<span class="node__meta">' +
        esc(state) +
        crowns +
        skill +
        "</span>";
    }

    const href = PREFIX + "/lesson/" + escAttr(node.id);
    const cls = "node node--" + state;
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
  };
}

// The shared page header: brand + gamification surface (XP, streak; hearts
// render only when enabled — converged plan §5, HEARTS_ENABLED).
function header(player, xp, page) {
  const hearts = player.heartsEnabled
    ? '<span class="pill pill--hearts" title="hearts">&#9829; ' + esc(player.hearts) + "</span>"
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
    '<span class="pill" title="streak">&#128293; <strong>' +
    esc(player.streak) +
    "</strong></span>" +
    '<span class="pill" title="xp">XP <strong>' +
    esc(xp) +
    "</strong></span>" +
    "</div>" +
    "</header>"
  );
}
