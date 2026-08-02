// talvi Worker.
// Step 2 stood up an inert skeleton; Step 3 added the write path (no UI — it
// was driven entirely by curl, so the security logic was tested against a
// hostile client rather than a friendly form). Step 4 added the read paths.
// Step 5 adds the UI: "/" now serves an upload page instead of falling through
// to the 404, and /s.css and /s.js serve real content.
import { STYLE_CSS, CLIENT_JS } from "./generated/assets.js";
import { closedPage, limitedPage } from "./ui/errorpage.js";
import { notFoundPage } from "./ui/notfound.js";
import { uploadPage } from "./ui/upload.js";
import { viewPage } from "./ui/view.js";
import { newSlug, isValidSlug } from "./slug.js";
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

  // --- stream to R2 (B.6) ---
  // Cloudflare's documented pattern, verbatim: hand request.body straight to
  // put(). Never request.arrayBuffer()/formData()/text() — buffering a 25 MiB
  // body defeats the memory ceiling.
  //
  // This replaced a counting TransformStream + FixedLengthStream rig. To be
  // accurate about why, because the first version of this comment was not:
  // that rig WORKED. Objects it wrote are still in the bucket and still
  // download correctly. It was removed for being unnecessary, not for being
  // broken. Its premise — "R2 needs a known length, pipeThrough(counter)
  // destroys the length, so restore it with FixedLengthStream" — is wrong at
  // the first step: put() takes a plain ReadableStream, and FixedLengthStream
  // is documented for setting Content-Length on an OUTBOUND Request/Response.
  // The length constraint only existed because the counter introduced it.
  //
  // The rig was blamed for a 404 that had a different cause entirely (the
  // download route was not yet deployed when it was tested). Keeping this
  // simpler version is still right, but on its own merits: fewer moving parts,
  // the vendor's documented shape, no swallowed errors, and a size that comes
  // from R2 rather than from a counter we maintain ourselves.
  //
  // Size enforcement without the counter, in layers:
  //   1. Content-Length > MAX_BYTES is rejected above, before a single byte
  //      is read. This is the cheap path and catches every honest client.
  //   2. The Cloudflare edge holds the body to its declared Content-Length,
  //      so a client that declares 5 bytes cannot smuggle 5 GB past it. This
  //      is the control that actually stops a lying client — it is enforced
  //      upstream of this Worker, not by us.
  //   3. put() returns the object's TRUE stored size. Checked below and the
  //      object deleted if it somehow exceeds the cap. Belt to (2)'s braces,
  //      and a better number than a self-maintained counter: it is what R2
  //      recorded, not what we believe we passed along.
  let stored;
  try {
    stored = await env.BUCKET.put(r2Key, request.body);
  } catch {
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

// ---------------------------------------------------------------------------
// Read path (Step 4). The security-critical half of the app — see B.7.
// ---------------------------------------------------------------------------

// Every HTML response carries this exact header set. The CSP has no
// 'unsafe-inline' — which is WHY css/js live at /s.css and /s.js instead of
// being inlined (a security decision driving a build decision, B.7 item 3).
// Referrer-Policy: no-referrer matters more than usual: without it, clicking
// any link from a view page leaks the secret slug in the Referer header.
const ROBOTS_TAG = "noindex, nofollow";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": ROBOTS_TAG,
};

// One 404 for everything: malformed slug, never-existed, expired. Deliberately
// byte-identical so an observer cannot distinguish "expired" from "never
// existed" (B.7 item 5) — which is why notFoundPage() takes no arguments.
function notFound() {
  return new Response(notFoundPage(), { status: 404, headers: HTML_HEADERS });
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

// Markup lives in src/ui/view.js; every interpolated value is escaped there.
// The view page is the app's only stored-XSS sink (B.7 item 3).
function handleView(row, slug) {
  return new Response(viewPage(row, slug), { status: 200, headers: HTML_HEADERS });
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

// Real assets (Step 5). Step 4 served stubs with `no-store` deliberately, so
// that nobody who loaded a page then would be stuck with an empty stylesheet
// for a year. Now that there is real content, the cache is immutable and
// year-long — safe ONLY because layout.js requests these as /s.css?v=<hash>,
// so the URL changes whenever the bytes do. Never ship an immutable cache on
// an unversioned URL: the next edit would never reach a returning visitor.
const ASSET_CACHE = "public, max-age=31536000, immutable";

function handleAsset(pathname) {
  const isCss = pathname === "/s.css";
  return new Response(isCss ? STYLE_CSS : CLIENT_JS, {
    headers: {
      "content-type": isCss
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// --------------------------------------------------------------------------
// Abuse controls (Step 6).
// --------------------------------------------------------------------------

// Workers-native rate limiting, keyed on the client IP. CF-Connecting-IP is
// set by the edge and cannot be spoofed by the client — unlike X-Forwarded-For,
// which is client-supplied and must never be trusted for this.
//
// Fails OPEN: if the binding is missing or throws, the request proceeds. A
// rate limiter that takes the whole app down when it misbehaves is a worse
// outcome than one that briefly stops limiting — and this is a personal file
// drop, not a bank.
// KNOWN UNRESOLVED as of 2026-08-02, recorded here so nobody re-derives it:
// these limits DO NOT currently fire. Terraform sends the bindings with
// `simple = { limit, period }`, the apply reports them created, and at
// runtime `env.RL_UPLOAD` is an object whose `.limit` is a function taking a
// key — all verified live with a temporary probe route. But `limit()` returns
// `{ success: true }` indefinitely: 6 uploads against a 3/min cap and 65 reads
// against a 60/min cap all passed, as did 5 consecutive probe calls using one
// fixed key.
//
// What is CONFIRMED: the binding exists at runtime, the call shape matches
// Cloudflare's documented API, CF-Connecting-IP is present, and Terraform
// transmitted limit/period.
// What is NOT known: why the namespace does not count. Not investigated
// further because it needs an API-token query against the deployed script's
// stored binding config, and every token in this project is human-held.
//
// The code stays because it is correct against the documented API and costs
// nothing while inert — and because when the binding does start counting, it
// will simply begin working. Do NOT read this as "rate limiting is in place".
// The same pattern is used by the relay, whose limiter has never been
// verified live either; it may well be equally inert.
async function withinLimit(binding, request) {
  if (!binding) return true; // binding not deployed yet — do not break the app
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return true;
  try {
    const { success } = await binding.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

function limitedHtml() {
  return new Response(limitedPage(), { status: 429, headers: HTML_HEADERS });
}

// robots.txt is a request; X-Robots-Tag is enforcement. Both, deliberately:
// a crawler that ignores the file still sees the header, and the header alone
// is invisible to anyone auditing the site's intent.
const ROBOTS = "User-agent: *\nDisallow: /\n";

// /:slug and /:slug/d. Split out of fetch() to keep the router's cognitive
// complexity under the quality gate's ceiling — the whole read path is one
// decision ("is this a live drop?") and reads better as its own function.
//
// NOTE for anyone debugging a 404 here: every miss below, and any unmatched
// path in fetch(), returns a BYTE-IDENTICAL 404 — the same bytes for "expired",
// "never existed", and "R2 object missing", deliberately (B.7 item 5). The cost
// of that design is that a route which is simply not deployed yet is
// indistinguishable from broken storage. That exact confusion cost a full
// debugging cycle on this project; see the commit "docs: correct the record on
// the phantom download bug".
const SLUG_ROUTE = /^\/([^/]+)(\/d)?$/;

async function handleSlugRoute(match, env, request, ctx) {
  const slug = match[1];
  const wantsDownload = Boolean(match[2]);

  // Read limit covers view pages, downloads, AND 404 probing — the last is the
  // reason it exists, since it is what bounds slug guessing.
  if (!(await withinLimit(env.RL_READ, request))) return limitedHtml();

  // Validate shape BEFORE any lookup — a malformed slug never reaches D1.
  if (!isValidSlug(slug)) return notFound();

  const row = await getLiveDrop(env, slug);
  if (!row) return notFound();

  return wantsDownload ? handleDownload(env, row, ctx) : handleView(row, slug);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method !== "GET") {
      // The only non-GET route in the app.
      if (pathname === "/api/upload" && method === "POST") {
        // JSON, not the themed HTML page: this is an API endpoint and its
        // caller is the uploader script, which renders its own in-theme
        // message from the status code.
        if (!(await withinLimit(env.RL_UPLOAD, request))) {
          return json({ error: "too many uploads; wait a minute" }, 429);
        }
        return handleUpload(request, env);
      }
      return notFound();
    }

    if (pathname === "/healthz") {
      // Never rate limited: an uptime check that trips the limiter reports an
      // outage that is not happening.
      return new Response("ok", { status: 200, headers: { "x-robots-tag": ROBOTS_TAG } });
    }

    if (pathname === "/robots.txt") {
      return new Response(ROBOTS, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-robots-tag": ROBOTS_TAG,
          "cache-control": "public, max-age=86400",
        },
      });
    }

    // The themed "closed for the day" page, linked from the uploader when the
    // API returns 503 and reachable directly.
    if (pathname === "/closed") {
      return new Response(closedPage(), { status: 503, headers: HTML_HEADERS });
    }

    // "/" — the upload page (Step 5). Until now this fell through to the 404.
    if (pathname === "/") {
      return new Response(uploadPage(), { status: 200, headers: HTML_HEADERS });
    }

    if (pathname === "/s.css" || pathname === "/s.js") {
      return handleAsset(pathname);
    }

    const match = SLUG_ROUTE.exec(pathname);
    if (match) {
      return handleSlugRoute(match, env, request, ctx);
    }

    return notFound();
  },
};
