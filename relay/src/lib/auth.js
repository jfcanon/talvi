// Clerk auth for the relay — ported from the blue release (talvi-blue-auth-
// handover.md, s7). Server-side session verification only: the __session
// cookie is a Clerk JWT, verified locally with @clerk/backend — no clerk-js on
// any page, no Clerk API call per request, no CSP change anywhere. The sign-in
// itself lives at the app ROOT (the hub worker serves /sign-in); this worker
// only verifies the host-wide __session cookie.
//
// The gate is in-worker and fail-closed: a missing binding or a malformed
// cookie reads as "not authenticated".
import { createClerkClient } from "@clerk/backend";

// The host this worker answers for. authenticateRequest rejects a session
// cookie minted for any other party — the cookie-replay guard (the blue
// session's authorizedParties rule, fixed 2026-08-09: bare hosts never match
// the JWT's `azp` claim, which carries the scheme).
//
// MUST be full origins (scheme + host). The relay is the file drop on
// app.ygdcbtmc4u.uk/relay; the hub worker owns `/*`, chat is session-free by
// contract, and cinto keeps its own gate — so this list has exactly one entry.
const AUTHORIZED_PARTIES = ["https://app.ygdcbtmc4u.uk"];

// Fail-closed: if the Clerk bindings are missing the app must NOT silently
// open the write path. A misconfigured deploy should refuse uploads loudly,
// not accept them. The relay serves no clerk-js pages, so only the secret key
// (and the jwtKey PEM, verified below) are required — no publishable key.
export function getClerkClient(env) {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
  });
}

// True when the request carries a valid __session cookie for an allowed party.
// Catches every verification error as "not authenticated" — a bad cookie is
// the same as no cookie for the gate.
export async function isAuthenticated(request, env) {
  if (!env.CLERK_SECRET_KEY) return false;
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
