import { notFound } from "@/lib/html.js";

export const dynamic = "force-dynamic";

// Catch-all. Every path not claimed by a more specific route gets the
// byte-identical 404 (blueprint B.7 item 5) — the same bytes for "expired",
// "never existed", "R2 object missing", and "no such route". This replaces
// Next's default not-found page, whose HTML would not match the themed one.
export function GET() {
  return notFound();
}

export function POST() {
  return notFound();
}
