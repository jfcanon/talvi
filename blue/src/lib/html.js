// Response builders shared by the read-path handlers. Ported from the green
// worker's src/index.js (talvi/), which is the security-reviewed source of
// truth; the constants and helpers here mirror it so the blue app serves the
// same bytes with the same reasoning.
import { notFoundPage } from "../ui/notfound.js";
import { limitedPage } from "../ui/errorpage.js";

export const ROBOTS_TAG = "noindex, nofollow";

// Every HTML response carries this exact header set. The CSP has no
// 'unsafe-inline' — which is WHY css/js live at /s.css and /s.js instead of
// being inlined (a security decision driving a build decision, blueprint B.7
// item 3).
// Referrer-Policy: no-referrer matters more than usual: without it, clicking
// any link from a view page leaks the secret slug in the Referer header.
export const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": ROBOTS_TAG,
};

// One 404 for everything: malformed slug, never-existed, expired. Deliberately
// byte-identical so an observer cannot distinguish "expired" from "never
// existed" (blueprint B.7 item 5) — which is why notFoundPage() takes no
// arguments. This is the only 404 this app serves: the catch-all route
// (app/[...path]/route.ts) and every handler miss return exactly this.
export function notFound() {
  return new Response(notFoundPage(), { status: 404, headers: HTML_HEADERS });
}

export function limitedHtml() {
  return new Response(limitedPage(), { status: 429, headers: HTML_HEADERS });
}

// Shared constructor for themed HTML responses so route handlers never build
// a Response with the header set by hand.
export function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: HTML_HEADERS });
}

// robots.txt response, with the year-long-free cache green uses.
export function robotsResponse() {
  return new Response(ROBOTS, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": ROBOTS_TAG,
      "cache-control": "public, max-age=86400",
    },
  });
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

// robots.txt is a request; X-Robots-Tag is enforcement. Both, deliberately:
// a crawler that ignores the file still sees the header, and the header alone
// is invisible to anyone auditing the site's intent.
export const ROBOTS = "User-agent: *\nDisallow: /\n";
