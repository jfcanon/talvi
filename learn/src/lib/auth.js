// Clerk auth for talvi learn — verbatim port of the relay/hub in-worker gate
// (which itself ports the blue release, s7/talvi-blue-auth-handover.md).
//
// PR3 (NID-98) is a serial dependency that had not merged when this PR was
// opened; per the learn-6-ui precedent (#149) the gate is carried inside this
// PR against the blueprint spec (B.2) and documented as an unmerged
// dependency. Learn never serves sign-in: the Clerk sign-in surface lives at
// the app ROOT served by the hub. Learn verifies the host-wide __session
// cookie and redirects. Networkless jwtKey verification — no clerk-js on any
// learn page, no Clerk API call per request, no CSP change.
import { createClerkClient } from "@clerk/backend";

// The host this worker answers for. authenticateRequest rejects a session
// cookie minted for any other party — the cookie-replay guard (the azp rule:
// bare hosts never match the JWT's `azp` claim, which carries the scheme).
const AUTHORIZED_PARTIES = ["https://app.ygdcbtmc4u.uk"];

// Fail-closed: if the Clerk bindings are missing the app must NOT silently
// open anything. A misconfigured deploy refuses access loudly, never silently
// opens (blueprint B.2).
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

// The authenticated user's stable id, or null when unauthenticated. Learn's
// D1 schema is per-user (decision 3 / PR4 converged schema: lesson_progress
// and player_state are keyed by user_id), so the API needs the session
// subject, not just a boolean. Single-owner app: the Clerk user id is the
// player id.
export async function getUserId(request, env) {
  if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) return null;
  try {
    const state = await getClerkClient(env).authenticateRequest(request, {
      authorizedParties: AUTHORIZED_PARTIES,
    });
    if (!state.isAuthenticated) return null;
    return state.userId || state.sessionId || "owner";
  } catch {
    return null;
  }
}
