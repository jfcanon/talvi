import { getCloudflare } from "@/lib/env.js";
import { getSessionId, revokeSession } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

// GET /api/signout — revoke the active session on Clerk's side, drop the
// __session cookie, and send the browser home. A link target, so it works
// with JS off (the signed-in upload page's SIGN OUT button is a plain <a>).
export async function GET(request: Request) {
  const { env } = await getCloudflare();
  const sessionId = await getSessionId(request, env);
  if (sessionId) {
    await revokeSession(env, sessionId);
  }
  const headers = new Headers();
  // Clearing the cookie is the important half: the browser must stop sending
  // it even if Clerk's revocation round-trip fails. Same flags Clerk sets —
  // __session is HttpOnly and SameSite=Lax; Secure is implied on HTTPS.
  headers.append("Set-Cookie", "__session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  headers.append("Location", "/");
  return new Response(null, { status: 302, headers });
}
