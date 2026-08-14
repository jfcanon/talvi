// Clerk auth for the learn worker — the in-worker gate. Ported verbatim
// from the hub/relay pattern (which itself ported the blue release,
// s7/talvi-blue-auth-handover.md). Learn verifies the host-wide __session
// cookie; it never serves sign-in (the hub owns /sign-in, /sso-callback,
// /api/signout — blueprint B.1/B.2). Networkless jwtKey verification — no
// clerk-js on any page, no Clerk API call per request, no CSP change.
import { createClerkClient } from "@clerk/backend";

// The host this worker answers for. authenticateRequest rejects a session
// cookie minted for any other party — the cookie-replay guard (the blue
// session's authorizedParties rule, fixed 2026-08-09: bare hosts never match
// the JWT's `azp` claim, which carries the scheme).
//
// MUST be full origins (scheme + host). Learn mounts on app.ygdcbtmc4u.uk/learn;
// the __session cookie is the host-wide one Clerk mints for the hub's sign-in.
const AUTHORIZED_PARTIES = ["https://app.ygdcbtmc4u.uk"];

// Fail-closed: if the Clerk bindings are missing the app must NOT silently
// open any route. A misconfigured deploy should refuse access loudly, not
// serve content unauthenticated.
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