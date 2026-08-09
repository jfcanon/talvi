import { robotsResponse } from "@/lib/html.js";

export const dynamic = "force-dynamic";

// /robots.txt — a request; X-Robots-Tag on every page is the enforcement.
export async function GET() {
  return robotsResponse();
}
