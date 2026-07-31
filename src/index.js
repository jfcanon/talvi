// Inert Worker — Step 2. Proves the CI-only Terraform pipeline and the
// two-stage esbuild bundle against a script that touches nothing.
// No D1, no R2, no data path until Step 3.
import { renderPage } from "./ui/layout.js";

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    return new Response(renderPage("not found", "<p>not found</p>"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
