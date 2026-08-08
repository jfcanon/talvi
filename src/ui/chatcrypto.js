// Chat key derivation — the browser half of the PIN gate (PR3). WebCrypto
// only: no library, no WASM, nothing that needs 'unsafe-eval'. The CSP
// (`script-src 'self'`) is not weakened by a single byte of this file, and any
// dependency that would require weakening it is by definition the wrong
// dependency.
//
// D6, one PBKDF2 then an HKDF split — NOT two PBKDF2 calls:
//
//   K_master = PBKDF2(PIN, "talvi/v1/pbkdf2/"+name, 300000, SHA-256, 256)
//   H_gate   = HKDF(K_master, info="talvi/v1/gate/"+name)   → proves join
//   K_enc    = HKDF(K_master, info="talvi/v1/enc/"+name)    → PR4, never sent
//
// Halving the KDF work buys the higher iteration count at the same join
// latency, and the info-string domain separation means the value the server
// learns (H_gate) yields nothing about the value it must never learn (K_enc).
//
// The channel name is the PBKDF2 salt. It is not secret — a salt does not need
// to be — but it is unique per channel (D9 slugs), which is exactly the job:
// one rainbow table cannot serve two channels.
//
// This file is CONCATENATED into /s.js, not bundled, so it cannot `export`.
// It publishes one frozen global instead — the single deliberate seam between
// concat files (chat.js calls into it).

(function () {
  "use strict";

  const PBKDF2_ITERS = 300000; // D6, OWASP-current for PBKDF2-SHA256
  const DERIVED_BITS = 256;
  const enc = new TextEncoder();

  // D16. Two members must derive byte-identical keys, so both ends normalize
  // the same way before a single hash runs. Trim kills the trailing space a
  // copy-paste adds; NFC collapses the two Unicode spellings of an accented
  // character that look identical on screen and hash differently.
  function normalizePin(pin) {
    return String(pin).trim().normalize("NFC");
  }

  function toHex(bytes) {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  async function deriveMasterHex(pin, name) {
    const base = await crypto.subtle.importKey(
      "raw",
      enc.encode(normalizePin(pin)),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode("talvi/v1/pbkdf2/" + name),
        iterations: PBKDF2_ITERS,
        hash: "SHA-256",
      },
      base,
      DERIVED_BITS,
    );
    return toHex(new Uint8Array(bits));
  }

  // WebCrypto exposes HKDF as extract-then-expand, with no expand-only mode.
  // An empty salt makes extract deterministic, which is what D6's
  // "HKDF-Expand(K_master, info)" needs: K_master is already a uniformly
  // random 256-bit PBKDF2 output, so the extract step has no entropy left to
  // add and serves only as a fixed, domain-separated relabelling.
  async function hkdfHex(masterHex, info) {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(masterHex),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: enc.encode(info),
      },
      key,
      DERIVED_BITS,
    );
    return toHex(new Uint8Array(bits));
  }

  function gateHex(masterHex, name) {
    return hkdfHex(masterHex, "talvi/v1/gate/" + name);
  }

  // ------------------------------------------------------------ AES-256-GCM

  // K_enc is H_gate's sibling: same K_master, different HKDF info string. The
  // server is handed H_gate and can verify joins with it; it is never sent
  // K_enc and cannot derive it from what it holds, which is the whole basis of
  // the claim that it relays ciphertext it cannot read.
  async function encKey(masterHex, name) {
    const raw = fromHex(await hkdfHex(masterHex, "talvi/v1/enc/" + name));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  const IV_BYTES = 12; // GCM standard; 96 bits is the size AES-GCM is built for

  function b64urlEncode(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s) {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Envelope: { v:1, iv:base64url(12B), ct:base64url(ciphertext ‖ 16B tag) }.
  //
  // A FRESH random IV per message, from getRandomValues — never a counter,
  // never derived from the key, never from the clock. Reusing an IV under one
  // AES-GCM key is the catastrophic failure mode for this cipher: it leaks the
  // XOR of the two plaintexts and can expose the authentication subkey. 96
  // random bits per message is the standard way to make that collision
  // negligible without any shared state between members, which matters here
  // because members have no shared state to coordinate a counter with.
  async function seal(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(plaintext),
    );
    return { v: 1, iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ct)) };
  }

  // Returns the plaintext, or null if this envelope is not for us.
  //
  // null is the ONLY failure signal, and every failure produces it: wrong
  // shape, wrong version, wrong IV length, and — the common one — a GCM tag
  // that does not verify because the sender used a different PIN. That last
  // case is not an error to report, it is someone who cannot talk to us, and
  // the caller drops it silently. Never throw: a room where one undecryptable
  // frame breaks the client is a room anyone can break.
  async function unseal(key, env) {
    if (!env || env.v !== 1 || typeof env.iv !== "string" || typeof env.ct !== "string") {
      return null;
    }
    try {
      const iv = b64urlDecode(env.iv);
      if (iv.length !== IV_BYTES) return null;
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        b64urlDecode(env.ct),
      );
      return new TextDecoder().decode(pt);
    } catch {
      return null; // bad base64, bad tag, wrong key — all the same to us
    }
  }

  // The answer to a server challenge (D7): HMAC-SHA256(H_gate, nonce). The
  // gate value itself crosses the wire only once, when the channel is created.
  async function answerHex(gate, nonceHex) {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(gate),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, fromHex(nonceHex));
    return toHex(new Uint8Array(sig));
  }

  // ------------------------------------------------------------ PIN floor

  // D5, and the review's one CRITICAL: the confidentiality claim is worth
  // exactly the entropy of the PIN, and nothing server-side can check it —
  // the server sees a 256-bit HKDF output whether the PIN was "hunter2" or
  // forty random characters. So the floor is enforced HERE, at creation, and
  // creation is refused outright when it fails.
  const PIN_MIN_LEN = 8;
  const PIN_MIN_CLASSES = 3;

  // Not a dictionary — a dictionary cannot ship under this CSP budget and
  // would be theatre next to the length+class floor. These are the handful
  // that survive the floor while still being the first thing anyone tries.
  const PIN_BLOCKLIST = new Set([
    "password", "password1", "password!", "passw0rd", "p@ssword", "p@ssw0rd",
    "12345678", "123456789", "1234567890", "qwertyui", "qwerty123",
    "iloveyou", "trustno1", "letmein1", "welcome1", "admin123", "changeme",
  ]);

  function isSequential(s) {
    if (s.length < PIN_MIN_LEN) return false;
    let ascending = true;
    let identical = true;
    for (let i = 1; i < s.length; i += 1) {
      if (s.charCodeAt(i) !== s.charCodeAt(i - 1) + 1) ascending = false;
      if (s.charCodeAt(i) !== s.charCodeAt(i - 1)) identical = false;
    }
    return ascending || identical;
  }

  // Returns null when the PIN passes, or the reason it does not.
  function pinProblem(pin) {
    const p = normalizePin(pin);
    if (p.length < PIN_MIN_LEN) {
      return "PIN — at least " + PIN_MIN_LEN + " characters.";
    }
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
      re.test(p),
    ).length;
    if (classes < PIN_MIN_CLASSES) {
      return "PIN — mix at least three of: lowercase, uppercase, digits, symbols.";
    }
    if (PIN_BLOCKLIST.has(p.toLowerCase()) || isSequential(p)) {
      return "PIN — too guessable. This one is on every list.";
    }
    return null;
  }

  // ---------------------------------------------------------- slug (D9)

  // Channel names are secrets shared out-of-band, and "first joiner sets the
  // gate" means a GUESSABLE name can be squatted before its owner arrives.
  // So created channels get 100 bits, not a word.
  //
  // The alphabet is exactly 32 characters, so `byte % 32` is drawn uniformly
  // from a 256-value byte — no modulo bias, no rejection loop. l/1 and o/0 are
  // omitted: these names get read aloud and copied by hand.
  const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
  const SLUG_CHARS = 20; // 20 × log2(32) = 100 bits
  const SLUG_GROUP = 5;

  function randomSlug() {
    const bytes = crypto.getRandomValues(new Uint8Array(SLUG_CHARS));
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      if (i > 0 && i % SLUG_GROUP === 0) out += "-";
      out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
    }
    return out;
  }

  window.talviGate = Object.freeze({
    normalizePin,
    deriveMasterHex,
    gateHex,
    answerHex,
    encKey,
    seal,
    unseal,
    pinProblem,
    randomSlug,
  });
})();
