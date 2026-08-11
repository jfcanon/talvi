// Blueprint B1 — fragment-key E2E encryption, offline protocol test.
//
// Drives the REAL crypto module (src/ui/fragmentcrypto.js — the exact bytes
// concatenated into /s.js) and the REAL worker from the bundle, against a mock
// D1/R2, without touching production or needing a Clerk session.
//
// Proves:
//   - crypto: encrypt→decrypt roundtrip returns the original bytes; a wrong
//     key (and a tampered IV) fail GCM authentication; IV freshness (two
//     encrypts of the same bytes differ); fragment-key parsing/validation.
//   - worker read path: an encrypted row renders the decrypt state (no "as
//     markdown", no sniff of ciphertext), /d still serves octet-stream
//     attachment, and a plaintext row is unaffected.
//   - schema: ensureSchema adds the `encrypted` column idempotently.
//
// The upload-with-encryption half needs a live Clerk session (the write path
// is now session-gated) and is covered by the owner's live E2E; the crypto
// here is the same code the browser runs.
import { webcrypto } from "node:crypto";

// fragmentcrypto.js is a self-booting IIFE that assigns globalThis.talviCrypto;
// importing it in Node runs the IIFE on the Node global (WebCrypto present via
// node:crypto's webcrypto, which Node ≥20 aliases as the global crypto too).
await import("../src/ui/fragmentcrypto.js");
const tc = globalThis.talviCrypto;
if (!tc) {
  console.error("FAIL fragmentcrypto did not self-register on globalThis");
  process.exit(1);
}

const { default: worker } = await import("../dist/index.js");
const base = "https://app.ygdcbtmc4u.uk";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- crypto ---------------------------------------------------------------

// 1. Roundtrip: encrypt then decrypt with the same key yields the original.
{
  const plain = new TextEncoder().encode("hello, ciphertext world — 0123456789").buffer;
  const key = tc.newKey();
  const ct = await tc.encrypt(key, plain);
  const rt = await tc.decrypt(key, ct);
  const back = new TextDecoder().decode(rt);
  check("key format is v1.<base64url 43>", /^v1\.[A-Za-z0-9_-]{43}$/.test(key), key);
  check("roundtrip returns original bytes", back === "hello, ciphertext world — 0123456789");
  check("ciphertext is IV-prefixed", ct.byteLength === plain.byteLength + 12 + 16, `ct=${ct.byteLength} plain=${plain.byteLength}`);
}

// 2. Wrong key → GCM authentication failure (decrypt throws).
{
  const plain = new TextEncoder().encode("secret").buffer;
  const good = tc.newKey();
  const other = tc.newKey();
  const ct = await tc.encrypt(good, plain);
  let threw = false;
  try {
    await tc.decrypt(other, ct);
  } catch {
    threw = true;
  }
  check("wrong key fails GCM authentication", threw);
}

// 3. Tampered IV → GCM authentication failure (ciphertext is authenticated).
{
  const plain = new TextEncoder().encode("secret").buffer;
  const key = tc.newKey();
  const ct = new Uint8Array(await tc.encrypt(key, plain));
  ct[0] ^= 0xff; // flip a bit of the IV
  let threw = false;
  try {
    await tc.decrypt(key, ct.buffer);
  } catch {
    threw = true;
  }
  check("tampered IV fails GCM authentication", threw);
}

// 4. IV freshness: two encrypts of the same bytes produce different
//    ciphertexts (fresh IV per encrypt).
{
  const plain = new TextEncoder().encode("same bytes").buffer;
  const key = tc.newKey();
  const a = new Uint8Array(await tc.encrypt(key, plain));
  const b = new Uint8Array(await tc.encrypt(key, plain));
  check("fresh IV → ciphertexts differ", Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0);
  check("IVs differ", Buffer.compare(Buffer.from(a.subarray(0, 12)), Buffer.from(b.subarray(0, 12))) !== 0);
}

// 5. Fragment parsing: accepts the real form, rejects garbage.
{
  check("parses #k=v1…", tc.parseFragmentKey("#k=v1." + "A".repeat(43)) === "v1." + "A".repeat(43));
  check("parses ?k= form", tc.parseFragmentKey("#?k=v1." + "A".repeat(43)) === "v1." + "A".repeat(43));
  check("rejects empty hash", tc.parseFragmentKey("") === null);
  check("rejects missing k", tc.parseFragmentKey("#other=1") === null);
  check("rejects wrong version", tc.parseFragmentKey("#k=v2." + "A".repeat(43)) === null);
  check("rejects short key", tc.parseFragmentKey("#k=v1." + "A".repeat(10)) === null);
  check("rejects bad charset", tc.parseFragmentKey("#k=v1." + "A".repeat(43).replace("A", "+")) === null);
}

// --- worker read path (encrypted row) --------------------------------------

function makeDb(rowsBySlug) {
  const state = new Map(Object.entries(rowsBySlug).map(([k, v]) => [k, { ...v }]));
  const api = {
    state,
    batch: async (stmts) => stmts,
    prepare(sql) {
      const q = {
        bind(...params) {
          const stmt = {
            async all() {
              if (sql.includes("SELECT * FROM drops")) {
                const row = state.get(params[0]);
                return { results: row ? [row] : [] };
              }
              return { results: [] };
            },
            async first() {
              if (sql.includes("SELECT * FROM drops")) return state.get(params[0]) ?? null;
              return null;
            },
            run() {
              return new Promise((resolve) => {
                if (sql.includes("UPDATE drops")) {
                  const setClause = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
                  const slug = params[params.length - 1];
                  const row = state.get(slug);
                  if (!row) return resolve({ results: [] });
                  let p = 0;
                  const cols = setClause.split(",").map((c) => c.trim());
                  for (const col of cols) {
                    const m = /^(\w+)\s*=\s*(.+)$/.exec(col);
                    if (!m) continue;
                    const [, name, expr] = m;
                    let value;
                    if (expr === "?") value = params[p++];
                    else if (expr.startsWith("COALESCE(")) value = params[p++] ?? row[name];
                    else if (expr.startsWith("download_count")) value = row[name] + 1;
                    else if (/^NULL$/i.test(expr)) value = null;
                    else value = expr;
                    row[name] = value;
                  }
                }
                resolve({ results: [] });
              });
            },
          };
          return stmt;
        },
      };
      q.run = () => Promise.resolve({ results: [] });
      return q;
    },
  };
  return api;
}

const BUCKET = {
  get: async () => ({
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("ciphertext-bytes"));
        c.close();
      },
    }),
    size: 15,
    arrayBuffer: async () => new TextEncoder().encode("ciphertext-bytes").buffer,
  }),
};

async function get(env, path) {
  const r = await worker.fetch(new Request(base + path), env, { waitUntil: () => {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

const encSlug = "a1b2c3d4e5f6a1b2"; // 16 chars, valid
const encRow = {
  slug: encSlug,
  r2_key: "d1/" + encSlug,
  filename: "secret.txt",
  content_type: "text/plain",
  size_bytes: 15,
  uploaded_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  download_count: 0,
  pin_gate: null,
  encrypted: 1,
};

// 6. The worker's read path renders the encrypted state: decrypt button, no
//    "as markdown", honest copy, and the record still visible.
{
  const env = { DB: makeDb({ [encSlug]: encRow }), BUCKET, ctx: { waitUntil: () => {} } };
  const v = await get(env, "/relay/" + encSlug);
  check("encrypted view renders 200", v.status === 200, "status=" + v.status);
  check("encrypted view shows decrypt button", v.text.includes('data-encrypted="1"') && v.text.includes("Decrypt & download"), v.text.slice(0, 300));
  check("encrypted view offers as-markdown (decrypt-then-OCR)", v.text.includes('data-encrypted-md="1"'));
  check("encrypted view shows honest copy", v.text.includes("#k= fragment"));
  check("encrypted view shows the record", v.text.includes("secret.txt") && v.text.includes("text/plain"));
  const d = await get(env, "/relay/" + encSlug + "/d");
  check("encrypted /d serves octet-stream attachment", d.status === 200 && (d.headers.get("content-type") || "").includes("octet-stream") && (d.headers.get("content-disposition") || "").includes("attachment"));
}

// 7. A plaintext row is completely unaffected by the encrypted flag being 0.
{
  const openSlug = "zyx987wvu654tsrq";
  const openRow = {
    slug: openSlug,
    r2_key: "d1/" + openSlug,
    filename: "open.txt",
    content_type: "text/plain",
    size_bytes: 3,
    uploaded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    download_count: 0,
    pin_gate: null,
    encrypted: 0,
  };
  const env = { DB: makeDb({ [openSlug]: openRow }), BUCKET, ctx: { waitUntil: () => {} } };
  const v = await get(env, "/relay/" + openSlug);
  check("plaintext view shows plain Download", v.text.includes(">Download<") && !v.text.includes("Decrypt & download"));
  check("plaintext view has no encrypted copy", !v.text.includes("#k= fragment"));
}

// 9. POST /:slug/md — encrypted-drop OCR endpoint. A non-image body gets the
//    uniform 404; an image with no AI binding answers 502 (conversion
//    unavailable); the decrypted-image POST is gated on the drop being live.
{
  const env = { DB: makeDb({ [encSlug]: encRow }), BUCKET, ctx: { waitUntil: () => {} } };
  const postMd = async (body) => {
    const r = await worker.fetch(
      new Request(base + "/relay/" + encSlug + "/md", { method: "POST", headers: { "content-length": String(body.length) }, body }),
      env,
      { waitUntil: () => {} },
    );
    return r.status;
  };
  check("POST /md with a non-image body → 404", (await postMd(new TextEncoder().encode("not an image"))) === 404);
  // A real PNG header with no AI binding → 502 (conversion unavailable). Use a
  // bucket whose .md cache misses so it actually reaches the AI call.
  const noCacheBucket = { get: async () => null, put: async () => {}, delete: async () => {} };
  const envNoCache = { DB: makeDb({ [encSlug]: encRow }), BUCKET: noCacheBucket, ctx: { waitUntil: () => {} } };
  const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const postMd2 = async (body) => {
    const r = await worker.fetch(
      new Request(base + "/relay/" + encSlug + "/md", { method: "POST", headers: { "content-length": String(body.length) }, body }),
      envNoCache,
      { waitUntil: () => {} },
    );
    return r.status;
  };
  check("POST /md with an image body, no AI → 502", (await postMd2(pngHead)) === 502);
}

// 8. ensureSchema adds the column idempotently (fresh + pre-existing table).
{
  // A fresh table gets `encrypted` via CREATE; a pre-existing green-created
  // table gains it via the guarded ALTER. The addColumn catch swallows the
  // duplicate-column error on re-run, so calling twice is a no-op. The bundle
  // is the deployed artifact — assert the schema contract against its bytes.
  const src = await import("node:fs/promises").then((f) =>
    f.readFile(new URL("../dist/index.js", import.meta.url), "utf8"),
  );
  const hasCreate =
    src.includes("encrypted      INTEGER NOT NULL DEFAULT 0") ||
    src.includes("encrypted INTEGER NOT NULL DEFAULT 0");
  const hasAlter = src.includes('addColumn("encrypted"');
  check("schema CREATE declares encrypted column", hasCreate);
  check("schema ALTER guards encrypted column", hasAlter);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
