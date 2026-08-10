// PIN gate primitives (PR3). Server side of D7/D8.
//
// The server NEVER sees the PIN. It sees only `H_gate` — an HKDF-Expand output
// derived in the browser from the PIN (D6) — and only once, when the channel's
// first joiner creates the gate. Every later joiner proves knowledge of the
// same H_gate by answering a fresh random nonce with
// HMAC-SHA256(H_gate, nonce), so the raw value never crosses the wire again
// and a passive observer cannot replay a captured proof (D7).
//
// Nothing in this file logs. H_gate, nonces, and proofs are never printed,
// never attached to an error, never counted per-value — see channel.js.

// H_gate and the HMAC proof are both SHA-256 sized: 32 bytes, 64 hex chars.
const GATE_HEX_LEN = 64;
const HEX_RE = /^[0-9a-f]+$/;

// D8: gate guessing is bounded inside the object, because the platform
// ratelimit bindings are inert here (RUNBOOK §8).
export const GATE_MAX_FAILS = 5;
export const GATE_LOCKOUT_MS = 60_000;

// Uniform close code for every gate refusal (D8). One code, one generic
// reason, whether the PIN was wrong, the frame was malformed, or the channel
// is locked out — a caller learns only "not admitted", never why.
export const CLOSE_GATE = 4003;
export const CLOSE_GATE_REASON = "not admitted";

export const NONCE_BYTES = 32;

export function randomNonce() {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

export function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Accepts only the exact shape a gate value may take: 64 lowercase hex chars.
// Anything else is refused before it reaches a comparison, so a malformed
// frame cannot become a timing signal (D7: length-check first).
export function isGateHex(s) {
  return typeof s === "string" && s.length === GATE_HEX_LEN && HEX_RE.test(s);
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// HMAC-SHA256(key, data) as lowercase hex. Key is H_gate, data is the nonce.
export async function hmacHex(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return toHex(new Uint8Array(sig));
}

// Constant-time comparison of two equal-length hex strings (D7, review LOW).
// Compares every character regardless of where the first difference falls, so
// the duration of a wrong answer does not reveal how much of it was right.
// Callers pass values already accepted by isGateHex, so lengths match; the
// length check stays anyway because a bare `return false` on mismatched
// lengths is the one early exit that is safe (it leaks only the length, which
// is fixed and public).
export function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
