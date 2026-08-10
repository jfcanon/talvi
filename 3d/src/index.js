// talvi 3d Worker — the style study (Step 2).
//
// Claims "/" with the scroll world, serves the two versioned assets, keeps
// /healthz, and returns the uniform 404 for everything else. CSP is A5
// verbatim — default-src 'none', no unsafe-inline/eval anywhere, which is why
// the CSS and the bundled scene live at their own routes instead of being
// inlined (a security decision driving a build decision).
//
// No bindings, no D1/R2/DO, no secrets, no `migrations` block.
import { CSS, JS } from "./generated/assets.js";
import { renderPage } from "./ui/page.js";

const ROBOTS_TAG = "noindex, nofollow";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": ROBOTS_TAG,
};

// Assets are versioned at build time and served with a year-long immutable
// cache — safe ONLY because every page requests them as ?v=<hash>.
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

function notFound() {
  return new Response("not found", { status: 404, headers: HTML_HEADERS });
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method !== "GET") return notFound();

    if (pathname === "/healthz") {
      // Never rate limited: an uptime check that trips a limiter reports an
      // outage that is not happening.
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    if (pathname === "/3d.css") return assetResponse(CSS, "text/css; charset=utf-8");
    if (pathname === "/3d.js") return assetResponse(JS, "text/javascript; charset=utf-8");

    if (pathname === "/") return new Response(renderPage(), { headers: HTML_HEADERS });

    return notFound();
  },
};
