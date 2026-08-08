// Gate unit tests (PR3). Run: node scripts/chat-gate-test.mjs
//
// The point of this file is the handshake agreement test: the browser derives
// H_gate and answers a nonce, the Durable Object recomputes the same HMAC and
// compares. If those two ever disagree, NOBODY can join a PIN channel — and
// the only place that shows up otherwise is a live deploy, after Terraform has
// already applied. Both halves use the same WebCrypto API, so node can run
// them side by side and settle it here instead.
//
// src/ui/chatcrypto.js is a browser IIFE that publishes window.talviGate, so
// it cannot be imported. It is executed in a vm sandbox with a fake window —
// test-harness only, and the reason this file never ships to the browser.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import {
  GATE_LOCKOUT_MS,
  GATE_MAX_FAILS,
  fromHex,
  hmacHex,
  isGateHex,
  randomNonce,
  timingSafeEqualHex,
  toHex,
} from "../src/chat/gate.js";
import { isValidNick } from "../src/chat/name.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
  }
}

// Load the browser module under a fake window.
// The browser globals chatcrypto.js legitimately uses. The sandbox is not a
// browser, so they have to be handed in explicitly; btoa/atob/TextDecoder
// are all natively present wherever this file actually ships.
const sandbox = { window: {}, crypto, TextEncoder, TextDecoder, btoa, atob, console };
createContext(sandbox);
runInContext(await readFile(join(root, "src/ui/chatcrypto.js"), "utf8"), sandbox);
const client = sandbox.window.talviGate;

check("chatcrypto publishes window.talviGate", !!client);
check("talviGate is frozen", Object.isFrozen(client));

// ---------------------------------------------------------------- handshake

const NAME = "test-channel-abc";
const PIN = "Correct-Horse-9!";

const master = await client.deriveMasterHex(PIN, NAME);
const gateHex = await client.gateHex(master, NAME);

check("K_master is 32 bytes of hex", /^[0-9a-f]{64}$/.test(master));
check("H_gate is 32 bytes of hex", /^[0-9a-f]{64}$/.test(gateHex));
check("H_gate !== K_master (domain separation)", gateHex !== master);

// Derivation must be deterministic — two members type the same PIN and must
// land on the same key, or they simply cannot talk.
check(
  "derivation is deterministic",
  (await client.deriveMasterHex(PIN, NAME)) === master,
);
// ...and must NOT be shared across channels: the name is the PBKDF2 salt.
check(
  "same PIN, different channel → different key",
  (await client.deriveMasterHex(PIN, "test-channel-xyz")) !== master,
);

// THE test. Client answers a server nonce; server recomputes and compares.
const nonce = randomNonce();
const answer = await client.answerHex(gateHex, toHex(nonce));
const expected = await hmacHex(fromHex(gateHex), nonce);
check("client answer matches server expectation", answer === expected);
check("answer is well-formed for the server's parser", isGateHex(answer));

// A wrong PIN must not produce a passing answer.
const wrongMaster = await client.deriveMasterHex("Wrong-Horse-9!", NAME);
const wrongAnswer = await client.answerHex(
  await client.gateHex(wrongMaster, NAME),
  toHex(nonce),
);
check("wrong PIN → wrong answer", wrongAnswer !== expected);

// A replayed answer is bound to its nonce (D7 — this is what kills the static
// bearer replay the review flagged).
const nonce2 = randomNonce();
const expected2 = await hmacHex(fromHex(gateHex), nonce2);
check("answer is nonce-bound (no replay)", expected2 !== expected);

// ------------------------------------------------------------- gate parsing

check("isGateHex accepts 64 lowercase hex", isGateHex("a".repeat(64)));
check("isGateHex rejects short", !isGateHex("a".repeat(63)));
check("isGateHex rejects long", !isGateHex("a".repeat(65)));
check("isGateHex rejects uppercase", !isGateHex("A".repeat(64)));
check("isGateHex rejects non-hex", !isGateHex("z".repeat(64)));
check("isGateHex rejects undefined", !isGateHex(undefined));
check("isGateHex rejects non-string", !isGateHex(12345));

check("hex round-trips", toHex(fromHex(expected)) === expected);

// -------------------------------------------------------- constant-time cmp

check("equal strings compare equal", timingSafeEqualHex(expected, expected));
check("differing last char compares unequal",
  !timingSafeEqualHex("a".repeat(64), "a".repeat(63) + "b"));
check("differing first char compares unequal",
  !timingSafeEqualHex("a".repeat(64), "b" + "a".repeat(63)));
check("different lengths compare unequal",
  !timingSafeEqualHex("a".repeat(64), "a".repeat(63)));
check("non-strings compare unequal", !timingSafeEqualHex(null, null));

// ------------------------------------------------------------- PIN floor D5

check("rejects short PIN", !!client.pinProblem("Ab3!"));
check("rejects two-class PIN", !!client.pinProblem("abcdefghij"));
check("rejects lower+digit only", !!client.pinProblem("abcdefg123"));
check("rejects blocklisted", !!client.pinProblem("password1"));
check("rejects blocklisted regardless of case", !!client.pinProblem("Password1"));
check("rejects ascending sequence", !!client.pinProblem("abcdefgh"));
check("rejects repeated char", !!client.pinProblem("aaaaaaaa"));
check("accepts a strong PIN", client.pinProblem("Correct-Horse-9!") === null);
check("accepts exactly 8 chars, 3 classes", client.pinProblem("Ab3!efgh") === null);

// D16 — normalization, or two members derive different keys from the "same"
// PIN. NFD and NFC spellings of é look identical and hash differently.
check("PIN is trimmed", client.normalizePin("  Ab3!efgh  ") === "Ab3!efgh");
check(
  "PIN is NFC-normalized",
  client.normalizePin("é") === "é",
);
check(
  "NFD and NFC PINs derive the same key",
  (await client.deriveMasterHex("Café-Ab3!", NAME)) ===
    (await client.deriveMasterHex("Café-Ab3!", NAME)),
);

// ---------------------------------------------------------- AES-GCM (PR4)

const key = await client.encKey(master, NAME);
const otherKey = await client.encKey(
  await client.deriveMasterHex("Different-Horse-9!", NAME),
  NAME,
);

const env = await client.seal(key, "hello room");
check("envelope is v1", env.v === 1);
check("envelope iv is 12 bytes b64url", env.iv.length === 16 && !/[+/=]/.test(env.iv));
check("envelope ct is b64url", !/[+/=]/.test(env.ct));
check("round-trips", (await client.unseal(key, env)) === "hello room");

// The catastrophic AES-GCM failure is IV reuse under one key. Two seals of the
// SAME plaintext must differ in both IV and ciphertext.
const env2 = await client.seal(key, "hello room");
check("IV is fresh per message", env.iv !== env2.iv);
check("same plaintext seals differently", env.ct !== env2.ct);
const ivs = new Set();
for (let i = 0; i < 200; i += 1) ivs.add((await client.seal(key, "x")).iv);
check("200 seals produce 200 distinct IVs", ivs.size === 200);

// A wrong PIN yields a key that cannot open the envelope — and unseal must
// say so by returning null, never by throwing.
check("wrong key cannot decrypt", (await client.unseal(otherKey, env)) === null);

// Tampering must fail the GCM tag, not silently return altered text.
const flipped = { ...env, ct: (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1) };
check("tampered ciphertext is rejected", (await client.unseal(key, flipped)) === null);
const wrongIv = { ...env, iv: (env.iv[0] === "A" ? "B" : "A") + env.iv.slice(1) };
check("wrong IV is rejected", (await client.unseal(key, wrongIv)) === null);

// Malformed envelopes are dropped, never thrown on — anyone who knows the
// channel name can send these.
check("rejects wrong version", (await client.unseal(key, { ...env, v: 2 })) === null);
check("rejects missing iv", (await client.unseal(key, { v: 1, ct: env.ct })) === null);
check("rejects short iv", (await client.unseal(key, { ...env, iv: "AAAA" })) === null);
check("rejects non-base64 ct", (await client.unseal(key, { ...env, ct: "!!!!" })) === null);
check("rejects null", (await client.unseal(key, null)) === null);
check("rejects non-object", (await client.unseal(key, "nope")) === null);

// K_enc and H_gate are siblings — the server is handed one and must not be
// able to arrive at the other.
const rawEnc = await client.encKey(master, NAME);
check("K_enc is a non-extractable CryptoKey", rawEnc instanceof CryptoKey && rawEnc.extractable === false);

check("unicode survives the round trip",
  (await client.unseal(key, await client.seal(key, "héllo — 🧊 ok"))) === "héllo — 🧊 ok");

// ------------------------------------------------------------- slugs D9

const CHANNEL_RE = /^[a-z0-9-]{1,64}$/;
const slugs = new Set();
let slugShapeOk = true;
for (let i = 0; i < 500; i += 1) {
  const s = client.randomSlug();
  if (!CHANNEL_RE.test(s)) slugShapeOk = false;
  slugs.add(s);
}
check("slugs match the server's channel regex", slugShapeOk);
check("slugs are unique across 500 draws", slugs.size === 500);
check("slug is a valid nick-free channel name", CHANNEL_RE.test(client.randomSlug()));

// The alphabet must divide 256 exactly or `byte % len` is biased.
const ALPHABET_LEN = 32;
check("slug alphabet length divides 256 (no modulo bias)", 256 % ALPHABET_LEN === 0);

// ------------------------------------------------------------- misc bounds

check("nick validator rejects whitespace", !isValidNick("two words"));
check("nick validator rejects control chars", !isValidNick("bad\u0000nick"));
check("nick validator rejects empty", !isValidNick(""));
check("nick validator rejects >32", !isValidNick("n".repeat(33)));
check("nick validator accepts a normal nick", isValidNick("jf"));

check("lockout constants match D8", GATE_MAX_FAILS === 5 && GATE_LOCKOUT_MS === 60000);

// -----------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
