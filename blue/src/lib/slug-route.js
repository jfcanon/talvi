// The read path: /:slug, /:slug/d, and /:slug/md. Ported from the green
// worker's handleSlugRoute — the whole read path is one decision ("is this a
// live drop?") and reads better as its own function.
//
// NOTE for anyone debugging a 404 here: every miss below, and the catch-all
// route, returns a BYTE-IDENTICAL 404 — the same bytes for "expired", "never
// existed", and "R2 object missing", deliberately (blueprint B.7 item 5). The
// cost of that design is that a route which is simply not deployed yet is
// indistinguishable from broken storage.
import { withinLimit } from "./rate.js";
import { getLiveDrop } from "./store.js";
import { isValidSlug } from "../slug.js";
import { notFound, limitedHtml } from "./html.js";
import { handleView } from "./view.js";
import { handleDownload } from "./download.js";
import { handleMarkdown } from "./markdown.js";

// `action` is "view" | "d" | "md". `waitUntil` lets the download route run its
// count bump off the response path (the Workers ctx.waitUntil equivalent).
export async function readGate(env, request, slug, action, waitUntil) {
  // Read limit covers view pages, downloads, markdown conversion, AND 404
  // probing — the last is the reason it exists, since it is what bounds slug
  // guessing.
  if (!(await withinLimit(env.RL_READ, request))) return limitedHtml();

  // Validate shape BEFORE any lookup — a malformed slug never reaches D1.
  if (!isValidSlug(slug)) return notFound();

  const row = await getLiveDrop(env, slug);
  if (!row) return notFound();

  if (action === "md") return handleMarkdown(env, row);
  if (action === "d") {
    const downloaded = await handleDownload(env, row, waitUntil);
    return downloaded ?? notFound();
  }
  return handleView(env, row, slug);
}
