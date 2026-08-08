# talvi — runbook

Operational guide. Written for someone who has **never seen this codebase**.
If a procedure here needs knowledge that is not on this page, that is a bug in
this page — fix it here.

**Live URL:** `https://talvi-web.ygdcbtmc4u.workers.dev`

---

## 0. Three rules that override everything below

1. **Terraform NEVER runs locally.** Open a PR → CI runs `plan`. Merge → CI runs
   `apply`. There is no `terraform apply` on a laptop in this project, ever,
   including "just this once to fix something". If infrastructure is wrong, the
   fix is a PR.
2. **Every secret comes from Bitwarden, read at use time.** Nothing is typed by
   hand, pasted from memory, or committed. `wrangler` has no credentials of its
   own here — it reads `CLOUDFLARE_API_TOKEN` from the environment, and that
   value comes out of Bitwarden immediately before use.
3. **Step 8 (auth): "/" and "/api/upload" require Clerk sign-in.** Users without
   a `__session` cookie are redirected to `amazed-cougar-41.accounts.dev/sign-in`.
   The portal handles authentication; the Worker verifies the cookie locally. All
   `/:slug/*` routes stay public (unsigned sharing unchanged).

### Getting a token into your shell

Every `wrangler` command on this page assumes you ran this first:

```bash
set -a; source .secrets.env; set +a          # gitignored: holds BW_PASSWORD
BW_SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)
export CLOUDFLARE_API_TOKEN=$(bw get password talvicftoken --session "$BW_SESSION")
```

---

## 1. Take down a specific file (abuse report, or "delete that now")

You need the **slug** — the last path segment of the shared link.
`https://talvi-web.ygdcbtmc4u.workers.dev/KcDdGOFGk-yVQTqP` → `KcDdGOFGk-yVQTqP`

```bash
# 1. Find the object key for that slug.
npx wrangler d1 execute talvi-meta --remote --command \
  "SELECT slug, r2_key, size_bytes, expires_at FROM drops WHERE slug = '<SLUG>'"

# 2. Delete the object (r2_key looks like d1/<slug>, d7/<slug>, ...).
npx wrangler r2 object delete talvi-drop/<R2_KEY>

# 3. Delete the row.
npx wrangler d1 execute talvi-meta --remote --command \
  "DELETE FROM drops WHERE slug = '<SLUG>'"

# 4. Confirm it is gone — expect 404.
curl -sS -o /dev/null -w "%{http_code}\n" https://talvi-web.ygdcbtmc4u.workers.dev/<SLUG>
```

**Order matters.** Delete the object first. If you delete the row first you have
lost the `r2_key` and the object is orphaned in the bucket until its lifecycle
rule expires it.

### Delete everything currently stored

```bash
npx wrangler d1 execute talvi-meta --remote --command \
  "SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM drops"   # see what you are about to remove

npx wrangler d1 execute talvi-meta --remote --command \
  "SELECT r2_key FROM drops"                                     # keys to delete

# delete each object, then:
npx wrangler d1 execute talvi-meta --remote --command "DELETE FROM drops"
```

Nothing is required for routine cleanup: **every upload expires on its own**,
and the nightly purge removes its row. This is only for "remove it now".

---

## 2. The nightly purge

A Cron Trigger runs `scheduled()` at **03:00 UTC daily** (`main.tf`,
`cloudflare_workers_cron_trigger.talvi_purge`). Each run:

- selects up to **200** expired rows,
- deletes each R2 object (redundant with the lifecycle rules, deliberately — it
  is the safety net if a lifecycle rule is ever mis-edited),
- deletes exactly those rows,
- logs one line: `PURGE removed=<n> remaining_estimate=<m> bytes=<total>`.

**The log line contains no slug, filename, or URL, and must never be changed to
include one.** A slug is the file's only secret and a log has a wider audience
than the database.

Watch a run:

```bash
npx wrangler tail talvi-web        # then wait for 03:00 UTC, or trigger from the dashboard
```

If a backlog ever exceeds 200 rows a night, it drains over consecutive nights.
That is intended: a Worker invocation is capped at 50 subrequests, so an
unbounded batch would fail partway and never recover.

### `IDLE-180`

If nothing has been uploaded for 180 days, the purge logs
`IDLE-180 no upload in <n> days`. That is the kill criterion: **delete the
project** (section 7). It is a breadcrumb in the logs, not an alert — nobody is
paged for a hobby file drop.

---

## 3. Change the daily budget

`MAX_DAILY_BYTES` in `src/index.js` (currently 250 MiB/day). Uploads beyond it
return `503` and the UI shows "closed for the day".

**Redo the storage arithmetic in the same PR.** The worst-case stored bytes are
`daily budget × longest retention` — at 250 MiB/day and 90 days that is ~22 GB,
which is a few cents a month over the R2 free tier. Raising the budget without
redoing that sum is how a free hobby project quietly starts costing money.

---

## 4. Change or add a retention tier

> **`TTL_DAYS` in `src/index.js` and the R2 lifecycle prefixes in `main.tf` are
> two halves of ONE contract. Changing one without the other silently creates
> objects that never expire.**

A file uploaded with TTL *n* is stored under key `d<n>/<slug>`, and the *only*
thing that deletes that object is a lifecycle rule matching prefix `d<n>/`. Add
`14` to `TTL_DAYS` without adding a `d14/` lifecycle rule and every 14-day
upload lives forever, invisibly, and is billed forever.

Both halves, same PR:

1. `src/index.js` — add the value to `TTL_DAYS`.
2. `main.tf` — add the matching lifecycle rule.
3. `src/ui/upload.js` — add the button, so the option is reachable.

### `max_age` is in SECONDS

Confirmed twice, the hard way:

| Tier | Days | `max_age` |
|---|---|---|
| `d1/` | 1 | `86400` |
| `d7/` | 7 | `604800` |
| `d30/` | 30 | `2592000` |
| `d90/` | 90 | `7776000` |

### Declaration order is LEXICAL

The Cloudflare provider reads lifecycle rules back sorted **lexically** by
prefix — `d1`, `d30`, `d7`, `d90` — not numerically. `main.tf` declares them in
that order deliberately. Declaring them numerically makes every `plan` show a
permanent "1 to change" that is not a real change.

---

## 5. Rotate the Cloudflare API token

**Rolling the account API token also regenerates its R2 S3 access keys.** All
three Bitwarden items and all three GitHub secrets must be updated together, or
Terraform loses access to its own state bucket:

1. Roll the token in the Cloudflare dashboard.
2. Update Bitwarden: the API token, the R2 access key id, the R2 secret access key.
3. Update the GitHub Actions secrets from Bitwarden — `bw get`, never typed.
4. Re-run the latest `main` Terraform workflow and confirm `apply` is green.

---

## 6. CI checks, and what to do when one is red

| Workflow | Job | Meaning |
|---|---|---|
| Guards | `identity-guard` | Every authored commit must be `jfcanon <148238747+jfcanon@users.noreply.github.com>` |
| Guards | `leak-guard` | No forbidden personal string in the diff |
| Terraform | `plan` / `apply` | Plan on PR, apply on merge to `main` |
| Security scans | `trivy` `gitleaks` `zizmor` `sonarqube` | Supply chain, secrets, workflow hardening, code quality |

**`identity-guard` failed.** Your commit was authored by the wrong identity. Set
it repo-locally and amend:

```bash
git config user.name "jfcanon"
git config user.email "148238747+jfcanon@users.noreply.github.com"
git commit --amend --reset-author --no-edit
```

Merge commits authored by `GitHub <noreply@github.com>` are tolerated — only
commits with fewer than two parents are held to the strict identity.

**`sonarqube` failed.** The job prints the failing condition with its measured
value in both the log and the step summary. Read that before theorising; it
names the metric, the threshold, and the actual number.

**`gh pr checks` exited 8.** That means PENDING, not failed.

---

## 7. Delete the entire project

In order:

1. Empty `main.tf` of resources, PR it, merge — CI's `apply` destroys the
   Worker, D1 database, R2 bucket, and lifecycle rules.
2. Delete the Terraform state bucket `talvi-tfstate` by hand (it is not managed
   by Terraform — chicken and egg).
3. Delete the GitHub repo.
4. Delete the Bitwarden items and the Cloudflare API token.

**Do not delete the branches** before step 3 if the history matters to you — they
are the record of how this was built.

---

## 8. Facts worth knowing before you change anything

- **All 404s are byte-identical** — malformed slug, never existed, expired, and
  object-missing all return the same bytes, deliberately, so an observer cannot
  tell which. Any change that makes one distinguishable is a security
  regression. The cost of this design: a route that has not deployed yet looks
  exactly like broken storage. Check the apply time before diagnosing a 404.
- **The download path never echoes the uploaded content type.** Always
  `application/octet-stream` + `attachment` + `nosniff` + `sandbox`. Uploaded
  HTML must never render on this origin. Re-test after touching that block:
  upload an `.html` and confirm it downloads rather than renders.
- **The CSP has no `'unsafe-inline'`** — which is why CSS and JS are served from
  `/s.css` and `/s.js` rather than inlined. Do not inline anything to make a
  change easier.
- **Assets are cached immutably for a year** and requested as `/s.css?v=<hash>`.
  The hash comes from the asset contents at build time, so an edit changes the
  URL. Never serve those paths immutably without the version query.
- **Rate limiting is currently INERT.** The bindings exist and the code is
  correct against Cloudflare's documented API, but `limit()` returns
  `{success: true}` indefinitely and the cause is unresolved. Do not read the
  presence of `RL_UPLOAD`/`RL_READ` as protection.

---

## 9. Chat (sidequest)

Chat lives behind `/chat` and `/chat/<name>`. See
`plans/talvi-chat-blueprint.md` for the full design and decision register; this
section is the operational record.

### How it works

- One Durable Object per channel name (`ChatChannel`, `src/chat/channel.js`).
  The Worker routes `/chat/<name>/ws` to `env.CHAT_CHANNELS.getByName(name)`.
- The object is **non-hibernatable** (D2) and writes **zero** bytes of
  `state.storage` (D3). While anyone is connected the object stays resident;
  when the last member leaves it is evicted and the channel — and its PIN gate
  (PR3) — is gone. A channel name can then be reclaimed (D4).
- PR1b (recorded): the account is on the **free plan**, which forces the DO
  namespace to be created with a `new_sqlite_classes` migration. ChatChannel
  never writes to that SQLite storage — it is the namespace backend the API
  requires, not persistence we use. The ephemeral property is unchanged.
- PR2b (recorded): **`main.tf` carries no `migrations` block, and must not.**
  Provider v5 marks `migrations` WriteOnly, so it lives in neither state nor
  plan and is re-sent on *every* apply
  (cloudflare/terraform-provider-cloudflare#5701, #5898) — and the Workers API
  is not idempotent for it. PR1b's apply only succeeded because the class had
  no live objects yet; after PR1's WebSocket verification created some, the
  PR2 apply died on `400 code 10074: "Cannot apply new-sqlite-class migration
  to class 'ChatChannel' that is already depended on by existing Durable
  Objects"`, blocking the deploy. Wrangler sends migrations only when there are
  new ones; otherwise the field must be null, and omitting the block is how
  Terraform sends null. **Declaring a new DO class is therefore a two-PR
  move:** one PR adds the `migrations` block, the next removes it. Restore a
  create-migration only if the script is ever destroyed and rebuilt.

### Bounds (D11, enforced in-DO)

| Bound | Value | Enforced | On breach |
|---|---|---|---|
| Members per channel | 64 | at join | `{t:"error", code:"full"}` + close **1013** |
| Open sockets per channel (incl. never-joining) | 128 | at upgrade | 429 before accept |
| Wire frame | 4096 B | every frame | `{t:"error", code:"toolarge"}` (msg kept dropped, socket stays up) |
| Nick | 1–32 chars, no whitespace | at join | `{t:"error", code:"badnick"}` + close **1008** |
| Channel name | lowercase `[a-z0-9-]`, ≤64 | before routing | byte-identical 404 |
| Origin on WS upgrade | talvi hosts only | at upgrade | 403 |

The platform `ratelimit` bindings (see §8) are **not** relied on for chat.

### What is NOT bounded (D12, accepted and recorded)

- Global per-IP connection / message rate (per-DO caps only).
- Total concurrent channels.
- Offline brute force of a weak PIN (mitigated client-side: entropy floor D5,
  PBKDF2 300k D6 — PIN strength is the whole confidentiality story).
- Ciphertext replay / reorder / drop (inherent to a trusted relay; GCM gives
  integrity, not anti-replay).
- Impersonation within a group: any PIN-holder posts as anyone. No moderation,
  no way to eject.

These are disclosed to the user in the chat UI (D13) and are true by design,
not a bug list.

### The PIN gate (PR3)

A channel is **open** (no PIN, plaintext relay — D10) or **gated**. The server
never sees the PIN and cannot: it is two KDF steps away.

```
K_master = PBKDF2(PIN, "talvi/v1/pbkdf2/"+name, 300000, SHA-256, 256)   browser
H_gate   = HKDF(K_master, info="talvi/v1/gate/"+name)   → the server sees this
K_enc    = HKDF(K_master, info="talvi/v1/enc/"+name)    → PR4, never sent
```

The channel name is the PBKDF2 salt: public, but unique per channel, so one
table cannot serve two channels. PIN is trimmed + NFC-normalized first (D16) or
two members derive different keys from what looks like the same PIN.

| Step | What happens |
|---|---|
| Create | First joiner sends raw `H_gate` **once** as `setgate`. Refused with `notfirst` if the channel already has members — a latecomer cannot seize an open room. |
| Join | Server sends `{t:"challenge", nonce}` (fresh 32 random bytes); client replies `{t:"join", nick, gate:HMAC-SHA256(H_gate, nonce)}`; server recomputes and compares in constant time (D7). |
| Refusal | **Always** close `4003`, reason `"not admitted"` — wrong PIN, malformed answer, and locked-out are indistinguishable (D8). |
| Lockout | 5 wrong answers → 60 s, per channel (D8). |

A join frame carrying **no** `gate` field is not a failed attempt — it is a
client whose join crossed our challenge on the wire, which is the normal case.
It gets re-challenged and costs nothing. Only a *present but wrong* answer
counts against the lockout.

**The upgrade always succeeds.** Whether a channel exists, is gated, or is
locked out is never visible at the HTTP layer — otherwise this endpoint would
be an oracle for probing which channel names are live.

**Nothing in the DO logs.** Not the gate, not a nonce, not a proof, not a nick.
That is load-bearing, not tidiness: a log has a wider audience than the object.

### Gate lockout is a known nuisance vector (D12, accepted)

Lockout is **per channel**, because per-socket is no bound at all — a guesser
just reconnects. The cost: anyone who knows the channel name can wedge it shut
for 60 s at a time by failing on purpose. Against an unguessable name (D9) that
is a nuisance available to someone already invited, not a way in.

### Origin gate nuance (PR2, recorded)

The upgrade Origin check rejects present-and-foreign origins but **allows an
absent Origin**. Browsers always send Origin on a WS upgrade, so the browser
cross-origin threat (CSWSH) is closed; curl/script clients that omit Origin are
not that threat. Channel names are unguessable secrets (D9), so a cross-site
script without the name has nothing to probe.

### Live verification

The WS path is `/chat/<name>/ws` (the landing/room pages arrive in later PRs).
`node` ≥22 is required — the client uses the native `WebSocket`.

```bash
# Bidirectional relay proof, single process (both directions must exit 0)
node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha/ws --pair

# The whole PIN gate (PR3), driven by the REAL browser derivation from
# src/ui/chatcrypto.js — create, admit the right PIN, refuse the wrong one,
# then prove the lockout by having a KNOWN-GOOD PIN refused after 5 misses.
# Use a FRESH channel name: it leaves that channel locked for 60 s.
node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/$(openssl rand -hex 8)/ws --gate-test

# Gate math offline — client and server must agree, or nobody can ever join a
# PIN channel. Run this BEFORE merging; the alternative is finding out after
# Terraform has applied.
node scripts/chat-gate-test.mjs

# Two-invocation relay test with the PR2 protocol (join/ready handshake)
node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha/ws ws/a --send "hello" --expect "pong"
node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha/ws ws/b --send "pong" --expect "hello"

# Oversize frame rejected (socket stays up)
node scripts/chat-ws-smoke.mjs wss://…/chat/alpha/ws ws/c \
  --raw "$(node -e 'process.stdout.write(JSON.stringify({t:"msg",d:"x".repeat(5000)}))')" \
  --expect-error toolarge

# Cap: 64 join, the 65th refused with full + close 1013
node scripts/chat-ws-smoke.mjs wss://…/chat/alpha/ws cap --cap-test 65
```

Filter the apply by your own HEAD sha:
`gh run list --workflow terraform.yml` → the run whose
`headSha == $(git rev-parse HEAD)` → `gh run view <id>`.
