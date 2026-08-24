// Leoncito dashboard proxy — serves the Pages project at
// app.ygdcbtmc4u.uk/leoncito on the free plan.
//
// Why a Worker instead of rulesets: the transform-rule path rewrite needs
// regex_replace (Business / WAF Advanced only) and the origin-rule HostHeader
// override needs a paid plan — both 400'd on this zone. The Worker does the
// same job (strip the /leoncito prefix, proxy to the Pages host) for free.
//
// Gate (NID-400): verifies the host-wide __session cookie via vendored
// RS256 verifier with CLERK_JWT_KEY (no @clerk/backend — avoids bundling,
// matches worker.js NID-402 pattern). Fail-closed when key absent.
// Unauth'd visitors are redirected to /sign-in?redirect=<same-origin path>
// (encodeURIComponent preserves the original path+query for post-login bounce).
// The routes (app.ygdcbtmc4u.uk/leoncito and /leoncito/*) are more specific
// than the hub's `/*` fallback, so they win without touching the hub.
// Clerk session tokens carry the instance home_url (https://talvi.ygdcbtmc4u.uk)
// or the auth domain (https://accounts.ygdcbtmc4u.uk) in their `azp` claim —
// NOT the app host the visitor lands on. All three origins must be accepted
// (NID-410 root cause of sign-in redirect loop).
const AUTHORIZED_PARTIES = [
  "https://app.ygdcbtmc4u.uk",
  "https://talvi.ygdcbtmc4u.uk",
  "https://accounts.ygdcbtmc4u.uk",
];

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function pemToSpki(pem) {
  const body = pem.replace(/-----(?:BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function isAuthenticated(request, env) {
  if (!env.CLERK_JWT_KEY) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)__session=([^;]+)/);
  if (!m) return false;
  let token = m[1].trim();
  try {
    if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (header.alg !== "RS256") return false;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || claims.exp < now - 5) return false;
    if (!AUTHORIZED_PARTIES.includes(claims.azp)) return false;
    const key = await crypto.subtle.importKey(
      "spki",
      pemToSpki(env.CLERK_JWT_KEY),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    return ok;
  } catch {
    return false;
  }
}

// PUBLIC_MODE: when "true", skip Clerk auth for demo/public sharing.
// Set via env var in main.tf (e.g., PUBLIC_MODE = "true" for recruiter demo).
function isPublicMode(env) {
  return env.PUBLIC_MODE === "true";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Gate: require a valid Clerk __session cookie (host-wide) — skip in PUBLIC_MODE.
    if (!isPublicMode(env) && !(await isAuthenticated(request, env))) {
      const redirect = "/sign-in?redirect=" + encodeURIComponent(url.pathname + url.search);
      return Response.redirect(new URL(redirect, request.url).toString(), 302);
    }

    // Bare /leoncito (no trailing slash): the HTML's relative asset URLs
    // (css/…, js/…, data/…) resolve against the page path, so from /leoncito
    // they'd land on /css, /js, /data — outside this prefix, onto the hub's
    // /* fallback, which returns HTML and breaks strict MIME checks (the
    // dashboard rendered all dashes). Normalize to the directory form, same
    // as relay/chat/learn.
    if (url.pathname === "/leoncito") {
      return Response.redirect(new URL("/leoncito/", request.url), 302);
    }
    const rest = url.pathname.replace(/^\/leoncito\/?/, "/") + url.search;
    return fetch("https://leoncito-dashboard.pages.dev" + rest, request);
  },
};
