// DEPRECATED: Blue release (talvi2) decommissioned 2026-08-21.
// This file is preserved for reference only and is no longer executed.
//
// Previously: Clerk auth for the blue release (PR 3). Server-side session verification
// only: the __session cookie is a Clerk JWT, verified locally with
// @clerk/backend — no clerk-js on any page except /sign-in, no Clerk API call
// per request, no CSP change anywhere except the sign-in page's own headers.
//
// The Clerk auth pattern ported from blue to relay/learn is the production auth gate.
import { createClerkClient } from "@clerk/backend";

// The hosts this worker answers for. authenticateRequest rejects a session
// cookie minted for any other party — this is the cookie-replay guard (the
// sidequest's authorizedParties rule), and it is the reason the app works on
// the custom domain with no hostname allowlist: it is a fixed list of the
// origins the Clerk instance itself is configured to trust.
//
// MUST be full origins (scheme + host): Clerk mints the session JWT with an
// `azp` claim equal to the request origin (e.g. "https://talvi2.ygdcbtmc4u.uk"),
// and assertAuthorizedPartiesClaim does a literal includes() against this list.
// A bare host like "talvi2.ygdcbtmc4u.uk" never matches, so every valid session
// is rejected — the browser sees "Session already exists" while the server
// answers SESSION CLOSED. Fixed 2026-08-09.
const AUTHORIZED_PARTIES = [
  "https://talvi2.ygdcbtmc4u.uk",
  "https://talvi-blue.ygdcbtmc4u.workers.dev",
];

// Fail-closed: if the Clerk bindings are missing the app must NOT silently
// open the write path. A misconfigured deploy should refuse uploads loudly,
// not accept them.
export function getClerkClient(env) {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    // jwtKey = Clerk's PEM public key. Passing it makes session verification
    // networkless (green's Step 8 pattern): the __session JWT is verified in
    // the V8 isolate with no JWKS fetch per request.
    jwtKey: env.CLERK_JWT_KEY,
  });
}

// The publishable key is public by design; the route handler needs it to point
// clerk-js at the right instance. Kept behind a function so the TS route layer
// never touches env members directly (the existing binding-access convention).
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
