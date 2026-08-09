// The write path. Ported from the green worker's src/index.js handleUpload,
// which was security-reviewed against a hostile client (no friendly form):
// the checks below are ordered cheapest-first, no-side-effect validation
// before any write. The route handler (app/api/upload) applies the upload rate
// limit before calling in, exactly as green's route() did.
import { ensureSchema } from "./store.js";
import { withinLimit } from "./rate.js";
import { sanitiseFilename, validateContentType } from "../sanitise.js";
import { newSlug } from "../slug.js";
import { json } from "./html.js";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB — see blueprint B.6
const MAX_DAILY_BYTES = 250 * 1024 * 1024; // 250 MiB/day — bounds storage inside R2 free tier, B.8
const TTL_DAYS = new Set([1, 7, 30]);
const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleUpload(request, env) {
  await ensureSchema(env.DB);

  // --- header validation (no bytes read, no writes) ---
  const ttlRaw = request.headers.get("x-drop-ttl") ?? "1";
  const ttl = Number(ttlRaw);
  if (!TTL_DAYS.has(ttl)) {
    return json({ error: "invalid ttl; allowed: 1, 7, 30" }, 400);
  }

  // Content-Length is mandatory so an oversize upload can be refused before a
  // single byte is read — without it the only size signal arrives after the
  // bytes are already stored. A chunked (length-less) upload is refused here
  // (B.6); this is the only place chunked is rejected.
  //
  // Observed live (Step 3 verification): a SMALL chunked upload returns 200,
  // not 411 — Cloudflare's edge buffers it and hands this Worker a computed
  // Content-Length, so the 411 branch never sees it. That is safe (the length
  // is edge-verified, stricter than client-declared) and is documented here
  // rather than "fixed". The 411 stands for whatever the edge passes through.
  const clRaw = request.headers.get("content-length");
  if (clRaw === null) {
    return json({ error: "content-length required" }, 411);
  }
  const contentLength = Number(clRaw);
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    return json({ error: "invalid content-length" }, 400);
  }
  if (contentLength > MAX_BYTES) {
    return json({ error: "file too large", max_bytes: MAX_BYTES }, 413);
  }

  // --- daily byte budget, before any write (B.7 item 4) ---
  // Bound with an ISO 8601 string computed in JS, never datetime('now', ...):
  // SQLite's datetime() output format cannot be compared against the ISO
  // strings this app stores (B.4/B.5).
  const cutoff = new Date(Date.now() - DAY_MS).toISOString();
  const budgetRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM drops WHERE uploaded_at > ?`,
  )
    .bind(cutoff)
    .first();
  if ((budgetRow?.used ?? 0) >= MAX_DAILY_BYTES) {
    return json({ error: "daily budget reached; try tomorrow" }, 503);
  }

  if (request.body === null) {
    return json({ error: "empty body" }, 400);
  }

  const filename = sanitiseFilename(request.headers.get("x-drop-filename"));
  const contentType = validateContentType(request.headers.get("x-drop-type"));

  const slug = newSlug();
  const r2Key = "d" + ttl + "/" + slug;

  // --- buffer the body, then put to R2 ---
  // In OpenNext the request body is NOT available as a stream to the route
  // handler: the Next runtime reads it before dispatch, so `request.body` is
  // undefined and `bodyUsed` is already true (verified live). The bytes are
  // only reachable via `request.arrayBuffer()`. Since the runtime has already
  // buffered the whole body, streaming to R2 would save nothing — so put() is
  // handed the buffer directly, which also sidesteps the FixedLengthStream
  // "unknown length" problem entirely. The green worker streams request.body
  // straight to put() because there the worker IS the first reader; blue is
  // different by construction.
  //
  // Size enforcement stays layered, in the same order as green:
  //   1. Content-Length > MAX_BYTES is rejected above, before any read. This
  //      is the cheap path and catches every honest client.
  //   2. The Cloudflare edge holds the body to its declared Content-Length,
  //      so a client that declares 5 bytes cannot smuggle 5 GB past it. This
  //      is the control that actually stops a lying client.
  //   3. The arrayBuffer is re-measured below and compared against the
  //      declared length; put() returns the object's TRUE stored size, which
  //      is checked against the cap and the object deleted if it exceeds it.
  let stored;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== contentLength) {
      // The runtime buffered a different length than the edge-verified header
      // promised. Refuse rather than store a body of unknown provenance.
      return json({ error: "body length mismatch" }, 400);
    }
    stored = await env.BUCKET.put(r2Key, bytes);
  } catch (e) {
    await env.BUCKET.delete(r2Key).catch(() => {}); // no orphan object
    return json({ error: "upload failed" }, 400);
  }

  // put() resolving with null/undefined means nothing was stored. Treat it as
  // a failure rather than writing a D1 row pointing at an empty shelf — that
  // exact mismatch (row present, object absent) is what produced a 404 on
  // every download before this change.
  if (!stored) {
    return json({ error: "upload failed" }, 400);
  }

  const counted = stored.size;

  if (counted > MAX_BYTES) {
    await env.BUCKET.delete(r2Key).catch(() => {});
    return json({ error: "file too large", max_bytes: MAX_BYTES }, 413);
  }

  // --- D1 row (parameterised; ISO timestamps computed in JS) ---
  const now = new Date();
  const uploadedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl * DAY_MS).toISOString();

  await env.DB.prepare(
    `INSERT INTO drops
       (slug, r2_key, filename, content_type, size_bytes, uploaded_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slug, r2Key, filename, contentType, counted, uploadedAt, expiresAt)
    .run();

  const url = new URL(request.url);
  return json({
    slug,
    url: `${url.origin}/${slug}`,
    expires_at: expiresAt,
    size_bytes: counted,
  });
}

// The app/api/upload POST handler: the upload rate limit gate, then the write.
// Kept in JS so the route handler stays a thin TypeScript shell — every
// binding access lives in these plain-JS modules.
export async function handleUploadRequest(request, env) {
  if (!(await withinLimit(env.RL_UPLOAD, request))) {
    return json({ error: "too many uploads; wait a minute" }, 429);
  }
  return handleUpload(request, env);
}
