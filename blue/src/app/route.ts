import { uploadPage } from "@/ui/upload.js";
import { htmlResponse, notFound } from "@/lib/html.js";

export const dynamic = "force-dynamic";

// "/" — the upload page (Step 5). Public in the blue release for now; the
// POST is the API at /api/upload and a POST to the page itself is a miss,
// exactly as on green.
export async function GET() {
  return htmlResponse(uploadPage(), 200);
}

export async function POST() {
  return notFound();
}
