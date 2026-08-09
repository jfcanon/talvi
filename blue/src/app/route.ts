import { uploadPage } from "@/ui/upload.js";
import { htmlResponse, notFound } from "@/lib/html.js";
import { getCloudflare } from "@/lib/env.js";
import { isAuthenticated } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

// "/" — the upload page (Step 5). Upload is gated on a Clerk session (blueprint
// L5): authenticated visitors get the working form; everyone else gets the same
// page with a sign-in prompt in place of the drop zone. Sharing (/:slug,
// /:slug/d) is untouched and public. A POST to the page itself is a miss,
// exactly as on green.
export async function GET(request: Request) {
  const { env } = await getCloudflare();
  const authed = await isAuthenticated(request, env);
  return htmlResponse(uploadPage({ authed }), 200);
}

export async function POST() {
  return notFound();
}
