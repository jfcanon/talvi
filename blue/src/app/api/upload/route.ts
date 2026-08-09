import { getCloudflare } from "@/lib/env.js";
import { handleUploadRequest } from "@/lib/upload.js";
import { isAuthenticated } from "@/lib/auth.js";
import { json } from "@/lib/html.js";

export const dynamic = "force-dynamic";

// POST /api/upload — the only write route, gated on a Clerk session (blueprint
// L5). Auth check comes first, before the rate limit or any upload logic: an
// unauthenticated request must never reach the write path or burn a rate-limit
// slot. The upload rate-limit gate and the write live in the plain-JS lib
// (handleUploadRequest) so every binding access stays out of the TypeScript
// layer.
export async function POST(request: Request) {
  const { env } = await getCloudflare();
  if (!(await isAuthenticated(request, env))) {
    return json({ error: "unauthorized; sign in at /sign-in" }, 401);
  }
  return handleUploadRequest(request, env);
}

// GET /api/upload — where Cloudflare Access redirects the browser back after
// the email PIN on green (client.js navigates here on XHR interception). Kept
// for parity: there is no GET handler; redirect to the upload page so the
// owner lands somewhere useful and can retry.
export async function GET(request: Request) {
  return Response.redirect(new URL("/", request.url).toString(), 302);
}
