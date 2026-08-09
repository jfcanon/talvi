export async function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "x-robots-tag": "noindex, nofollow" },
  });
}
