import { handleAsset } from "@/lib/assets.js";

export const dynamic = "force-dynamic";

// /s.css — the stylesheet. Year-long immutable cache is safe ONLY because the
// pages request it as /s.css?v=<hash> (see src/lib/assets.js).
export async function GET() {
  return handleAsset("/s.css");
}
