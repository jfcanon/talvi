// talvi learn Worker — the Tribunal Learn course, mounted at
// app.ygdcbtmc4u.uk/learn (blueprint B.1).
//
// PR6 is the UI step (NID-101): the path-graph page, the lesson player, and
// the gamification surface, on top of the PR4 data layer (D1 ledger + APIs)
// and the PR5 curriculum content. It sits on the serial chain — this branch
// carries the PR2 skeleton, the PR3 Clerk gate (carried inside PR4), the PR4
// store/API, and the PR5 curriculum/content-lint.
//
// Routes (all deny-by-default except healthz + the two assets + favicon):
//   GET  /learn/healthz            public — the PR2/PR6 live-verify target
//   GET  /learn/s.css, /learn/s.js public, versioned ?v=<hash>, immutable
//   GET  /learn/favicon.ico        public — tiny SVG, same headers as s.css
//   GET  /learn/                   Clerk-gated — the path-graph page
//   GET  /learn/lesson/<id>        Clerk-gated — the lesson player
//   GET  /learn/gate/<id>          Clerk-gated — the checkpoint gate
//   GET  /learn/api/state          Clerk-gated — aggregated player state
//   POST /learn/api/complete       Clerk-gated — complete a lesson (idempotent)
//   GET  /learn/api/curriculum     Clerk-gated — curriculum JSON
//   everything else                uniform 404
//
// Sign-in lives at the app ROOT (served by the hub); learn verifies the
// host-wide __session cookie and redirects — it never serves sign-in itself
// (blueprint B.1/B.2). CSP default-src 'none' from day one.
import { STYLE_CSS, CLIENT_JS, ASSET_VERSION } from "./generated/assets.js";
import { PREFIX } from "./prefix.js";
import { getUserId } from "./lib/auth.js";
import * as store from "./lib/store.js";
import { getCurriculum, getLesson, getCheckpoint, isReachable, lessonPosition } from "./lib/curriculum.js";
import { pathPage } from "./ui/path.js";
import { lessonPage } from "./ui/lesson.js";

const ROBOTS_TAG = "noindex, nofollow";

// Hearts are optional-off (locked decision 6) and are currently OFF. This flag
// mirrors the client (src/ui/client.js) — it decides whether the server renders
// the hearts pill. The D1 `hearts` column is retained (no migration drops it).
const HEARTS_ENABLED = false;

// Same header set the hub uses. The CSP has no inline allowances — which is
// WHY css/js are files at /learn/s.css and /learn/s.js, never inlined.
// Cloudflare Insights beacon is auto-injected; allow its domain (first-party analytics).
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
    "img-src 'self' data:; connect-src 'self' https://static.cloudflareinsights.com; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": ROBOTS_TAG,
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "content-security-policy": HTML_HEADERS["content-security-policy"],
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": ROBOTS_TAG,
};

// Assets are versioned at build time (ASSET_VERSION = hash of css+js+curriculum
// bytes) and served with a year-long immutable cache. Safe ONLY because every
// page requests them as /learn/s.css?v=<hash> — the URL changes when the bytes
// do, so a cached old version is never served to a new page.
const ASSET_CACHE = "public, max-age=31536000, immutable";

function assetResponse(body, contentType) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": ASSET_CACHE,
      "content-security-policy": HTML_HEADERS["content-security-policy"],
      "x-content-type-options": "nosniff",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0b0f14"/><circle cx="8" cy="8" r="4" fill="#c9a227"/></svg>`;

// One 404 for everything, byte-identical, so an observer cannot tell "never
// existed" from "not yet built".
function notFound() {
  return new Response("not found", { status: 404, headers: HTML_HEADERS });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Read the reduced player state once per page request (rebuilds derived tables
// from the ledger, keeps the server truth current).
async function readPlayerState(env, userId) {
  return store.readState(env.DB, userId);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // GET, HEAD and POST only. HEAD is routed as GET by Cloudflare; anything
    // else is a miss.
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return notFound();
    }

    if (!pathname.startsWith(PREFIX + "/") && pathname !== PREFIX) return notFound();
    const path = pathname.slice(PREFIX.length) || "/";

    // Public: healthz (never rate limited — an uptime check that trips a
    // limiter reports an outage that is not happening).
    if (path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: {
          "content-security-policy": HTML_HEADERS["content-security-policy"],
          "x-robots-tag": ROBOTS_TAG,
        },
      });
    }

    // Public: versioned assets. The strict CSP forbids inlining, so css/js are
    // files (a security decision driving a build decision, decision 2).
    if (path === "/s.css") return assetResponse(STYLE_CSS, "text/css; charset=utf-8");
    if (path === "/s.js") return assetResponse(CLIENT_JS, "text/javascript; charset=utf-8");
    if (path === "/favicon.ico") return assetResponse(FAVICON_SVG, "image/svg+xml");

    // ---- Clerk-gated below ---- (deny-by-default, decision 2 / carried PR3)
    const userId = await getUserId(request, env);
    if (!userId) {
      if (request.method === "POST" || path.startsWith("/api/")) {
        return json({ error: "unauthorized" }, 401);
      }
      const signIn = new URL("/sign-in", request.url);
      signIn.searchParams.set("redirect", pathname);
      return new Response(null, {
        status: 302,
        headers: {
          location: signIn.toString(),
          "content-security-policy": HTML_HEADERS["content-security-policy"],
        },
      });
    }

    // ---- API ----
    if (request.method === "GET" && path === "/api/state") {
      const state = await readPlayerState(env, userId);
      return json(state);
    }

    if (request.method === "POST" && path === "/api/complete") {
      return handleComplete(request, env, userId);
    }

    if (request.method === "GET" && path === "/api/curriculum") {
      return json({ curriculum: getCurriculum() });
    }

    // ---- Pages ----
    if (request.method === "GET") {
      if (path === "/" || path === "") {
        return handlePath(request, env, userId);
      }
      const lessonMatch = path.match(/^\/lesson\/([a-z0-9]+)$/);
      if (lessonMatch) {
        return handleLesson(request, env, userId, lessonMatch[1]);
      }
      const gateMatch = path.match(/^\/gate\/([a-z0-9]+)$/);
      if (gateMatch) {
        return handleGate(request, env, userId, gateMatch[1]);
      }
    }

    return notFound();
  },
};

async function handlePath(request, env, userId) {
  const state = await readPlayerState(env, userId);
  const body = pathPage({ player: state.player, lessons: state.lessons, heartsEnabled: HEARTS_ENABLED });
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

// The lesson player. Server-side reachability enforcement: a lesson is only
// served when it is the active frontier node or already mastered/legendary
// (replay). Anything else redirects to the path — the client never decides.
async function handleLesson(request, env, userId, lessonId) {
  const lesson = getLesson(lessonId);
  if (!lesson || lesson.unitGated) return notFound();

  const state = await readPlayerState(env, userId);
  if (!isReachable(state.lessons, lessonId)) {
    return Response.redirect(new URL(PREFIX + "/", request.url).toString(), 302);
  }

  const position = lessonPosition(lessonId);
  const body = lessonPage({ lesson, player: state.player, heartsEnabled: HEARTS_ENABLED, position });
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

// The checkpoint gate page — a verdict prompt served as a lesson-like node.
async function handleGate(request, env, userId, gateId) {
  const gate = getCheckpoint(gateId);
  if (!gate || gate.unitGated) return notFound();

  const state = await readPlayerState(env, userId);
  if (!isReachable(state.lessons, gateId)) {
    return Response.redirect(new URL(PREFIX + "/", request.url).toString(), 302);
  }

  const position = { unitIndex: 0, lessonIndex: 0, lessonTotal: 0, unitTitle: gate.unitTitle };
  const body = lessonPage({ lesson: gate, player: state.player, heartsEnabled: HEARTS_ENABLED, position });
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

// Complete a lesson: evaluate server-side, append one xp_event, refresh the
// derived tables. Body: { lesson_id, skill }. Idempotent per lesson (double
// POST does not double XP — the store's unique index backs this). Gates use
// the same endpoint with the gate id as lesson_id (single completion record).
async function handleComplete(request, env, userId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const lessonId = typeof payload.lesson_id === "string" ? payload.lesson_id : payload.lessonId;
  const skill = typeof payload.skill === "string" ? payload.skill : "lesson";
  if (typeof lessonId !== "string" || !lessonId) {
    return json({ error: "missing lesson_id" }, 400);
  }

  const ts = new Date().toISOString();
  const result = await store.recordCompletion(env.DB, userId, { lessonId, skill, ts });
  return json({ ok: true, ...result });
}
