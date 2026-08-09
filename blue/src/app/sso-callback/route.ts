import { randomBytes } from "node:crypto";
import { getCloudflare } from "@/lib/env.js";
import { getPublishableKey } from "@/lib/auth.js";
import { signInCsp, ssoCallbackPage } from "@/ui/signin.js";

export const dynamic = "force-dynamic";

// "/sso-callback" — the OAuth return route (blue-3b-auth-options). The SSO
// buttons on /sign-in call signIn.authenticateWithRedirect with this as
// redirectUrl; after the provider flow Clerk sends the browser back here, and
// this page runs Clerk.handleRedirectCallback() to swap the OAuth result for a
// __session cookie before sending the user home. Same strict nonce CSP as
// /sign-in; the callback is a top-level redirect so no directive moves.
export async function GET() {
  const { env } = await getCloudflare();
  const nonce = randomBytes(16).toString("base64url");
  return new Response(ssoCallbackPage({ publishableKey: getPublishableKey(env), nonce }), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": signInCsp(nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
