// talvi Worker.
// Step 2 stood up an inert skeleton; Step 3 adds the write path (no UI — it is
// driven entirely by curl, so the security logic is tested against a hostile
// client rather than a friendly form). Read paths arrive in Step 4.
import { renderPage } from "./ui/layout.js";
import { newSlug } from "./slug.js";
import { sanitiseFilename, validateContentType } from "./sanitise.js";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB — see blueprint B.6
const MAX_DAILY_BYTES = 250 * 1024 * 1024; // 250 MiB/day — bounds storage inside R2 free tier, B.8
const TTL_DAYS = new Set([1, 7, 30, 90]); // must match the lifecycle prefixes in main.tf
const DAY_MS = 24 * 60 * 60 * 1000;

// CREATE TABLE IF NOT EXISTS at the top of any handler touching D1 — the
// relay's idiom, deliberately kept so this project needs no migration tooling.
async function ensureSchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS drops (
        slug           TEXT PRIMARY KEY,
        r2_key         TEXT NOT NULL,
        filename       TEXT NOT NULL,
        content_type   TEXT NOT NULL,
        size_bytes     INTEGER NOT NULL,
        uploaded_at    TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        download_count INTEGER NOT NULL DEFAULT 0
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_drops_expires_at  ON drops(expires_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_drops_uploaded_at ON drops(uploaded_at)`),
  ]);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

// Checks are ordered cheapest-first: no-side-effect validation before any write.
async function handleUpload(request, env) {
  await ensureSchema(env.DB);

  // --- header validation (no bytes read, no writes) ---
  const ttlRaw = request.headers.get("x-drop-ttl") ?? "1";
  const ttl = Number(ttlRaw);
  if (!TTL_DAYS.has(ttl)) {
    return json({ error: "invalid ttl; allowed: 1, 7, 30, 90" }, 400);
  }

  // Content-Length is mandatory: a FixedLengthStream needs a declared length,
  // and a chunked (length-less) upload is refused outright here (B.6). This is
  // the only place chunked is rejected — there is no separate lying-length case.
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

  // --- stream to R2 via FixedLengthStream (B.6) ---
  // Never request.arrayBuffer()/formData()/text(): R2 put() requires a stream
  // of KNOWN length, and buffering a 25 MiB body defeats the memory ceiling.
  // A counting TransformStream guards against a declared length that undersells
  // the real upload (Content-Length is still client-supplied).
  let counted = 0;
  let overflowed = false;
  const counter = new TransformStream({
    transform(chunk, controller) {
      counted += chunk.byteLength;
      if (counted > MAX_BYTES) {
        overflowed = true;
        controller.error(new Error("over MAX_BYTES"));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const fixed = new FixedLengthStream(contentLength);

  // Pump body -> counter -> fixed.writable while put() drains fixed.readable.
  // A byte-count mismatch against the declared length, or an overflow, errors
  // the pipe; that propagates to put(), and both are caught together below.
  const pump = request.body
    .pipeThrough(counter)
    .pipeTo(fixed.writable)
    .catch(() => {});

  try {
    await env.BUCKET.put(r2Key, fixed.readable);
    await pump;
  } catch {
    await env.BUCKET.delete(r2Key).catch(() => {}); // no orphan object
    if (overflowed || counted > MAX_BYTES) {
      return json({ error: "file too large", max_bytes: MAX_BYTES }, 413);
    }
    return json({ error: "upload stream did not match content-length" }, 400);
  }

  if (overflowed || counted > MAX_BYTES) {
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/healthz" && method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (pathname === "/api/upload" && method === "POST") {
      return handleUpload(request, env);
    }

    return new Response(renderPage("not found", "<p>not found</p>"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
