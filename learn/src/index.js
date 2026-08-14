// talvi learn Worker — the Tribunal Learn course, mounted at
// app.ygdcbtmc4u.uk/learn (blueprint B.1).
//
// PR2 was the inert skeleton: it proved the whole pipeline before any logic
// existed. PR3 adds the Clerk owner-only gate (blueprint decision 2): every
// /learn/* route is deny-by-default. ONLY /learn/healthz and the versioned
// asset paths /learn/s.css, /learn/s.js stay public. Everything else requires
// a valid __session cookie — unauthenticated → 401 (API) / redirect to the
// hub's /sign-in (page). No lesson markup ever served unauthenticated.
//
// CSP default-src 'none' from day one: css/js live at /learn/s.css and
// /learn/s.js, never inlined (A security decision driving a build decision,
// decision 2 / B.5). The Clerk gate does NOT weaken the CSP — learn serves no
// sign-in page (the hub owns /sign-in), so no clerk-js, no inline, no eval.
import { PREFIX } from "./prefix.js";
import { isAuthenticated } from "./lib/auth.js";

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

// JSON headers for API 401s — same CSP/headers, different content-type so a
// fetch client knows it is JSON, not HTML.
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
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

// The coming-soon placeholder. Deliberately bare: it carries the strict CSP
// and robots tag, and nothing else — the PR6 UI replaces it.
function comingSoonPage() {
  return new Response(
    "<!doctype html><html lang=\"en\"><head>" +
      "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>talvi learn — coming soon</title>" +
      "</head><body><p>talvi learn — coming soon.</p></body></html>",
    { status: 200, headers: HTML_HEADERS },
  );
}

// Redirect to the hub's sign-in page (blueprint B.1/B.2). Learn never serves
// sign-in itself — /sign-in is a hub-owned route. The redirect is 302 to the
// app root so the hub's sign-in surface takes over.
function redirectToSignIn(request) {
  const url = new URL(request.url);
  const signIn = new URL("/sign-in", url.origin);
  // Clerk's hosted/custom sign-in can honour a redirect-back param, but learn
  // does not configure one — after sign-in the user lands on the hub root and
  // navigates to /learn. Adding an unchecked redirect param would be an open
  // redirect; the hub owns that surface, not learn.
  return new Response(null, {
    status: 302,
    headers: { location: signIn.toString(), "x-robots-tag": ROBOTS_TAG },
  });
}

// 401 JSON for API paths — a fetch client gets a structured refusal, not a
// redirect it would follow into an HTML page.
function unauthorizedApi() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}

// The public routes that the gate never touches (blueprint B.1 route table):
//   /healthz — the one anonymous content route (liveness check)
//   /s.css   — versioned path-prefixed asset (A11: CSP forbids inlining)
//   /s.js    — same
// Everything else under /learn/* is Clerk-gated.
const PUBLIC_PATHS = new Set(["/healthz", "/s.css", "/s.js"]);

function isPublic(path) {
  return PUBLIC_PATHS.has(path);
}

// API paths return 401 JSON; page paths redirect to /sign-in. An API path is
// anything under /api/ — the blueprint maps /learn/api/* as the gamification
// surface (PR4). HEAD is treated as the page shape (302), matching how
// Cloudflare routes HEAD as GET.
function isApiPath(path) {
  return path === "/api" || path.startsWith("/api/");
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // GET and HEAD only. HEAD is routed as GET by Cloudflare; anything else is
    // a miss.
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();

    // Strip the /learn prefix (src/prefix.js).
    if (!pathname.startsWith(PREFIX)) return notFound();
    const path = pathname.slice(PREFIX.length) || "/";

    // /learn/healthz is the one public content route — never gated, never
    // rate limited: an uptime check that trips a limiter reports an outage
    // that is not happening.
    if (path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    // Versioned asset paths are public (A11: the strict CSP forbids inlining,
    // so css/js MUST be servable as files). The build pipeline (PR6) appends
    // ?v=<hash> for immutable caching; the path itself is stable.
    if (path === "/s.css" || path === "/s.js") {
      // PR2/PR3 skeleton: the asset files are placeholder stubs (1 byte).
      // The real content ships in PR6. Return an empty 200 with the correct
      // content-type so the CSP does not break and a 404 does not leak.
      const contentType =
        path === "/s.css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      return new Response("", {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "x-robots-tag": ROBOTS_TAG,
        },
      });
    }

    // --- Clerk gate (PR3, decision 2) ---
    // Deny-by-default: every /learn/* route that is not healthz or an asset
    // requires a valid __session. No valid cookie → 401 (API) / 302 to
    // /sign-in (page). No lesson markup ever served unauthenticated.
    const authed = await isAuthenticated(request, env);
    if (!authed) {
      return isApiPath(path) ? unauthorizedApi() : redirectToSignIn(request);
    }

    // --- Authenticated routes below this line ---

    if (path === "/" || path === "") return comingSoonPage();

    return notFound();
  },
};