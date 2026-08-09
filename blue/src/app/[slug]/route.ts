import { getCloudflare } from "@/lib/env.js";
import { readGate } from "@/lib/slug-route.js";

export const dynamic = "force-dynamic";

// GET /:slug — the view page (read path). All decision logic is in the
// plain-JS readGate; this handler is just the bridge to the Workers bindings.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { env, ctx } = await getCloudflare();
  return readGate(env, request, slug, "view", (p: Promise<unknown>) =>
    ctx.waitUntil(p),
  );
}
