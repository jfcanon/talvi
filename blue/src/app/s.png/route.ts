import { handleSprite } from "@/lib/assets.js";

export const dynamic = "force-dynamic";

// /s.png — the drone sprite, decoded from base64 once per isolate.
export async function GET() {
  return handleSprite();
}
