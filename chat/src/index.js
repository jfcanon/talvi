// talvi chat Worker — mounted at app.ygdcbtmc4u.uk/chat.
//
// Forks green's chat (plans/talvi-hub-blueprint.md, Workstream C) as a
// dedicated plain Worker. The preservation contract (s6 handover §7) is the
// whole point of this file:
//   - the Durable Object (src/chat/channel.js), the PIN gate (gate.js) and the
//     validators (name.js) are MOVED, not rewritten — same bytes
//   - /chat/<name>/ws stays a PLAIN Worker route, handled before any framework
//     sees the request (Next.js route handlers do not do WebSocket upgrades)
//   - chat reads no session of any kind and never will
//   - the 4-digit PIN is a gate, never key material
//
// Routes (paths as Cloudflare delivers them, already under /chat):
//   /chat                 landing page
//   /chat/<name>          room page
//   /chat/<name>/ws       WebSocket → ChatChannel DO
//   /chat/s.css /s.js   assets (path-prefixed, A11)
//   /chat/healthz         uptime
//   scheduled 03:00 UTC   the nightly purge (blueprint L8: the chat worker
//                         owns it — it is a plain Worker and can hold a
//                         scheduled handler; the Next.js worker cannot).
import { STYLE_CSS, CLIENT_JS, ASSET_VERSION } from "./generated/assets.js";
import { chatLandingPage, chatRoomPage } from "./ui/chatpage.js";
import { notFoundPage } from "./ui/notfound.js";
import { isValidChannelName } from "./chat/name.js";
import { PREFIX } from "./prefix.js";

const ROBOTS_TAG = "noindex, nofollow";

// Same header set green uses, byte-for-byte. The CSP has no inline allowances
// — which is WHY css/js live at /chat/s.css and /chat/s.js instead of being
// inlined. connect-src 'self' covers the same-origin WebSocket upgrade (the
// browser connects to wss://app.ygdcbtmc4u.uk, the same origin that served
// the page); green's chat runs on exactly this set and must not differ.
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

const ASSET_CACHE = "public, max-age=31536000, immutable";

function handleAsset(pathname) {
  const isCss = pathname.endsWith("/s.css");
  return new Response(isCss ? STYLE_CSS : CLIENT_JS, {
    headers: {
      "content-type": isCss
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

function notFound() {
  return new Response(notFoundPage(), { status: 404, headers: HTML_HEADERS });
}

// /chat/<name>/ws — the WebSocket upgrade. After the /chat prefix strip the
// path is /<name>/ws. The DO is created on first use (idFromName semantics);
// the name is validated BEFORE routing so a malformed name never reaches it.
// This MUST stay a plain route, never behind Next.js.
const CHAT_WS_ROUTE = /^\/([^/]+)\/ws$/;
// /chat/<name> — the room page. After the prefix strip the path is /<name>,
// one trailing segment, so it cannot collide with the /ws route.
const CHAT_ROOM_ROUTE = /^\/([^/]+)$/;

// Nightly purge — ported unchanged from green (Step 7). The chat worker owns
// it because it is a plain Worker with a scheduled handler (blueprint L8).
// Deletes expired drop rows and, defensively, their R2 objects; the R2
// lifecycle rules are the primary expiry, this is the row-cleanup backstop.
const PURGE_BATCH = 200;
const IDLE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

async function purge(env) {
  const now = new Date().toISOString();
  const { results = [] } = await env.DB.prepare(
    `SELECT slug, r2_key, size_bytes FROM drops
      WHERE expires_at < ?
      ORDER BY expires_at ASC
      LIMIT ${PURGE_BATCH}`,
  )
    .bind(now)
    .all();

  if (!results.length) return { removed: 0, bytes: 0 };

  let bytes = 0;
  for (const row of results) {
    await env.BUCKET.delete(row.r2_key).catch(() => {});
    bytes += row.size_bytes || 0;
  }

  const slugs = results.map((r) => r.slug);
  const placeholders = slugs.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM drops WHERE slug IN (${placeholders})`)
    .bind(...slugs)
    .run();

  console.log(`PURGE removed=${results.length} bytes=${bytes}`);
  return { removed: results.length, bytes };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purge(env));
  },

  async fetch(request, env, ctx) {
    const isHead = request.method === "HEAD";
    const method = isHead ? "GET" : request.method;
    const { pathname } = new URL(request.url);

    // Only paths under /chat belong to this worker; anything else is a miss
    // (the hub's `/*` fallback or another app owns it).
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return notFound();
    const p = pathname.slice(PREFIX.length) || "/";

    if (method === "GET") {
      if (p === "/healthz") {
        return new Response("ok", { status: 200, headers: { "x-robots-tag": ROBOTS_TAG } });
      }
      if (p.endsWith("/s.css") || p.endsWith("/s.js")) return handleAsset(p);

      const ws = CHAT_WS_ROUTE.exec(p);
      if (ws) {
        const name = ws[1];
        if (!isValidChannelName(name)) return notFound();
        const stub = env.CHAT_CHANNELS.getByName(name);
        return stub.fetch(request);
      }

      if (p === "/") return new Response(chatLandingPage(), { status: 200, headers: HTML_HEADERS });

      const room = CHAT_ROOM_ROUTE.exec(p);
      if (room && room[1] !== "d" && room[1] !== "md") {
        const name = room[1];
        if (!isValidChannelName(name)) return notFound();
        return new Response(chatRoomPage(name), { status: 200, headers: HTML_HEADERS });
      }
    }

    return notFound();
  },
};

// The ChatChannel Durable Object must be a NAMED export of the deployed module
// for the runtime to instantiate it (the CHAT_CHANNELS binding in main.tf
// references it by class name). Re-exporting here is what makes esbuild keep it
// in the bundle with its export visible. Same shape as green.
export { ChatChannel } from "./chat/channel.js";
