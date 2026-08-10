// Clerk auth for the hub — the app root's sign-in surface. Ported from the
// relay (which itself ported the blue release, s7/talvi-blue-auth-handover.md).
// The hub serves the custom sign-in (/sign-in, /sso-callback, /api/signout);
// the relay keeps an in-worker gate that verifies the SAME host-wide __session
// cookie. Networkless jwtKey verification — no clerk-js on any page except the
// two auth pages, no Clerk API call per request, no CSP change anywhere except
// those pages' own headers.
import { createClerkClient } from "@clerk/backend";

// The host this worker answers for. authenticateRequest rejects a session
// cookie minted for any other party — the cookie-replay guard (the blue
// session's authorizedParties rule, fixed 2026-08-09: bare hosts never match
// the JWT's `azp` claim, which carries the scheme).
//
// MUST be full origins (scheme + host). The hub is the front door on
// app.ygdcbtmc4u.uk; chat is session-free by contract and cinto keeps its own
// gate — so this list has exactly one entry.
const AUTHORIZED_PARTIES = ["https://app.ygdcbtmc4u.uk"];

// Fail-closed: if the Clerk bindings are missing the app must NOT silently
// open the write path. A misconfigured deploy should refuse uploads loudly,
// not accept them.
export function getClerkClient(env) {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    // jwtKey = Clerk's PEM public key. Passing it makes session verification
    // networkless: the __session JWT is verified in the V8 isolate with no
    // JWKS fetch per request.
    jwtKey: env.CLERK_JWT_KEY,
  });
}

// The publishable key is public by design; the sign-in pages need it to point
// clerk-js at the right instance.
export function getPublishableKey(env) {
  return env.CLERK_PUBLISHABLE_KEY;
}

// True when the request carries a valid __session cookie for an allowed party.
// Catches every verification error as "not authenticated" — a bad cookie is
// the same as no cookie for the gate.
export async function isAuthenticated(request, env) {
  if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) return false;
  try {
    const state = await getClerkClient(env).authenticateRequest(request, {
      authorizedParties: AUTHORIZED_PARTIES,
    });
    return state.isAuthenticated;
  } catch {
    return false;
  }
}

// The active session id, or null when unauthenticated. Used by /api/signout
// to revoke the session server-side (not merely drop the cookie).
export async function getSessionId(request, env) {
  if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) return null;
  try {
    const state = await getClerkClient(env).authenticateRequest(request, {
      authorizedParties: AUTHORIZED_PARTIES,
    });
    return state.isAuthenticated ? state.sessionId : null;
  } catch {
    return null;
  }
}

// Revoke a session on Clerk's side. Swallows failures: the cookie is dropped
// regardless, and a session Clerk cannot reach is still dead on this host the
// moment the cookie is gone.
export async function revokeSession(env, sessionId) {
  if (!sessionId) return;
  try {
    await getClerkClient(env).sessions.revokeSession(sessionId);
  } catch {
    // best effort — see above
  }
}
