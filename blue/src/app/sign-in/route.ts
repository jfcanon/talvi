import { randomBytes } from "node:crypto";
import { getCloudflare } from "@/lib/env.js";
import { getPublishableKey, isAuthenticated } from "@/lib/auth.js";
import { signInCsp, signInPage } from "@/ui/signin.js";

export const dynamic = "force-dynamic";

// "/sign-in" — the custom Clerk sign-in page (blueprint L6). Generates a fresh
// nonce per request, threads it into both the strict Clerk CSP and the script
// tags, and renders the talvi-styled custom form. An already-authenticated
// visitor is bounced straight home.
export async function GET(request: Request) {
  const { env } = await getCloudflare();
  if (await isAuthenticated(request, env)) {
    return Response.redirect(new URL("/", request.url).toString(), 302);
  }
  const nonce = randomBytes(16).toString("base64url");
  return new Response(signInPage({ publishableKey: getPublishableKey(env), nonce }), {
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
