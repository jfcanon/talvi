// D1 schema + reads. Ported from the green worker's src/index.js; the comment
// on JS-computed ISO timestamps is load-bearing and must not drift from green.
//
// The nightly purge is NOT here: on blue it runs in the chat worker's scheduled
// handler (blueprint L8), so purge()/logIdle() move with the chat worker in
// PR 4. A fresh blue has nothing to purge in the meantime.

// CREATE TABLE IF NOT EXISTS at the top of any handler touching D1 — the
// relay's idiom, deliberately kept so this project needs no migration tooling.
export async function ensureSchema(db) {
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

// Look up a live (non-expired) drop, or null. Slug is regex-validated BEFORE
// this is called — a malformed slug must never reach D1. Expiry compares in
// JS against the stored ISO string, never in SQL (blueprint B.4).
export async function getLiveDrop(env, slug) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT * FROM drops WHERE slug = ?`)
    .bind(slug)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}
