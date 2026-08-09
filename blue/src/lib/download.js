// GET /:slug/d — the download route. Ported from the green worker's
// src/index.js handleDownload. The header block below is THE single most
// important header block in this project (blueprint B.7 item 1): the
// user-declared content type is NEVER echoed. Uploaded HTML must never render
// on this origin — always an opaque attachment, no branch, no allowlist.
// row.content_type exists only as a text label on the view page.
//
// The download-count bump is kept separate so the route handler can run it
// via ctx.waitUntil(), off the response path — the same fire-and-forget the
// green worker did.
export async function downloadResponse(env, row) {
  const object = await env.BUCKET.get(row.r2_key);
  if (object === null) return null; // lifecycle deleted it ahead of the row

  // ASCII fallback: aggressive [A-Za-z0-9._-] reduction, non-empty, <=100.
  const ascii =
    row.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
  // RFC 5987 value for the real name: percent-encode, including the chars
  // encodeURIComponent leaves alone but attr-char forbids: ' ( ) *
  const encoded = encodeURIComponent(row.filename)
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition":
        `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

export function bumpCount(db, slug) {
  return db
    .prepare(`UPDATE drops SET download_count = download_count + 1 WHERE slug = ?`)
    .bind(slug)
    .run();
}

// Combines the lookup with the count bump; returns null when the R2 object is
// gone so the caller can serve the byte-identical 404.
export async function handleDownload(env, row, waitUntil) {
  const response = await downloadResponse(env, row);
  if (response === null) return null;
  waitUntil(bumpCount(env.DB, row.slug));
  return response;
}
