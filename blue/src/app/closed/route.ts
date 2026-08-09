import { closedPage } from "@/ui/errorpage.js";
import { htmlResponse } from "@/lib/html.js";

export const dynamic = "force-dynamic";

// /closed — the themed "closed for the day" page, linked from the uploader
// when the API returns 503 and reachable directly.
export async function GET() {
  return htmlResponse(closedPage(), 503);
}
