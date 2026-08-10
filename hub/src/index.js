// talvi hub Worker — the power-app front door (A1, now the 3D hub).
//
// P1: "/" claims the 3D hub — the talvi world with the blade on top and one
// instrument per app (plans/talvi-3d-hub-blueprint.md). Everything not claimed
// by a more-specific route (or a future app worker) is the uniform 404, so a
// not-yet-migrated route looks exactly like broken routing.
//
// The full architecture is in plans/talvi-hub-blueprint.md:
//   - hub worker owns app.ygdcbtmc4u.uk/* (the `/*` fallback)
//   - relay/chat/cinto mount at more-specific path routes, each its own Worker
//   - CSP default-src 'none': css/js live at /h.css /h.js, never inlined
//     (A security decision driving a build decision, A11).
import { H_CSS, H_JS } from "./generated/assets.js";
import { hubPage } from "./ui/hubpage.js";
import { isAuthenticated, getSessionId, revokeSession, getPublishableKey } from "./lib/auth.js";
import { signInPage, ssoCallbackPage, signInCsp } from "./ui/signin.js";

const ROBOTS_TAG = "noindex, nofollow";

// A fresh CSP nonce for the two clerk-js pages (/sign-in, /sso-callback).
// 18 random bytes base64url-encoded — no entropy from the request, nothing
// derivable from any header. Workers has no node:crypto; getRandomValues is
// the platform's CSPRNG.
function nonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Same header set green uses. The CSP has no inline style/script allowances —
// which is WHY css/js live at /h.css and /h.js instead of being inlined.
// Referrer-Policy: no-referrer matters more than usual here: the blade will
// link out to apps whose URLs can contain secret slugs, and no-referrer keeps
// those out of the Referer header.
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": ROBOTS_TAG,
};

// Assets are versioned at build time (the asset hash) and served with a
// year-long immutable cache — safe ONLY because every page requests them as
// /h.css?v=<hash>. Mirrors green's ASSET_CACHE.
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

// One 404 for everything, byte-identical, so an observer cannot tell "expired"
// from "never existed" from "not yet migrated". (Part B, uniform-404 rule.)
function notFound() {
  return new Response("not found", { status: 404, headers: HTML_HEADERS });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // GET-only for now. HEAD is routed as GET by Cloudflare; anything else is
    // a miss.
    if (request.method !== "GET") return notFound();

    if (pathname === "/healthz") {
      // Never rate limited: an uptime check that trips a limiter reports an
      // outage that is not happening.
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    if (pathname === "/h.css") return assetResponse(H_CSS, "text/css; charset=utf-8");
    if (pathname === "/h.js") return assetResponse(H_JS, "text/javascript; charset=utf-8");

    if (pathname === "/") {
      // The front door knows whether this visitor is signed in, so the blade
      // login control can say SIGN IN or SIGN OUT (the 3D welcome page itself
      // is the hub session's design; this is the auth state it needs).
      const authed = await isAuthenticated(request, env);
      return new Response(hubPage({ authed }), { headers: HTML_HEADERS });
    }

    // "/sign-in" and "/sso-callback" — the two clerk-js pages (s7 handover §4).
    // The ONLY pages whose CSP widens to the strict nonce + strict-dynamic
    // Clerk CSP (signInCsp); everything else keeps HTML_HEADERS byte-for-byte.
    // An already-authenticated visitor to /sign-in is bounced straight home.
    if (pathname === "/sign-in") {
      if (await isAuthenticated(request, env)) {
        return Response.redirect(new URL("/", request.url).toString(), 302);
      }
      const n = nonce();
      return new Response(signInPage({ publishableKey: getPublishableKey(env), nonce: n }), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": signInCsp(n),
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-robots-tag": ROBOTS_TAG,
        },
      });
    }

    if (pathname === "/sso-callback") {
      const n = nonce();
      return new Response(ssoCallbackPage({ publishableKey: getPublishableKey(env), nonce: n }), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": signInCsp(n),
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-robots-tag": ROBOTS_TAG,
        },
      });
    }

    // GET /api/signout — a link target (works with JS off): revoke the active
    // session on Clerk's side, drop the __session cookie, send the browser
    // home.
    if (pathname === "/api/signout") {
      const sessionId = await getSessionId(request, env);
      if (sessionId) await revokeSession(env, sessionId);
      const headers = new Headers({
        Location: "/",
      });
      // Clearing the cookie is the important half: the browser must stop
      // sending it even if Clerk's revocation round-trip fails. Same flags
      // Clerk sets — __session is HttpOnly and SameSite=Lax.
      headers.append("Set-Cookie", "__session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
      return new Response(null, { status: 302, headers });
    }

    // /agent/ws — the agent's WebSocket surface (blueprint PR2). Handled
    // before the trailing-slash redirects and the 404: it is a GET with an
    // Upgrade header (an HTTP upgrade is not a page navigation), so it never
    // collides with the app-root redirects below. One agent per name (the
    // owner's prototype agent is "main"); the DO owns a workspace and a chat
    // loop. Mirror of chat's /chat/<name>/ws route — same plain-route shape,
    // same CSP (connect-src 'self' permits the same-origin upgrade).
    if (pathname === "/agent/ws") {
      const stub = env.AGENT.getByName("main");
      return stub.fetch(request);
    }

    // Bare app-root paths for the path-mounted apps. Cloudflare's route
    // specificity for an exact route plus a `/*` route on the same worker is
    // inconsistent on the bare path (the hub's `/*` fallback wins /chat while
    // /relay routes fine). The slashed forms /chat/ and /relay/ are proven to
    // route correctly, so normalize here — a trailing-slash redirect is
    // standard web practice and sidesteps the quirk entirely.
    if (pathname === "/chat" || pathname === "/relay") {
      return Response.redirect(new URL(pathname + "/", request.url).toString(), 301);
    }

    // Uniform 404 for everything else — a not-yet-migrated route reads exactly
    // like broken routing, as the blueprint intends.
    return notFound();
  },
};

// The AgentDO Durable Object must be a NAMED export of the deployed module for
// the runtime to instantiate it (the AGENT binding in main.tf references it by
// class name). Re-exporting here is what makes esbuild keep it in the bundle
// with its export visible. Same shape as chat's ChatChannel re-export.
export { AgentDO } from "./agent/agentdo.js";
