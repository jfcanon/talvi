// talvi Worker.
// Step 2 stood up an inert skeleton; Step 3 added the write path (no UI — it
// was driven entirely by curl, so the security logic was tested against a
// hostile client rather than a friendly form). Step 4 added the read paths.
// Step 5 adds the UI: "/" now serves an upload page instead of falling through
// to the 404, and /s.css and /s.js serve real content.
// Step 8 adds Clerk auth: "/" and "/api/upload" gate on email, /:slug/* stay public.
import { STYLE_CSS, CLIENT_JS, SPRITE_PNG_B64, ASSET_VERSION } from "./generated/assets.js";
import { closedPage, limitedPage } from "./ui/errorpage.js";
import { notFoundPage } from "./ui/notfound.js";
import { uploadPage } from "./ui/upload.js";
import { viewPage } from "./ui/view.js";
import { chatLandingPage, chatRoomPage } from "./ui/chatpage.js";
import { newSlug, isValidSlug } from "./slug.js";
import { isValidChannelName } from "./chat/name.js";
import { sanitiseFilename, validateContentType } from "./sanitise.js";
import { sniffImageKind, imageMime } from "./sniff.js";
import { createClerkClient } from "@clerk/backend";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB — see blueprint B.6
const MAX_DAILY_BYTES = 250 * 1024 * 1024; // 250 MiB/day — bounds storage inside R2 free tier, B.8
// 90 removed 2026-08-02: no NEW 90-day uploads. The d90/ lifecycle rule stays
// in main.tf until existing d90/ objects have aged out — deleting the rule
// while objects still carry that prefix would leave them with nothing to
// expire them (RUNBOOK §4).
const TTL_DAYS = new Set([1, 7, 30]);
const DAY_MS = 24 * 60 * 60 * 1000;

// Clerk auth (Step 8). Production instance — portal lives at
// accounts.ygdcbtmc4u.uk, same-zone as the app, so the redirect back to talvi
// is same-origin and Clerk accepts it (no /default-redirect dead end). __session
// cookie verified via jwtKey when present (local, networkless); otherwise
// Clerk's SDK fetches the key from the API and caches it — auth works either way.
function getClerkClient(env) {
  const opts = {
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  };
  if (env.CLERK_JWT_KEY) opts.jwtKey = env.CLERK_JWT_KEY;
  return createClerkClient(opts);
}

// Shared auth check for the gated routes. Extracted out of `route` so the
// cognitive complexity stays under the SonarQube gate (S3776).
async function isAuthenticated(request, env) {
  const { isAuthenticated } = await getClerkClient(env).authenticateRequest(request, {
    authorizedParties: ["talvi.ygdcbtmc4u.uk", "talvi-web.ygdcbtmc4u.workers.dev"],
  });
  return isAuthenticated;
}

function redirectToClerkPortal(request) {
  // Custom sign-in (Option B): point at OUR OWN /sign-in page, not Clerk's
  // hosted portal. The portal cannot hand a session back to a backend-only app
  // (no clerk-js); serving sign-in ourselves keeps the whole flow same-origin
  // and CSP intact (rule 10).
  const url = new URL(request.url);
  const returnUrl = url.pathname + (url.search || "");
  const dest = new URL("/sign-in", request.url);
  dest.searchParams.set("redirect_url", returnUrl);
  return Response.redirect(dest.toString(), 302);
}

// Custom sign-in page — themed, strict CSP, no clerk-js, no inline script.
// form-action is 'none' so this is a button-driven XHR form like the upload
// page; the POST goes to /api/sign-in and the response sets the __session
// cookie then redirects.
function signInPage(env) {
  const error = env.SIGNIN_ERROR ? `<p class="msg" id="msg">${env.SIGNIN_ERROR}</p>` : '<p class="msg hidden" id="msg"></p>';
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>talvi — sign in</title>' +
      '<link rel="stylesheet" href="/s.css?v=' + ASSET_VERSION + '"></head>' +
      '<body><div class="panel">' +
      '<div class="tagline"><span class="tagline__box">session</span></div>' +
      '<p class="lede">SIGN IN to upload. Enter the owner email — a link will open a session.</p>' +
      '<label class="term" for="email"><span aria-hidden="true">&gt;</span>' +
      '<input class="term__input" type="email" id="email" name="email" autocomplete="email" placeholder="owner@example.com"></label>' +
      '<button class="btn" type="button" id="send">Send link</button>' +
      error +
      '<div class="ambient"></div></div>' +
      '<script src="/s.js?v=' + ASSET_VERSION + '"></script></body></html>',
    { status: 200, headers: HTML_HEADERS },
  );
}

// POST /api/sign-in — mint a Clerk sign-in token for the owner email and set
// it as the __session cookie on talvi's own domain. No cross-origin handoff,
// no portal, CSP untouched. Single-owner: the email must match ALLOWED_EMAIL.
async function handleSignInSubmit(request, env) {
  const form = await request.formData().catch(() => null);
  const email = (form?.get("email") || "").toString().trim().toLowerCase();
  const allowed = (env.ALLOWED_EMAIL || "").toString().trim().toLowerCase();
  if (!email || email !== allowed) {
    return new Response(JSON.stringify({ error: "email not allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // Find the user by email, then mint a sign-in token. The token IS a session
  // token: set as __session, authenticateRequest() verifies it locally.
  const clerk = getClerkClient(env);
  const users = await clerk.users.getUserList({ emailAddress: [email] });
  const user = users.data?.[0];
  if (!user) {
    return new Response(JSON.stringify({ error: "no account for that email" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const tokenResp = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: user.id, expires_in_seconds: 3600 }),
  });
  if (!tokenResp.ok) {
    return new Response(JSON.stringify({ error: "could not create session" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  const { token } = await tokenResp.json();

  // __session cookie on talvi's domain. Secure + HttpOnly + SameSite=Lax.
  // Return 200 (not 302) so XHR can read the response; the client navigates.
  const redirect = new URL(form?.get("redirect_url") || "/", request.url).pathname;
  const cookie = `__session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
  return new Response(JSON.stringify({ ok: true, redirect }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
    },
  });
}

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

// base64 -> bytes, once per isolate rather than per request.
let spriteBytes = null;

function getSprite() {
  if (spriteBytes) return spriteBytes;
  const bin = atob(SPRITE_PNG_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  spriteBytes = out;
  return spriteBytes;
}

function handleSprite() {
  return new Response(getSprite(), {
    headers: {
      "content-type": "image/png",
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

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

// Chat (sidequest). The landing page arrives in a later PR; /chat already
// shadows a drop whose slug is literally "chat" (decision D14): that drop's
// view page is shadowed, but its /chat/d download still routes via SLUG_ROUTE.
const CHAT_WS_ROUTE = /^\/chat\/([^/]+)\/ws$/;
// Room page: exactly /chat/<name>, one trailing segment. Deliberately
// distinct from CHAT_WS_ROUTE (which ends in /ws) so the two never collide.
const CHAT_ROOM_ROUTE = /^\/chat\/([^/]+)$/;

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

  if (action === "/md") return handleMarkdown(env, row);
  return action === "/d" ? handleDownload(env, row, ctx) : handleView(row, slug);
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
async function route(request, method, env, ctx) {
  const { pathname } = new URL(request.url);

  if (method !== "GET") {
    if (pathname === "/api/sign-in" && method === "POST") {
      // Custom sign-in submit — public (no auth gate; this IS the auth entry).
      return handleSignInSubmit(request, env);
    }
    // The only other non-GET route in the app.
    if (pathname === "/api/upload" && method === "POST") {
      // Step 8: gate on auth before rate limit or upload logic.
      if (!(await isAuthenticated(request, env))) {
        return json({ error: "unauthorized; sign in" }, 401);
      }
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

  return routePage(request, env, pathname);
}

// GET page routes — extracted out of `route` for the cognitive-complexity gate.
// Kept together (not merged into routeStatic) because these carry the auth
// gate for "/" and "/sign-in".
async function routePage(request, env, pathname) {
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

  // "/sign-in" — custom sign-in page. PUBLIC (this is the auth entry, not a
  // gated route). Redirects to "/" when already signed in.
  if (pathname === "/sign-in") {
    if (await isAuthenticated(request, env)) {
      return Response.redirect(new URL("/", request.url).toString(), 302);
    }
    return signInPage(env);
  }

  // "/" — the upload page (Step 5). Step 8: gated on auth.
  if (pathname === "/") {
    if (!(await isAuthenticated(request, env))) {
      return redirectToClerkPortal(request);
    }
    return new Response(uploadPage(), { status: 200, headers: HTML_HEADERS });
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

  if (pathname === "/s.png") {
    return handleSprite();
  }

  // Chat, PR1: WebSocket upgrade path only. /chat/<name>/ws -> the channel's
  // Durable Object. The object is created on first use (idFromName semantics);
  // the name is validated BEFORE routing so a malformed name never reaches it.
  const chatWs = CHAT_WS_ROUTE.exec(pathname);
  if (chatWs) {
    const name = chatWs[1];
    if (!isValidChannelName(name)) return notFound();
    const stub = env.CHAT_CHANNELS.getByName(name);
    return stub.fetch(request);
  }

  // Chat landing page (PR2). /chat shadows a slug named "chat" (D14): the
  // view page is shadowed, but its /chat/d download still routes via
  // SLUG_ROUTE below.
  if (pathname === "/chat") {
    return new Response(chatLandingPage(), { status: 200, headers: HTML_HEADERS });
  }

  // Room page /chat/<name> (PR2). Name is validated BEFORE the page renders so
  // a malformed name gets the byte-identical 404 like everything else. The
  // ws upgrade path is handled above; this regex (one trailing segment, no
  // /ws) cannot collide with it.
  //
  // EXCEPTION (D14): a channel named "d" has no room page. /chat/d is the
  // download path for a drop whose slug is literally "chat", and that
  // download must keep working — so name "d" falls through to SLUG_ROUTE
  // below. A channel named "d" is an antipattern anyway (secret, high-entropy
  // names, D9); recorded in src/chat/name.js and RUNBOOK §9. "md" gets the
  // same treatment so /chat/md reaches the markdown conversion of that same
  // drop (markdown sidequest, PR2).
  const room = CHAT_ROOM_ROUTE.exec(pathname);
  if (room && room[1] !== "d" && room[1] !== "md") {
    const name = room[1];
    if (!isValidChannelName(name)) return notFound();
    return new Response(chatRoomPage(name), { status: 200, headers: HTML_HEADERS });
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

// The ChatChannel Durable Object must be a NAMED export of the deployed module
// for the runtime to instantiate it (the CHAT_CHANNELS binding in main.tf
// references it by class name). Re-exporting here is what makes esbuild keep it
// in the bundle with its export visible.
export { ChatChannel } from "./chat/channel.js";
