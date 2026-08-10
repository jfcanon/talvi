// Fragment-key E2E encryption (blueprint B1). Browser-side AES-256-GCM.
//
// The key lives ONLY in the share link's URL fragment (#k=v1.<base64url>) —
// a fragment is never sent to the server, so the ciphertext in R2 and the
// D1 row carry nothing that can decrypt them. The server stores ciphertext
// plus an `encrypted` flag; old drops and non-encrypted uploads are untouched.
//
// Exposed as globalThis.talviCrypto. This file is concatenated raw into
// /s.js (no module loader), so it must not use imports/exports — same rule as
// chatcrypto.js. client.js calls it lazily from event handlers, by which time
// the whole concatenation has run.
//
// IV freshness is the load-bearing property: a fresh 96-bit IV per encrypt
// means two encrypts of the same bytes produce unrelated ciphertexts, so a
// replay/reorder is undetectable-but-worthless — GCM authenticates the
// ciphertext, and a wrong key (or a tampered IV) fails the tag check.
(function () {
  "use strict";

  const KDF = "v1"; // key format version — bump with the KDF, never silently
  const KEY_BYTES = 32; // AES-256
  const IV_BYTES = 12; // AES-GCM recommended nonce size
  const KEY_B64 = 43; // 32 bytes → 43 base64url chars, unpadded

  function b64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function unb64url(s) {
    const b = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
    const bin = atob(b + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  async function importKey(raw) {
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  // newKey() → "v1.<base64url 32 bytes>". The string that goes in #k=.
  function newKey() {
    return KDF + "." + b64url(randomBytes(KEY_BYTES));
  }

  // encrypt(keyStr, bytes) → ArrayBuffer of [iv(12)][ciphertext+tag]. The IV
  // rides in front so the decrypting side needs nothing beyond the key.
  async function encrypt(keyStr, bytes) {
    const key = await importKey(unb64url(keyStr.split(".")[1]));
    const iv = randomBytes(IV_BYTES);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return out.buffer;
  }

  // decrypt(keyStr, ivPrefixed) → ArrayBuffer of plaintext. THROWS on a wrong
  // key or tampered ciphertext (GCM tag failure) — callers turn that into an
  // honest "wrong or missing key" state, never partial bytes.
  async function decrypt(keyStr, ivPrefixed) {
    const raw = new Uint8Array(ivPrefixed);
    const key = await importKey(unb64url(keyStr.split(".")[1]));
    const iv = raw.subarray(0, IV_BYTES);
    const ct = raw.subarray(IV_BYTES);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  }

  // parseFragmentKey(hash) → keyStr, or null. Validates the version prefix and
  // the exact base64url shape so a malformed link never reaches importKey.
  function parseFragmentKey(hash) {
    if (typeof hash !== "string" || hash.length === 0) return null;
    // Allow the dot (version separator) inside the key value; the version and
    // the base64url body are each validated below.
    const m = /[?&]?k=([A-Za-z0-9_.-]+)/.exec(hash.replace(/^#/, ""));
    if (!m) return null;
    const keyStr = m[1];
    const [v, b64] = keyStr.split(".");
    if (v !== KDF) return null;
    if (!b64 || !/^[A-Za-z0-9_-]+$/.test(b64) || b64.length !== KEY_B64) return null;
    return keyStr;
  }

  globalThis.talviCrypto = {
    newKey,
    encrypt,
    decrypt,
    parseFragmentKey,
    KEY_BYTES,
    IV_BYTES,
  };
})();
