import { handleAsset } from "@/lib/assets.js";

export const dynamic = "force-dynamic";

// /s.js — the browser JS (client.js + ambient.js). Year-long immutable cache,
// versioned by ?v=<hash> in the markup.
export async function GET() {
  return handleAsset("/s.js");
}
