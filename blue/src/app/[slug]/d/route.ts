import { getCloudflare } from "@/lib/env.js";
import { readGate } from "@/lib/slug-route.js";

export const dynamic = "force-dynamic";

// GET /:slug/d — the download route. Same read gate as the view page; the
// count bump runs via ctx.waitUntil() (the "d" action), off the response path.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { env, ctx } = await getCloudflare();
  return readGate(env, request, slug, "d", (p: Promise<unknown>) =>
    ctx.waitUntil(p),
  );
}
