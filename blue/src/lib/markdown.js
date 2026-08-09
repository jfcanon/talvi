// "as markdown" (markdown sidequest). GET /:slug/md — an OCR/description
// conversion of an uploaded image, served as a downloadable .md and cached in
// R2 so one image is never converted twice. Ported from the green worker's
// src/index.js; design and decisions live in plans/talvi-markdown-blueprint.md.
import { notFound, json } from "./html.js";
import { sniffImageKind, imageMime } from "../sniff.js";

const MD_HEAD_BYTES = 16; // every supported signature fits in 16 bytes

// Sniff the object's OWN first bytes — never the client-declared content type
// (B.7 item 1). Returns a kind string ("jpeg", "png", ...) or null.
export async function imageKindOf(env, r2Key) {
  const head = await env.BUCKET.get(r2Key, { range: { length: MD_HEAD_BYTES } });
  if (head === null) return null;
  return sniffImageKind(await head.arrayBuffer());
}

// Derived filename for the .md attachment. The original filename was already
// scrubbed at intake (sanitiseFilename); strip any trailing image extension
// and swap in .md. The result is always plain [A-Za-z0-9._-], so it needs no
// RFC 5987 counterpart and cannot inject a header.
function mdAttachmentName(row) {
  const ascii =
    row.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
  const stem = ascii.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "transcript";
  return stem + ".md";
}

// OCR output is hostile text and is served with the SAME no-render discipline
// as downloads: attachment, nosniff, sandbox CSP. text/markdown (RFC 7763) so
// the file arrives as a real .md; attachment so nothing ever renders on this
// origin. The markdown is never served as HTML and never rendered inline.
function markdownResponse(body, row) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${mdAttachmentName(row)}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

export async function handleMarkdown(env, row) {
  // The route exists only for images — decided by the object's own bytes,
  // never the declared type. A non-image gets the byte-identical 404 (B.7 item
  // 5), so a viewer cannot tell "not an image" from "no such file".
  const kind = await imageKindOf(env, row.r2_key);
  if (!kind) return notFound();

  // Derived cache at <r2_key>.md — same prefix, so the existing lifecycle
  // rules expire it with the same TTL as the original object (blueprint §4).
  // This is what makes "one image is converted once, ever" true.
  const cacheKey = row.r2_key + ".md";
  const cached = await env.BUCKET.get(cacheKey);
  if (cached) return markdownResponse(cached.body, row);

  if (!env.AI) {
    return json({ error: "conversion unavailable" }, 502);
  }

  const object = await env.BUCKET.get(row.r2_key);
  if (object === null) return notFound();

  let md;
  try {
    const results = await env.AI.toMarkdown({
      name: "image." + kind,
      blob: new Blob([await object.arrayBuffer()], { type: imageMime(kind) }),
    });
    const result = Array.isArray(results) ? results[0] : results;
    if (!result || result.format === "error") {
      return json({ error: "conversion failed" }, 502);
    }
    md = String(result.data ?? "");
  } catch {
    // A failed conversion caches nothing, so a retry is a fresh attempt.
    return json({ error: "conversion failed" }, 502);
  }

  await env.BUCKET.put(cacheKey, md, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  return markdownResponse(md, row);
}
