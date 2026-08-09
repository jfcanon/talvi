import { getCloudflare } from "@/lib/env.js";
import { readGate } from "@/lib/slug-route.js";

export const dynamic = "force-dynamic";

// GET /:slug/md — the "as markdown" image conversion (markdown sidequest).
// Same read gate; conversion logic is in the plain-JS handleMarkdown.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { env, ctx } = await getCloudflare();
  return readGate(env, request, slug, "md", (p: Promise<unknown>) =>
    ctx.waitUntil(p),
  );
}
