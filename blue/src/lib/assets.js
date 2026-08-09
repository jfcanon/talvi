// Real assets (Step 5). Served at /s.css, /s.js and /s.png. The cache is
// immutable and year-long — safe ONLY because layout.js requests these as
// /s.css?v=<hash>, so the URL changes whenever the bytes do. Never ship an
// immutable cache on an unversioned URL: the next edit would never reach a
// returning visitor.
import { STYLE_CSS, CLIENT_JS, SPRITE_PNG_B64 } from "../generated/assets.js";
import { ROBOTS_TAG } from "./html.js";

export const ASSET_CACHE = "public, max-age=31536000, immutable";

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

export function handleSprite() {
  return new Response(getSprite(), {
    headers: {
      "content-type": "image/png",
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

export function handleAsset(pathname) {
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
