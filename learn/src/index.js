// talvi learn Worker — the Tribunal Learn course, mounted at
// app.ygdcbtmc4u.uk/learn (blueprint B.1).
//
// PR2 is the inert skeleton: it proves the whole pipeline (worktree → PR →
// plan → merge → apply → live verify) before any logic exists. It serves ONLY
// /learn/healthz (200 "ok") and the /learn coming-soon placeholder. Everything
// else is the uniform 404, so a not-yet-built route looks exactly like broken
// routing (the hub's uniform-404 rule).
//
// No auth (PR3), no data layer (PR4), no curriculum (PR5), no UI (PR6).
// CSP default-src 'none' from day one: css/js will live at /learn/s.css and
// /learn/s.js, never inlined (A security decision driving a build decision,
// decision 2 / B.5). The placeholder below is style-free on purpose — the
// first CSS arrives with the real UI.
import { PREFIX } from "./prefix.js";

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

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    // GET and HEAD only. HEAD is routed as GET by Cloudflare; anything else is
    // a miss.
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();

    // Strip the /learn prefix (src/prefix.js).
    if (!pathname.startsWith(PREFIX)) return notFound();
    const path = pathname.slice(PREFIX.length) || "/";

    if (path === "/healthz") {
      // Never rate limited: an uptime check that trips a limiter reports an
      // outage that is not happening.
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    if (path === "/" || path === "") return comingSoonPage();

    return notFound();
  },
};
