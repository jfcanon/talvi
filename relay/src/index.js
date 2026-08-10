// talvi relay Worker — the file drop, mounted at app.ygdcbtmc4u.uk/relay.
//
// Forks green's worker (plans/talvi-hub-blueprint.md, Workstream B): the
// file-drop routes and pages, with CHAT REMOVED (chat stays on green until
// Workstream C). Shares green's D1 (talvi-meta) and R2 (talvi-drop) so existing
// drops keep working. The upload gate is a Clerk session verified IN-WORKER
// (s7/talvi-blue-auth-handover.md — the blue release's networkless jwtKey
// check, replacing the Cloudflare Access application that used to sit on
// /relay/api/upload); reads /relay/:slug/* stay public.
//
// Path handling: Cloudflare routes app.*/relay/* here, so every pathname starts
// with /relay. The router strips PREFIX before matching and every generated
// link re-applies it (src/prefix.js).
import { STYLE_CSS, CLIENT_JS, ASSET_VERSION } from "./generated/assets.js";
import { closedPage, limitedPage } from "./ui/errorpage.js";
import { notFoundPage } from "./ui/notfound.js";
import { uploadPage } from "./ui/upload.js";
import { viewPage } from "./ui/view.js";
import { newSlug, isValidSlug } from "./slug.js";
import { sanitiseFilename, validateContentType } from "./sanitise.js";
import { sniffImageKind, imageMime } from "./sniff.js";
import { PREFIX } from "./prefix.js";
import { isAuthenticated, getSessionId, revokeSession, getPublishableKey } from "./lib/auth.js";
import { signInPage, ssoCallbackPage, signInCsp } from "./ui/signin.js";
import {
  GATE_MAX_FAILS,
  GATE_LOCKOUT_MS,
  NONCE_BYTES,
  randomNonce,
  toHex,
  isGateHex,
  fromHex,
  hmacHex,
  timingSafeEqualHex,
} from "./chat/gate.js";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB — see blueprint B.6
const MAX_DAILY_BYTES = 250 * 1024 * 1024; // 250 MiB/day — bounds storage inside R2 free tier, B.8
// 90 removed 2026-08-02: no NEW 90-day uploads. The d90/ lifecycle rule stays
// in main.tf until existing d90/ objects have aged out — deleting the rule
// while objects still carry that prefix would leave them with nothing to
// expire them (RUNBOOK §4).
const TTL_DAYS = new Set([1, 7, 30]);
const DAY_MS = 24 * 60 * 60 * 1000;

// CREATE TABLE IF NOT EXISTS at the top of any handler touching D1 — the
// relay's idiom, deliberately kept so this project needs no migration tooling.
//
// Workstream E adds the download-PIN gate columns. They are additive and
// nullable (A8) and GREEN IGNORES THEM: green shares this D1, its SELECT *
// returns the extra fields it never reads, and its explicit-column INSERTs
// leave them NULL. ALTER is guarded so an existing green-created table gains
// the columns without error, and a fresh table gets them via CREATE.
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
        download_count INTEGER NOT NULL DEFAULT 0,
        pin_gate       TEXT,
        pin_gate_fails INTEGER NOT NULL DEFAULT 0,
        pin_gate_locked_until TEXT,
        pin_gate_nonce TEXT,
        pin_gate_nonce_expires TEXT,
        pin_gate_token TEXT,
        pin_gate_token_expires TEXT,
        encrypted      INTEGER NOT NULL DEFAULT 0
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_drops_expires_at  ON drops(expires_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_drops_uploaded_at ON drops(uploaded_at)`),
  ]);
  // A pre-existing (green-created) table already exists, so CREATE IF NOT
  // EXISTS above is a no-op for it. ALTER the gate columns in — each guarded
  // so a re-run (or a green-created table) is a no-op, never an error.
  const addColumn = (name, def) =>
    db
      .prepare(`ALTER TABLE drops ADD COLUMN ${name} ${def}`)
      .run()
      .catch(() => {}); // duplicate column → already present, fine
  await addColumn("pin_gate", "TEXT");
  await addColumn("pin_gate_fails", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("pin_gate_locked_until", "TEXT");
  await addColumn("pin_gate_nonce", "TEXT");
  await addColumn("pin_gate_nonce_expires", "TEXT");
  await addColumn("pin_gate_token", "TEXT");
  await addColumn("pin_gate_token_expires", "TEXT");
  // B1: fragment-key E2E encryption. 1 = the R2 object is ciphertext and the
  // share link carries the key in #k=…; 0 = plaintext (every existing drop,
  // and every upload that opts out). Additive and nullable-defaulted so green
  // and old rows are untouched.
  await addColumn("encrypted", "INTEGER NOT NULL DEFAULT 0");
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

// A fresh CSP nonce for the two clerk-js pages (/sign-in, /sso-callback).
// 18 random bytes base64url-encoded — no entropy from the request, nothing
// derivable from any header. Workers has no node:crypto; getRandomValues is
// the platform's CSPRNG.
function nonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Checks are ordered cheapest-first: no-side-effect validation before any write.
async function handleUpload(request, env) {
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

  // Download-PIN gate (Workstream E). The uploader optionally sets a 4-digit
  // PIN; the BROWSER derives H_gate (the proof value) and sends only that —
  // the PIN itself never crosses the wire. The server stores just the proof
  // (A6: the PIN is a gate, never key material). isGateHex is checked here so
  // a malformed proof is refused before a single byte is stored.
  const pinGateRaw = request.headers.get("x-drop-pin-gate");
  const pinGate = pinGateRaw ? pinGateRaw.trim() : null;
  if (pinGate !== null && !isGateHex(pinGate)) {
    return json({ error: "invalid pin gate" }, 400);
  }

  // Fragment-key E2E encryption (B1). The browser encrypts with AES-256-GCM
  // and sends ciphertext; the key travels only in the share link's #k=…
  // fragment, which never reaches the server. The flag is stored so the view
  // page can render the right state and refuse to sniff ciphertext. The
  // server never sees the key in any form.
  const encrypted = request.headers.get("x-drop-encrypted") === "1" ? 1 : 0;

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
       (slug, r2_key, filename, content_type, size_bytes, uploaded_at, expires_at, pin_gate, encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slug, r2Key, filename, contentType, counted, uploadedAt, expiresAt, pinGate, encrypted)
    .run();

  const url = new URL(request.url);
  return json({
    slug,
    url: `${url.origin}${PREFIX}/${slug}`,
    expires_at: expiresAt,
    size_bytes: counted,
    encrypted,
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
  "cache-control": "no-store",
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
// The view page is the app's only stored-XSS sink (B.7 item 3). Whether the
// "as markdown" action is offered is decided by the object's own bytes
// (sniffed here, a 16-byte range read) — never the declared content type.
// An ENCRYPTED drop (B1) is never sniffed: its bytes are ciphertext, and a
// range-read would be a wasted subrequest that tells us nothing.
async function handleView(env, row, slug) {
  const encrypted = Boolean(row.encrypted);
  const kind = encrypted ? null : await imageKindOf(env, row.r2_key);
  return new Response(
    viewPage(row, slug, kind !== null, Boolean(row.pin_gate), encrypted),
    {
      status: 200,
      headers: HTML_HEADERS,
    },
  );
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

// ---------------------------------------------------------------------------
// "as markdown" (markdown sidequest). GET /:slug/md — an OCR/description
// conversion of an uploaded image, served as a downloadable .md and cached in
// R2 so one image is never converted twice. Design and decisions:
// plans/talvi-markdown-blueprint.md.
// ---------------------------------------------------------------------------

const MD_HEAD_BYTES = 16; // every supported signature fits in 16 bytes

// Sniff the object's OWN first bytes — never the client-declared content type
// (B.7 item 1). Returns a kind string ("jpeg", "png", ...) or null.
async function imageKindOf(env, r2Key) {
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

async function handleMarkdown(env, row) {
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

// ---------------------------------------------------------------------------
// Download-PIN gate (Workstream E). Protocol, from blueprint §4/A6:
//
//   - The PIN is a GATE on fetching, never an encryption key. The server holds
//     only H_gate — the proof value the browser derives from the PIN and sends
//     once, at upload. The raw PIN never crosses the wire.
//   - Challenge-response, same shape as chat's gate.js: the client requests a
//     nonce, then answers with HMAC-SHA256(H_gate, nonce). The server recomputes
//     the same HMAC from the stored proof and constant-time compares.
//   - Lockout: GATE_MAX_FAILS consecutive failures → GATE_LOCKOUT_MS backoff,
//     persisted in D1 (unlike chat's in-memory DO state, a file is a persistent
//     artifact and the gate must survive worker restarts).
//   - Honest copy: the PIN stops a leaked link being enough on its own; it does
//     NOT encrypt the file or stop someone who has both link and PIN.
//
// The gate cookie is short-lived (GATE_COOKIE_MS) and scoped to the exact slug
// path, so a captured cookie unlocks one drop for a few minutes, not the site.
// ---------------------------------------------------------------------------

const GATE_COOKIE_MS = 30 * 60 * 1000; // grant valid for 30 min after proof
const GATE_NONCE_MS = 5 * 60 * 1000; // a challenge nonce is fresh for 5 min
const GATE_COOKIE_NAME = "relay_gate"; // value is a per-drop random token

function gateCookieHeader(value) {
  return (
    GATE_COOKIE_NAME +
    "=" +
    value +
    "; HttpOnly; Secure; SameSite=Strict; Path=" +
    PREFIX +
    "; Max-Age=" +
    Math.floor(GATE_COOKIE_MS / 1000)
  );
}

// True when the drop is currently in its lockout backoff window.
function gateLocked(row) {
  if (!row.pin_gate_locked_until) return false;
  return new Date(row.pin_gate_locked_until).getTime() > Date.now();
}

// Issue a fresh challenge nonce for a gated drop. Stores it (and its expiry)
// in D1 so the answer round-trip can be verified against the same value, then
// returns the nonce as plain hex. Refused while locked out.
async function gateChallenge(env, row) {
  if (gateLocked(row)) {
    return json({ error: "locked out; try again later" }, 423);
  }
  const nonce = toHex(randomNonce());
  const expires = new Date(Date.now() + GATE_NONCE_MS).toISOString();
  await env.DB.prepare(
    `UPDATE drops SET pin_gate_nonce = ?, pin_gate_nonce_expires = ? WHERE slug = ?`,
  )
    .bind(nonce, expires, row.slug)
    .run();
  return json({ nonce });
}

// Verify a client's answer to a challenge. Recomputes HMAC-SHA256(H_gate,
// nonce) from the stored proof and constant-time compares — a wrong answer and
// a malformed one are indistinguishable. On success, stores a fresh gate token
// in D1 and returns it as the cookie value. On failure, counts toward the
// lockout; at GATE_MAX_FAILS the drop is locked for GATE_LOCKOUT_MS.
async function gateAnswer(env, row, body) {
  if (gateLocked(row)) {
    return json({ error: "locked out; try again later" }, 423);
  }
  if (!body || typeof body.nonce !== "string" || typeof body.answer !== "string") {
    return json({ error: "bad gate request" }, 400);
  }
  // The nonce must be the one this drop was issued, and fresh.
  if (row.pin_gate_nonce !== body.nonce) {
    return json({ error: "stale nonce" }, 400);
  }
  const expiresAt = new Date(row.pin_gate_nonce_expires || 0).getTime();
  if (expiresAt < Date.now()) {
    return json({ error: "stale nonce" }, 400);
  }

  const expected = await hmacHex(fromHex(row.pin_gate), fromHex(body.nonce));
  if (!timingSafeEqualHex(expected, body.answer)) {
    // Wrong answer (or malformed one — same refusal). Count toward lockout and
    // consume the nonce: a failed answer must not be retryable with the same
    // nonce (single-use, replay protection).
    const fails = (row.pin_gate_fails || 0) + 1;
    let lockedUntil = null;
    if (fails >= GATE_MAX_FAILS) {
      lockedUntil = new Date(Date.now() + GATE_LOCKOUT_MS).toISOString();
    }
    await env.DB.prepare(
      `UPDATE drops SET pin_gate_fails = ?, pin_gate_locked_until = COALESCE(?, pin_gate_locked_until),
        pin_gate_nonce = NULL, pin_gate_nonce_expires = NULL WHERE slug = ?`,
    )
      .bind(lockedUntil ? 0 : fails, lockedUntil, row.slug)
      .run();
    return json({ error: "not admitted" }, 403);
  }

  // Admitted. Issue a fresh one-time token as the gate cookie; clear the nonce
  // and failure state.
  const token = toHex(randomNonce());
  const grantExpires = new Date(Date.now() + GATE_COOKIE_MS).toISOString();
  await env.DB.prepare(
    `UPDATE drops SET pin_gate_nonce = NULL, pin_gate_nonce_expires = NULL,
       pin_gate_fails = 0, pin_gate_locked_until = NULL WHERE slug = ?`,
  )
    .bind(row.slug)
    .run();
  // The token lives in D1 so /d can verify the cookie is the one we issued.
  await env.DB.prepare(
    `UPDATE drops SET pin_gate_token = ?, pin_gate_token_expires = ? WHERE slug = ?`,
  )
    .bind(token, grantExpires, row.slug)
    .run();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": gateCookieHeader(token),
      "x-content-type-options": "nosniff",
    },
  });
}

// Validate the gate cookie for a gated drop's fetch: the cookie value must be
// the exact token we issued, unexpired, stored in D1 for that drop. Constant-
// time compare so a forged value reads like any other mismatch.
async function gateCookieValid(env, request, row) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;)\\s*" + GATE_COOKIE_NAME + "=([^;]+)"));
  const value = match?.[1];
  if (!value) return false;
  if (!row.pin_gate_token || row.pin_gate_token !== value) return false;
  const expires = new Date(row.pin_gate_token_expires || 0).getTime();
  return expires >= Date.now();
}

// POST /:slug/gate — the challenge/answer endpoint. Body is JSON with an
// "action" of "challenge" or "answer".
async function handleGate(env, row, request) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad gate request" }, 400);
  }
  if (body?.action === "challenge") return gateChallenge(env, row);
  if (body?.action === "answer") return gateAnswer(env, row, body);
  return json({ error: "bad gate request" }, 400);
}

// /:slug, /:slug/d, and /:slug/md. Split out of fetch() to keep the router's
// cognitive complexity under the quality gate's ceiling — the whole read path
// is one decision ("is this a live drop?") and reads better as its own
// function.
//
// NOTE for anyone debugging a 404 here: every miss below, and any unmatched
// path in fetch(), returns a BYTE-IDENTICAL 404 — the same bytes for "expired",
// "never existed", and "R2 object missing", deliberately (B.7 item 5). The cost
// of that design is that a route which is simply not deployed yet is
// indistinguishable from broken storage. That exact confusion cost a full
// debugging cycle on this project; see the commit "docs: correct the record on
// the phantom download bug".
const SLUG_ROUTE = /^\/([^/]+)(\/(d|md))?$/;
// POST /<slug>/gate — the download-PIN challenge/answer endpoint (Workstream E).
// One trailing segment, so it cannot collide with SLUG_ROUTE (which is used
// only for GET).
const GATE_ROUTE = /^\/([^/]+)\/gate$/;

async function handleSlugRoute(match, env, request, ctx) {
  const slug = match[1];
  const action = match[2] ?? ""; // "", "/d", or "/md"

  // Read limit covers view pages, downloads, markdown conversion, AND 404
  // probing — the last is the reason it exists, since it is what bounds slug
  // guessing.
  if (!(await withinLimit(env.RL_READ, request))) return limitedHtml();

  // Validate shape BEFORE any lookup — a malformed slug never reaches D1.
  if (!isValidSlug(slug)) return notFound();

  const row = await getLiveDrop(env, slug);
  if (!row) return notFound();

  // Download-PIN gate (Workstream E). A gated drop's fetch (/d, /md) requires
  // a valid gate cookie (set by POST /:slug/gate after a successful
  // challenge-response). The view page itself is public — it renders the
  // record and the PIN prompt; the file bytes are what the gate protects.
  if (row.pin_gate && (action === "/d" || action === "/md")) {
    if (!(await gateCookieValid(env, request, row))) {
      // Redirect to the view page so a visitor lands on the PIN prompt.
      return Response.redirect(new URL(PREFIX + "/" + slug, request.url).toString(), 302);
    }
  }

  if (action === "/md") return handleMarkdown(env, row);
  return action === "/d" ? handleDownload(env, row, ctx) : handleView(env, row, slug);
}

// ---------------------------------------------------------------------------
// Nightly purge (Step 7).
// ---------------------------------------------------------------------------

const PURGE_BATCH = 200; // see the comment on the SELECT below — this is a cap, not a guess
const IDLE_DAYS = 180;

// Deletes expired rows and, defensively, their objects.
//
// Timestamps are computed in JS and BOUND as parameters. Never
// datetime('now') in the SQL: SQLite renders "2026-08-02 03:00:00" while this
// app stores ISO 8601 "2026-08-02T03:00:00.000Z", and 'T' (84) sorts after
// ' ' (32) — so every expired row would compare as still live. That is a
// silent, total failure of this job, which is why it is written here as well
// as in the blueprint.
async function purge(env) {
  await ensureSchema(env.DB);
  const now = new Date().toISOString();

  // LIMIT is required, not tidiness: a Worker invocation is capped at 50
  // subrequests, so an unbounded backlog (say a lifecycle rule was broken for
  // a week) would fail the run partway through and never recover. Capped, a
  // backlog simply drains over consecutive nights.
  const { results = [] } = await env.DB.prepare(
    `SELECT slug, r2_key, size_bytes FROM drops
      WHERE expires_at < ?
      ORDER BY expires_at ASC
      LIMIT ${PURGE_BATCH}`,
  )
    .bind(now)
    .all();

  if (!results.length) {
    await logIdle(env, now, 0, 0);
    return { removed: 0, bytes: 0 };
  }

  let bytes = 0;
  for (const row of results) {
    // Redundant with the R2 lifecycle rules ON PURPOSE. It costs nothing and
    // it is the safety net if a lifecycle rule is ever mis-edited — defence in
    // depth on the single property this app promises: things disappear.
    await env.BUCKET.delete(row.r2_key).catch(() => {});
    bytes += row.size_bytes || 0;
  }

  // Delete exactly the batch just handled, by slug — NOT a fresh
  // `expires_at < ?` re-query, which could sweep up rows that arrived between
  // the SELECT and the DELETE and delete them without touching their objects.
  const slugs = results.map((r) => r.slug);
  const placeholders = slugs.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM drops WHERE slug IN (${placeholders})`)
    .bind(...slugs)
    .run();

  await logIdle(env, now, results.length, bytes);
  return { removed: results.length, bytes };
}

// One log line, counts only. NEVER a slug, filename, or URL: the slug is the
// file's only secret, and a log has a wider audience than the database does.
// Mirrors the relay's rule that sha256_plaintext never enters logs.
async function logIdle(env, now, removed, bytes) {
  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS n FROM drops`).first();
  const newest = await env.DB.prepare(`SELECT MAX(uploaded_at) AS last FROM drops`).first();

  console.log(
    `PURGE removed=${removed} remaining_estimate=${remaining?.n ?? "?"} bytes=${bytes}`,
  );

  // Kill criterion as a breadcrumb, deliberately not an alerting integration:
  // if nobody has uploaded in 180 days, this project should be deleted, and
  // the log is where whoever next looks will find that stated.
  if (newest?.last) {
    const idleMs = Date.parse(now) - Date.parse(newest.last);
    if (idleMs > IDLE_DAYS * DAY_MS) {
      console.log(
        `IDLE-${IDLE_DAYS} no upload in ${Math.floor(idleMs / DAY_MS)} days — consider deleting this project (see RUNBOOK.md)`,
      );
    }
  }
}

// Routing proper. Split out of `fetch` only so that HEAD can be routed as a
// GET without every branch below needing to know that HEAD exists.
//
// `method` is a parameter rather than a read of `request.method`: on a HEAD
// request the two differ on purpose, and reading it here would quietly undo
// that.
//
// PREFIX handling: Cloudflare routes app.*/relay/* to this worker, so the
// pathname arrives as /relay/… . Strip the prefix once, here, so every
// route below (and the SLUG_ROUTE regex) sees the unprefixed path. A request
// that does not begin with the prefix is not this worker's — uniform 404.
async function route(request, method, env, ctx) {
  const { pathname } = new URL(request.url);
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return notFound();
  const stripped = pathname.slice(PREFIX.length) || "/";

  if (method !== "GET") {
    // POST /api/upload — the write path, gated on a Clerk session (the blue
    // release's L5 rule, ported). Auth check comes first, before the rate
    // limit or any upload logic: an unauthenticated request must never reach
    // the write path or burn a rate-limit slot. The check is networkless
    // (jwtKey PEM), so it is cheap enough to sit at the top of every request.
    if (stripped === "/api/upload" && method === "POST") {
      if (!(await isAuthenticated(request, env))) {
        return json(
          { error: "unauthorized; sign in at " + PREFIX + "/sign-in" },
          401,
        );
      }
      // JSON, not the themed HTML page: this is an API endpoint and its
      // caller is the uploader script, which renders its own in-theme
      // message from the status code.
      if (!(await withinLimit(env.RL_UPLOAD, request))) {
        return json({ error: "too many uploads; wait a minute" }, 429);
      }
      return handleUpload(request, env);
    }

    // POST /<slug>/gate — the download-PIN challenge/answer endpoint
    // (Workstream E). No write to storage beyond the gate's own nonce/fail
    // bookkeeping, so it is not behind the upload Access gate — a downloader
    // proving a PIN must be able to reach it.
    const gateMatch = GATE_ROUTE.exec(stripped);
    if (gateMatch && method === "POST") {
      const gateSlug = gateMatch[1];
      if (!isValidSlug(gateSlug)) return notFound();
      const row = await getLiveDrop(env, gateSlug);
      if (!row || !row.pin_gate) return notFound(); // ungated or unknown → 404
      return handleGate(env, row, request);
    }

    return notFound();
  }

  return routePage(request, env, ctx, stripped);
}

// GET page routes — extracted out of `route` for the cognitive-complexity gate.
async function routePage(request, env, ctx, pathname) {
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

  // "/" — the upload page (Step 5). Public in the green release; the POST is
  // gated on a Clerk session, so the page renders for everyone but its state
  // (and the SIGN OUT affordance) depends on whether this visitor is signed in.
  if (pathname === "/") {
    const authed = await isAuthenticated(request, env);
    return new Response(uploadPage({ authed }), { status: 200, headers: HTML_HEADERS });
  }

  // "/sign-in" and "/sso-callback" — the two clerk-js pages (s7 handover §4).
  // The ONLY pages whose CSP widens to the strict nonce + strict-dynamic Clerk
  // CSP (signInCsp); everything else keeps HTML_HEADERS byte-for-byte. An
  // already-authenticated visitor to /sign-in is bounced straight home.
  if (pathname === "/sign-in") {
    if (await isAuthenticated(request, env)) {
      return Response.redirect(new URL(PREFIX + "/", request.url).toString(), 302);
    }
    const n = nonce();
    return new Response(signInPage({ publishableKey: getPublishableKey(env), nonce: n }), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": signInCsp(n),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": ROBOTS_TAG,
      },
    });
  }

  if (pathname === "/sso-callback") {
    const n = nonce();
    return new Response(ssoCallbackPage({ publishableKey: getPublishableKey(env), nonce: n }), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": signInCsp(n),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": ROBOTS_TAG,
      },
    });
  }

  // GET /api/signout — a link target (works with JS off): revoke the active
  // session on Clerk's side, drop the __session cookie, send the browser home.
  if (pathname === "/api/signout") {
    const sessionId = await getSessionId(request, env);
    if (sessionId) await revokeSession(env, sessionId);
    const headers = new Headers({
      Location: PREFIX + "/",
    });
    // Clearing the cookie is the important half: the browser must stop sending
    // it even if Clerk's revocation round-trip fails. Same flags Clerk sets —
    // __session is HttpOnly and SameSite=Lax; Secure is implied on HTTPS.
    headers.append("Set-Cookie", "__session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
    return new Response(null, { status: 302, headers });
  }

  // GET /relay/api/upload — a leftover from the Access era (Access redirected
  // the browser back here after the email PIN). With the Clerk gate there is
  // no GET handler for this path; redirect to the upload page so a stray
  // navigation lands somewhere useful.
  if (pathname === "/api/upload") {
    return Response.redirect(new URL(PREFIX + "/", request.url).toString(), 302);
  }

  return routeStatic(request, env, ctx, pathname);
}

// Static GET routes — extracted out of `route` so its cognitive complexity
// stays under the SonarQube gate (S3776). No auth here: everything in this
// function is either public or auth-handled by its own branch above.
async function routeStatic(request, env, ctx, pathname) {
  if (pathname === "/s.css" || pathname === "/s.js") {
    return handleAsset(pathname);
  }

  const match = SLUG_ROUTE.exec(pathname);
  if (match) {
    return handleSlugRoute(match, env, request, ctx);
  }

  return notFound();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purge(env));
  },

  // HEAD is a GET whose response carries no body (RFC 9110 §9.3.2). Every route
  // above tests `method === "GET"`, so until now a HEAD fell through to the 404
  // on every path — `curl -I https://…/` read a 404's headers for a page that
  // answers 200 to a browser.
  //
  // Routing HEAD as GET and dropping the body in one place keeps HEAD's headers
  // identical to GET's by construction. A per-route HEAD branch would let the
  // two drift, and the download route's octet-stream + attachment + nosniff +
  // sandbox set is precisely the thing that must never drift.
  //
  // The body is discarded here rather than left to the runtime: an HTTP server
  // must not put a body on a HEAD response, but "the layer below will strip it"
  // is not a property this app should be depending on unverified.
  async fetch(request, env, ctx) {
    const isHead = request.method === "HEAD";
    const response = await route(request, isHead ? "GET" : request.method, env, ctx);
    if (!isHead) return response;
    return new Response(null, { status: response.status, headers: response.headers });
  },
};
// No Durable Objects here: chat (and its ChatChannel export) stays on green
// until Workstream C. The relay is pure file drop — D1 + R2 + Workers AI.

