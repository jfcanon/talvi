// talvi learn Worker — the Tribunal Learn course, mounted at
// app.ygdcbtmc4u.uk/learn (blueprint B.1). PR6 is the UI step: the full
// playable loop (path graph, lesson player, gamification) on top of the
// Clerk gate, the D1 ledger, and the bundled curriculum.
//
// Routes (all deny-by-default except healthz + the two assets):
//   GET  /learn/healthz          public — the PR2/PR6 live-verify target
//   GET  /learn/s.css, /learn/s.js   public, versioned ?v=<hash>, immutable
//   GET  /learn/                 Clerk-gated — the path-graph page
//   GET  /learn/lesson/:id       Clerk-gated — the lesson player
//   POST /learn/api/xp           Clerk-gated — append one xp_events row
//   POST /learn/api/checkpoint   Clerk-gated — open a checkpoint gate
//   everything else              uniform 404
//
// Sign-in lives at the app ROOT (served by the hub); learn verifies the
// host-wide __session cookie and redirects — it never serves sign-in itself
// (blueprint B.1/B.2). CSP default-src 'none' from day one.
import { STYLE_CSS, CLIENT_JS, ASSET_VERSION } from "./generated/assets.js";
import { PREFIX } from "./prefix.js";
import { isAuthenticated } from "./lib/auth.js";
import * as store from "./lib/store.js";
import * as curriculum from "./lib/curriculum.js";
import { pathPage } from "./ui/path.js";
import { lessonPage } from "./ui/lesson.js";

const ROBOTS_TAG = "noindex, nofollow";

// Same header set the hub uses. The CSP has no inline allowances — which is
// WHY css/js are files at /learn/s.css and /learn/s.js, never inlined.
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": ROBOTS_TAG,
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": ROBOTS_TAG,
};

// Assets are versioned at build time and served with a year-long immutable
// cache — safe ONLY because every page requests them as /learn/s.css?v=<hash>.
const ASSET_CACHE = "public, max-age=31536000, immutable";

function assetResponse(body, contentType) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

// One 404 for everything, byte-identical, so an observer cannot tell "never
// existed" from "not yet built".
function notFound() {
  return new Response("not found", { status: 404, headers: HTML_HEADERS });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Whole-unit lesson ordering for "lesson N of M" in the lesson header.
function lessonPosition(lessonId) {
  const units = curriculum.getUnits();
  let idx = 0;
  for (const unit of units) {
    if (unit.gated) continue;
    const lessons = unit.lessons.filter((l) => !l.gated);
    const pos = lessons.findIndex((l) => l.id === lessonId);
    if (pos !== -1) return { index: pos + 1, total: lessons.length, unitTitle: unit.unit.title };
    idx += lessons.length;
  }
  return { index: idx, total: 1, unitTitle: "" };
}

// Read the reduced state + open gates, folding XP into the player object the
// UI reads. player.xp = sum of xp_events (the reduction computes it).
async function readUiState(env) {
  await store.ensureSchema(env.DB);
  const state = await store.readState(env.DB);
  const gates = await store.readOpenGates(env.DB);
  let xp = 0;
  const rows = await env.DB.prepare(`SELECT xp FROM xp_events`).all();
  for (const r of rows.results || []) xp += Number(r.xp || 0);
  state.player.xp = xp;
  return { state, gates };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // GET and HEAD only. HEAD is routed as GET by Cloudflare; anything else is
    // a miss.
    if (request.method !== "GET" && request.method !== "POST") return notFound();

    if (!pathname.startsWith(PREFIX + "/") && pathname !== PREFIX) return notFound();
    const path = pathname.slice(PREFIX.length) || "/";

    // Public: healthz (never rate limited — an uptime check that trips a
    // limiter reports an outage that is not happening).
    if (path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    // Public: versioned assets. The strict CSP forbids inlining, so css/js
    // are files (a security decision driving a build decision, decision 2).
    if (path === "/s.css") return assetResponse(STYLE_CSS, "text/css; charset=utf-8");
    if (path === "/s.js") return assetResponse(CLIENT_JS, "text/javascript; charset=utf-8");

    // ---- Clerk-gated below ---- (deny-by-default, decision 2)
    if (path === "/api/xp" || path === "/api/checkpoint" || path === "/" || path.startsWith("/lesson/")) {
      const authed = await isAuthenticated(request, env);
      if (!authed) {
        if (request.method === "POST") return json({ error: "unauthorized" }, 401);
        // Page route → redirect to the hub's sign-in (app root, blueprint B.1).
        const signIn = new URL("/sign-in", request.url);
        signIn.searchParams.set("redirect", pathname);
        return Response.redirect(signIn.toString(), 302);
      }
    }

    // ---- API ----
    if (request.method === "POST" && path === "/api/xp") {
      return handleXp(request, env);
    }
    if (request.method === "POST" && path === "/api/checkpoint") {
      return handleCheckpoint(request, env);
    }

    // ---- Pages ----
    if (request.method === "GET") {
      if (path === "/" || path === "") {
        return handlePath(request, env);
      }
      const lessonMatch = path.match(/^\/lesson\/([a-z0-9]+)$/);
      if (lessonMatch) {
        return handleLesson(request, env, lessonMatch[1]);
      }
    }

    return notFound();
  },
};

async function handlePath(request, env) {
  const { state, gates } = await readUiState(env);
  const openGates = new Set(Object.keys(gates));
  const activeId = curriculum.activeNode(openGates, state.lessons);
  const body = pathPage({
    lessons: state.lessons,
    player: state.player,
    openGates,
    activeId,
  });
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

async function handleLesson(request, env, lessonId) {
  const lesson = curriculum.getLesson(lessonId);
  if (!lesson) return notFound();

  // Gate check for the unit: a lesson inside a unit whose checkpoint is
  // unopened is locked unless it's the current active node. The path page
  // never links locked lessons; this is the server-side enforcement.
  const { state, gates } = await readUiState(env);
  const openGates = new Set(Object.keys(gates));
  const activeId = curriculum.activeNode(openGates, state.lessons);
  if (activeId !== lessonId) {
    // Allow replay of a mastered/legendary lesson (mastery claim re-check,
    // decision 6), but not a leap into a locked region.
    const status = state.lessons[lessonId] ? state.lessons[lessonId].status : "not_started";
    const isMastered = status === "mastered" || status === "legendary";
    if (!isMastered) {
      // Redirect to the path rather than 404 — the player may have drifted.
      return Response.redirect(new URL(PREFIX + "/", request.url).toString(), 302);
    }
  }

  const { index, total } = lessonPosition(lessonId);
  const body = lessonPage({
    lesson,
    player: state.player,
    progressIndex: index,
    unitTotal: total,
  });
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

// Append one xp_events row (append-only, decision 3). The client sends a
// unique id; INSERT OR IGNORE makes a duplicate completion a no-op. Returns
// the gained XP (0 on duplicate) and the new streak so the UI can animate.
async function handleXp(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const id = typeof payload.id === "string" ? payload.id : null;
  const lessonId = typeof payload.lessonId === "string" ? payload.lessonId : null;
  const skill = typeof payload.skill === "string" ? payload.skill : "lesson";
  const xp = Number(payload.xp) || 0;
  if (!id || !lessonId || !xp) return json({ error: "missing id/lessonId/xp" }, 400);

  await store.ensureSchema(env.DB);
  const ts = new Date().toISOString();
  const wrote = await store.recordXp(env.DB, { id, ts, lessonId, skill, xp });
  const { state } = await readUiState(env);
  return json({
    gained: wrote ? xp : 0,
    streak: state.player.streak,
    xpTotal: state.player.xp,
  });
}

// Open a checkpoint gate: store the freeform verdict (mirror hub gate). Auto-
// pass on submission for MVP (converged plan §9.2); the verdict is kept for
// later review.
async function handleCheckpoint(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const id = typeof payload.id === "string" ? payload.id : null;
  const verdict = typeof payload.verdict === "string" ? payload.verdict.trim() : "";
  if (!id || !verdict) return json({ error: "missing id/verdict" }, 400);
  const cp = curriculum.getCheckpoint(id);
  if (!cp) return json({ error: "unknown checkpoint" }, 404);

  await store.ensureSchema(env.DB);
  await store.recordCheckpoint(env.DB, id, verdict);
  return json({ ok: true, id });
}
