// talvi learn Worker — the Tribunal Learn course, mounted at
// app.ygdcbtmc4u.uk/learn (blueprint B.1).
//
// PR4 is the D1 data layer + gamification API step (NID-99). It sits on the
// PR2 skeleton and carries the PR3 Clerk gate (NID-98, unmerged when this PR
// opened — see learn/src/lib/auth.js) so every route below is deny-by-default.
//
// Routes (all deny-by-default except healthz):
//   GET  /learn/healthz            public — the PR2 live-verify target
//   GET  /learn/                   Clerk-gated — coming-soon placeholder
//   GET  /learn/api/state          Clerk-gated — aggregated player state
//   POST /learn/api/complete       Clerk-gated — complete a lesson, append one
//                                  xp_event, refresh derived tables (idempotent
//                                  per lesson: double-POST does not double-XP)
//   GET  /learn/api/curriculum     Clerk-gated — curriculum JSON (placeholder
//                                  shape until PR5 fills the content)
//   everything else                uniform 404
//
// Sign-in lives at the app ROOT (served by the hub); learn verifies the
// host-wide __session cookie and redirects — it never serves sign-in itself
// (blueprint B.1/B.2). CSP default-src 'none' from day one.
import { PREFIX } from "./prefix.js";
import { getUserId } from "./lib/auth.js";
import * as store from "./lib/store.js";
import { getCurriculum } from "./lib/curriculum.js";

const ROBOTS_TAG = "noindex, nofollow";

// Same header set the hub uses. The CSP has no inline allowances — which is
// WHY css/js will be files at /learn/s.css and /learn/s.js, never inlined.
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

// One 404 for everything, byte-identical, so an observer cannot tell "never
// existed" from "not yet built".
function notFound() {
  return new Response("not found", { status: 404, headers: HTML_HEADERS });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// The coming-soon placeholder (PR2, still gated). Deliberately bare: it
// carries the strict CSP and robots tag, and nothing else — the PR6 UI
// replaces it.
function comingSoonPage() {
  return new Response(
    "<!doctype html><html lang=\"en\"><head>" +
      "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>talvi learn — coming soon</title>" +
      "</head><body><p>talvi learn — coming soon.</p></body></html>",
    { status: 200, headers: HTML_HEADERS },
  );
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
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    // ---- Clerk-gated below ---- (deny-by-default, decision 2 / carried PR3)
    // A single authenticated check supplies the user id for the per-user
    // schema; a null id is the same as no cookie for the gate.
    const userId = await getUserId(request, env);
    if (!userId) {
      // API paths answer 401 regardless of method; pages redirect to the hub's
      // sign-in (app root, blueprint B.1).
      if (request.method === "POST" || path.startsWith("/api/")) {
        return json({ error: "unauthorized" }, 401);
      }
      const signIn = new URL("/sign-in", request.url);
      signIn.searchParams.set("redirect", pathname);
      return Response.redirect(signIn.toString(), 302);
    }

    // ---- API ----
    if (request.method === "GET" && path === "/api/state") {
      const state = await store.readState(env.DB, userId);
      return json(state);
    }

    if (request.method === "POST" && path === "/api/complete") {
      return handleComplete(request, env, userId);
    }

    if (request.method === "GET" && path === "/api/curriculum") {
      return json({ curriculum: getCurriculum() });
    }

    // ---- Pages ----
    if (request.method === "GET" && (path === "/" || path === "")) {
      return comingSoonPage();
    }

    return notFound();
  },
};

// Complete a lesson: evaluate server-side, append one xp_event, refresh the
// derived tables. Body: { lesson_id, skill } (snake_case per the PR4 brief;
// camelCase lessonId is accepted for robustness). Idempotent per lesson.
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
