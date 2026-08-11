// Clerk session verification for the chat worker.
//
// Owner decision 2026-08-11: chat now requires a Clerk sign-in to use
// (plans/clerk-app-root-requirements.md §2.5). This OVERRIDES the earlier
// preservation-contract line "chat reads no session of any kind and never
// will" — recorded as a deliberate owner change. The gate is a worker-EDGE
// check: the __session cookie is verified here, before a page or a WebSocket
// upgrade is served. The Durable Object (channel.js) and the settled gate
// logic are untouched and still never read a session.
//
// Verification is networkless (jwtKey PEM), same as the hub/relay: no Clerk
// API call per request, no CSP change, no clerk-js on any chat page (the
// sign-in itself lives at the app root /sign-in).
import { createClerkClient } from "@clerk/backend";

// The host this worker answers for — the cookie-replay guard (azp must be an
// allowed party). Chat mounts at app.ygdcbtmc4u.uk/chat.
const AUTHORIZED_PARTIES = ["https://app.ygdcbtmc4u.uk"];

function getClerkClient(env) {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
  });
}

// True when the request carries a valid __session cookie for an allowed party.
// Fail-closed: a missing binding or a malformed cookie reads as "not
// authenticated".
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
