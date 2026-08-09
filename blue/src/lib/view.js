// GET /:slug — the view page. Markup lives in src/ui/view.js; every
// interpolated value is escaped there. The view page is the app's only
// stored-XSS sink (blueprint B.7 item 3). Whether the "as markdown" action is
// offered is decided by the object's own bytes (sniffed here, a 16-byte range
// read) — never the declared content type.
import { viewPage } from "../ui/view.js";
import { imageKindOf } from "./markdown.js";
import { HTML_HEADERS } from "./html.js";

export async function handleView(env, row, slug) {
  const kind = await imageKindOf(env, row.r2_key);
  return new Response(viewPage(row, slug, kind !== null), {
    status: 200,
    headers: HTML_HEADERS,
  });
}
