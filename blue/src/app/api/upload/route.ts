import { getCloudflare } from "@/lib/env.js";
import { handleUploadRequest } from "@/lib/upload.js";

export const dynamic = "force-dynamic";

// POST /api/upload — the only write route. The upload rate-limit gate and the
// write live in the plain-JS lib (handleUploadRequest) so every binding access
// stays out of the TypeScript layer.
export async function POST(request: Request) {
  const { env } = await getCloudflare();
  return handleUploadRequest(request, env);
}

// GET /api/upload — where Cloudflare Access redirects the browser back after
// the email PIN on green (client.js navigates here on XHR interception). Kept
// for parity: there is no GET handler; redirect to the upload page so the
// owner lands somewhere useful and can retry.
export async function GET(request: Request) {
  return Response.redirect(new URL("/", request.url).toString(), 302);
}
