// talvi Worker.
// Step 2 stood up an inert skeleton; Step 3 adds the write path (no UI — it is
// driven entirely by curl, so the security logic is tested against a hostile
// client rather than a friendly form). Read paths arrive in Step 4.
import { renderPage } from "./ui/layout.js";
import { newSlug, isValidSlug } from "./slug.js";
import { sanitiseFilename, validateContentType, escapeHtml } from "./sanitise.js";

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

// ---------------------------------------------------------------------------
// Read path (Step 4). The security-critical half of the app — see B.7.
// ---------------------------------------------------------------------------

// Every HTML response carries this exact header set. The CSP has no
// 'unsafe-inline' — which is WHY css/js live at /s.css and /s.js instead of
// being inlined (a security decision driving a build decision, B.7 item 3).
// Referrer-Policy: no-referrer matters more than usual: without it, clicking
// any link from a view page leaks the secret slug in the Referer header.
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

// One 404 for everything: malformed slug, never-existed, expired. Deliberately
// byte-identical so an observer cannot distinguish "expired" from "never
// existed" (B.7 item 5). Stub styling until Step 5.
function notFound() {
  return new Response(
    renderPage("not found", "<main><h1>404</h1><p>nothing here.</p></main>"),
    { status: 404, headers: HTML_HEADERS },
  );
}

// Look up a live (non-expired) drop, or null. Slug is regex-validated BEFORE
// this is called — a malformed slug must never reach D1. Expiry compares in
// JS against the stored ISO string, never in SQL (B.4).
async function getLiveDrop(env, slug) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT * FROM drops WHERE slug = ?`)
    .bind(slug)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function handleView(row, slug) {
  // Every interpolated value goes through escapeHtml — the view page is the
  // app's only stored-XSS sink (B.7 item 3).
  const name = escapeHtml(row.filename);
  const type = escapeHtml(row.content_type);
  const size = escapeHtml(formatSize(row.size_bytes));
  const expires = escapeHtml(row.expires_at);
  const body =
    "<main>" +
    `<h1>${name}</h1>` +
    `<p>${type} &middot; ${size}</p>` +
    `<p>expires ${expires}</p>` +
    `<p><a href="/${slug}/d">download</a></p>` +
    "</main>";
  return new Response(renderPage(name, body), { status: 200, headers: HTML_HEADERS });
}

async function handleDownload(env, row, ctx) {
  const object = await env.BUCKET.get(row.r2_key);
  if (object === null) return notFound(); // lifecycle deleted it ahead of the row

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

  // Fire-and-forget count bump; ctx.waitUntil keeps it off the response path.
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE drops SET download_count = download_count + 1 WHERE slug = ?`,
    )
      .bind(row.slug)
      .run(),
  );

  // THE single most important header block in this project (B.7 item 1):
  // the user-declared content type is NEVER echoed. Uploaded HTML must never
  // render on this origin — always an opaque attachment, no branch, no
  // allowlist. row.content_type exists only as a text label on the view page.
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

// Stub assets. no-store DELIBERATELY — the immutable year-long cache header
// must not ship until Step 5 puts real content at these URLs, or anyone who
// loads a page during Step 4 is stuck with empty stubs for a year.
function handleAsset(pathname) {
  if (pathname === "/s.css") {
    return new Response("/* step 5 */", {
      headers: { "content-type": "text/css", "cache-control": "no-store" },
    });
  }
  return new Response("// step 5", {
    headers: {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/healthz" && method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (pathname === "/api/upload" && method === "POST") {
      return handleUpload(request, env);
    }

    if ((pathname === "/s.css" || pathname === "/s.js") && method === "GET") {
      return handleAsset(pathname);
    }

    // /:slug and /:slug/d — validate shape BEFORE any lookup.
    const m = pathname.match(/^\/([^/]+)(\/d)?$/);
    if (m && method === "GET") {
      if (!isValidSlug(m[1])) return notFound();
      const row = await getLiveDrop(env, m[1]);
      if (!row) return notFound();
      return m[2] ? handleDownload(env, row, ctx) : handleView(row, m[1]);
    }

    return notFound();
  },
};
