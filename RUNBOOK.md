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

# 2b. If the file was ever converted "as markdown", its derived cache lives at
#     <R2_KEY>.md (same prefix, same lifecycle TTL) and must go too.
npx wrangler r2 object delete talvi-drop/<R2_KEY>.md

# 3. Delete the row.
npx wrangler d1 execute talvi-meta --remote --command \
  "DELETE FROM drops WHERE slug = '<SLUG>'"

# 4. Confirm it is gone — expect 404.
curl -sS -o /dev/null -w "%{http_code}\n" https://talvi-web.ygdcbtmc4u.workers.dev/<SLUG>
```

**Order matters.** Delete the object first. If you delete the row first you have
lost the `r2_key` and the object is orphaned in the bucket until its lifecycle
rule expires it. The `<R2_KEY>.md` cache (step 2b) is derived content of the
same file — delete it in the same breath or the takedown leaks the file's text.

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
It costs nothing. Only a *present but wrong* answer counts against the lockout.

> **One nonce per socket, and never replace it.** A gate-less join challenges
> the socket only if it has never been challenged. Issuing a fresh nonce to a
> socket that already has one outstanding overwrites `session.nonce` and
> invalidates the answer the client is at that moment computing for the first
> one — its *correct* answer then compares against the replacement, fails, and
> counts against the lockout. Every honest join to a gated channel breaks that
> way, and five of them lock the channel with no attacker involved. Caught by
> security review before deploy; regression-tested in
> `scripts/chat-channel-test.mjs` ("no second challenge is issued").

Refusals are uniform in **duration** as well as code: every path that can
refuse computes the same HMAC first, including the locked-out and malformed
paths that do not need it. Without that, a locked channel returned instantly
while a wrong answer paid for a WebCrypto sign, and timing alone separated
"locked" from "wrong" — letting a guesser pace around the backoff instead of
wasting attempts inside it.

**The upgrade always succeeds.** Whether a channel exists, is gated, or is
locked out is never visible at the HTTP layer — otherwise this endpoint would
be an oracle for probing which channel names are live.

**Nothing in the DO logs.** Not the gate, not a nonce, not a proof, not a nick.
That is load-bearing, not tidiness: a log has a wider audience than the object.

### The PIN is 4 digits — what that does and does not buy (owner decision, PR9)

D5 originally required 8+ characters across 3 character classes. **The owner
changed it to exactly 4 digits.** That is the decision; this section records
what follows from it so nobody has to re-derive it, and so nobody writes a
claim the PIN cannot support.

4 digits is 10,000 possibilities — about 13 bits.

| Attack | Bounded? | Reality |
|---|---|---|
| **Online** guessing at the gate | **Yes** | 5 wrong answers → 60 s lockout (D8). Exhausting 10,000 PINs takes on the order of a day and a half of sustained attack, against a channel whose 100-bit name you must already know. |
| **Offline** brute force of captured ciphertext | **No, and it cannot be** | `K_enc` comes from the PIN. Anyone holding ciphertext tries all 10,000 candidates locally with no gate and no lockout in the way. At 300k PBKDF2 iterations that is minutes on one core, less spread out. |

So the honest claim, and the one the UI now makes, is:

- Messages **are** encrypted in the browser; nothing readable crosses the wire
  and this app never handles readable text. That part is unchanged and true.
- A 4-digit PIN is **a lock on a door, not a safe**. Anyone who records the
  traffic can try all ten thousand combinations and read along.

**Do not restore wording implying otherwise while the PIN is 4 digits.** The
copy in `src/ui/chatpage.js` and the `ENCRYPTED —` line in `src/ui/chat.js` say
this explicitly; changing the PIN length is what should change that copy.

**Raising the PBKDF2 iteration count does not rescue this.** Ten million
iterations would cost every joining member seconds of wait and still lose the
whole keyspace in hours. The only real fix is more PIN entropy — so if this app
is ever used for something that genuinely needs secrecy, lengthen the PIN and
update the copy in the same PR.

### Encryption (PR4)

Gated channels are end-to-end encrypted; open channels are not, and both say so
in the UI. `K_enc` is `H_gate`'s sibling — same `K_master`, different HKDF info
string. The server is handed `H_gate` to verify joins and is **never** sent
`K_enc`, cannot derive it from what it holds, and so relays ciphertext it cannot
read.

Envelope, client to client: `{ v:1, iv:base64url(12B), ct:base64url(ct ‖ 16B GCM tag) }`

- **A fresh random IV per message**, from `getRandomValues` — never a counter,
  never key- or clock-derived. IV reuse under one AES-GCM key is this cipher's
  catastrophic failure: it leaks the XOR of the two plaintexts and can expose
  the authentication subkey. Members share no state to coordinate a counter
  with, so 96 random bits per message is the mechanism.
- **Decryption failure is silent.** A failed GCM tag means the sender used a
  different PIN — they are not in the conversation. Rendering "could not
  decrypt" per frame would let anyone who knows the channel name fill the room
  with error text.

**The relay enforces the payload kind, and this is the part the server can
actually guarantee.** On a gated channel only `env` is relayed and a plaintext
`d` frame is **dropped**; on an open channel only `d` is relayed and an `env` is
dropped. Without that, one stray plaintext frame — stale tab, hand-built frame,
future bug — would be passed to every member looking like a normal message, and
the room's guarantee would be quietly false for that line. The client likewise
refuses to send rather than falling back to plaintext if sealing fails.

**What encryption does NOT cover** (said plainly in the UI, D13): the hosting
edge terminates TLS and sees who talks to whom and when; any PIN-holder reads
everything and can post as anyone; there is no way to prove who wrote a line.

The room page ships **without** an encryption claim and the client fills one in
after the handshake. Whether a channel is gated is a property of the live
object, not the URL — the Worker rendering the page does not know it, and asking
would cost a round trip and make page load an oracle for which channels are
gated. A late claim beats a wrong one.

### Room behaviour (PR5)

- **Member list** is rebuilt from scratch on every connect. The server replays
  the full roster to a newcomer, so after a reconnect that replay is the truth
  and anything remembered from the previous socket is stale by definition.
- **Reconnect is a button, never a timer.** An automatic retry against a gated
  channel spends a lockout attempt every time (D8), so a room that refused you
  once would be hammered shut by its own client. After a `4003` the button says
  TRY AGAIN, and the message explains the wait.
- **A reconnect draws a rule in the transcript, and never clears it.** The room
  kept no history, so what is on screen is that tab's only copy — clearing it
  would destroy the sole record. The rule marks the seam so nobody reads across
  the gap as one continuous conversation.
- **Reduced motion is honoured.** Chat lines are removed from the animation
  entirely rather than shortened: a message list is the one place motion is
  genuinely in the way, and a 1 ms fade is still a flash.

### Gate lockout is a known nuisance vector (D12, accepted)

Lockout is **per channel**, because per-socket is no bound at all — a guesser
just reconnects. The cost: anyone who knows the channel name can wedge it shut
for 60 s at a time by failing on purpose. Against an unguessable name (D9) that
is a nuisance available to someone already invited, not a way in.

### Origin gate — same-origin, never a hostname list (PR7)

The upgrade check compares the request's `Origin` host to **the host the request
actually arrived on**. There is nothing to configure and no list to maintain: it
is correct on every hostname, including ones that do not exist yet.

> **Do not reintroduce a hostname allowlist here.** It was one, and it is a trap
> with a fuse on it. The day the site gains a host the list has not been told
> about — a public-release domain, a **blue/green staging host**, a preview URL —
> every WebSocket upgrade from that host is refused `403` and chat dies there
> for those users only. The pages still render, so it reads as a chat bug rather
> than a config one. The CSP already says `connect-src 'self'`, so same-origin
> is the rule; enforce that rule, not a snapshot of today's DNS.

Absent Origin is still **allowed** (recorded, PR2). Browsers always send Origin
on a WS upgrade, so the CSWSH threat is closed; curl and the node smoke clients
are not that threat. Channel names are unguessable secrets (D9), so a cross-site
script without the name has nothing to probe.

### Cloudflare injects a beacon on the proxied zone — do NOT fix it in the CSP

On `talvi.ygdcbtmc4u.uk` (the proxied zone, **not** workers.dev) Cloudflare
injects its Browser Insights beacon into HTML at the edge:

```
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/…'
violates the following Content Security Policy directive: "script-src 'self'".
The action has been blocked.
```

**The CSP is working. Nothing is broken and nothing is leaking** — the script
never executes. But every real visitor to that domain gets a console error, and
Cloudflare Web Analytics collects nothing, so the feature is on and inert.

It only appears for requests that look like real browser navigations
(`Sec-Fetch-Dest: document`), which is why plain `curl` sees nothing and the
browser test does. To reproduce from a shell:

```bash
curl -sS -A "Mozilla/5.0 … Chrome/131.0.0.0 Safari/537.36" \
  -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' \
  https://talvi.ygdcbtmc4u.uk/chat | grep -c cloudflareinsights   # → 1
```

> **The fix is to turn the zone feature OFF** (Cloudflare dashboard → Web
> Analytics / Speed → Browser Insights), never to add
> `static.cloudflareinsights.com` to `script-src`. The CSP has never been
> weakened in this project, and this is exactly how that streak would end —
> someone making a red line go green. A third-party analytics script injected
> into a page whose entire premise is that it ships no third-party code is not
> a CSP problem to accommodate; it is a setting to switch off.

`scripts/chat-browser-test.mjs` reports this as its own named failure, separate
from page violations, so the two are never confused.

### Chat sits BEHIND the Clerk login — confirmed intended (owner, PR9)

`/chat` is inside the Clerk-authenticated area, exactly like `/`. This is the
owner's decision and is **not** a bug to route around. Do not add `/chat` to a
public-route exemption list, and do not "fix" a sign-in redirect on a chat link
by making chat public.

What that means in practice, so nobody re-derives it wrong later:

- **Reaching a room needs two different things, and they are not substitutes.**
  Clerk answers *may you use this site*; the channel name and PIN answer *may
  you enter this room*. Site auth is not a room key, and a room PIN is not site
  auth.
- **Guest nicks stay guest nicks.** Chat does not read `__session`, does not know
  who you signed in as, and must not start showing Clerk identities next to
  messages — the room's own disclosure says anyone in it posts as anyone, and
  attaching real identities to that would make the disclosure a lie.
- **Chat does not depend on Clerk being up.** It kept working through the Clerk
  outage because it never asks Clerk anything. If chat ever starts failing when
  Clerk fails, something has coupled them and that is the regression.
- **A shared room link now survives the login.** Clerk sends an unauthenticated
  visitor to sign-in and back; they land on `/chat/<name>`, which asks for nick
  and PIN in place (PR9). Before that fix they were bounced to `/chat` and asked
  to retype the channel name — a link that survived Clerk only to die on our own
  page.

### Gate lockout is a known nuisance vector (D12, accepted)

Lockout is **per channel**, because per-socket is no bound at all — a guesser
just reconnects. The cost: anyone who knows the channel name can wedge it shut
for 60 s at a time by failing on purpose. Against an unguessable name (D9) that
is a nuisance available to someone already invited, not a way in.

### Origin gate — same-origin, never a hostname list (PR7)

The upgrade check compares the request's `Origin` host to **the host the request
actually arrived on**. There is nothing to configure and no list to maintain: it
is correct on every hostname, including ones that do not exist yet.

> **Do not reintroduce a hostname allowlist here.** It was one, and it is a trap
> with a fuse on it. The day the site gains a host the list has not been told
> about — a public-release domain, a **blue/green staging host**, a preview URL —
> every WebSocket upgrade from that host is refused `403` and chat dies there
> for those users only. The pages still render, so it reads as a chat bug rather
> than a config one. The CSP already says `connect-src 'self'`, so same-origin
> is the rule; enforce that rule, not a snapshot of today's DNS.

Absent Origin is still **allowed** (recorded, PR2). Browsers always send Origin
on a WS upgrade, so the CSWSH threat is closed; curl and the node smoke clients
are not that threat. Channel names are unguessable secrets (D9), so a cross-site
script without the name has nothing to probe.

### Cloudflare injects a beacon on the proxied zone — do NOT fix it in the CSP

On `talvi.ygdcbtmc4u.uk` (the proxied zone, **not** workers.dev) Cloudflare
injects its Browser Insights beacon into HTML at the edge:

```
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/…'
violates the following Content Security Policy directive: "script-src 'self'".
The action has been blocked.
```

**The CSP is working. Nothing is broken and nothing is leaking** — the script
never executes. But every real visitor to that domain gets a console error, and
Cloudflare Web Analytics collects nothing, so the feature is on and inert.

It only appears for requests that look like real browser navigations
(`Sec-Fetch-Dest: document`), which is why plain `curl` sees nothing and the
browser test does. To reproduce from a shell:

```bash
curl -sS -A "Mozilla/5.0 … Chrome/131.0.0.0 Safari/537.36" \
  -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' \
  https://talvi.ygdcbtmc4u.uk/chat | grep -c cloudflareinsights   # → 1
```

> **The fix is to turn the zone feature OFF** (Cloudflare dashboard → Web
> Analytics / Speed → Browser Insights), never to add
> `static.cloudflareinsights.com` to `script-src`. The CSP has never been
> weakened in this project, and this is exactly how that streak would end —
> someone making a red line go green. A third-party analytics script injected
> into a page whose entire premise is that it ships no third-party code is not
> a CSP problem to accommodate; it is a setting to switch off.

`scripts/chat-browser-test.mjs` reports this as its own named failure, separate
from page violations, so the two are never confused.

### Chat and the sign-in work (recorded, PR7)

Chat is **public and anonymous by design** — no accounts, no Clerk, guest nicks
only. Its only secrets are the channel name and (optionally) the PIN. It does
not read `__session` and does not care whether Clerk is up: chat kept working
throughout the period Clerk was broken.

If a login is ever placed in front of the **whole site**, `/chat` ends up behind
it. That may be wanted, but it is a deliberate choice and not a default — decide
it explicitly rather than discovering it. Note that gating chat behind sign-in
removes the anonymity that is the point of it, and that the PIN gate is a
different mechanism serving a different purpose (who is in this room), not a
substitute for site auth (who may use this site).

### Verifying chat on any host — including before a blue/green cutover

```bash
npm run verify:chat                                   # the live worker
npm run verify:chat -- https://green.example          # a candidate, BEFORE cutover
npm run verify:chat -- https://green.example --full   # adds the 65-socket cap test
npm run test:chat                                     # offline suites, no network
```

Exit code is the gate: `0` all passed, `1` something failed. Each case runs on a
freshly named channel and leaves nothing behind — a Durable Object is created on
first use and dies with its last member.

**Run it against the green deployment before pointing traffic at it.** Chat was
silently broken in production once already: a sign-in refactor dropped `ctx` from
scope in `routePage`, every UI route including `/chat` returned 500, and nothing
caught it because the chat checks only ran when chat code changed. The failure
had nothing to do with chat and everything to do with the building around it.

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

# The join/gate state machine, offline: drives the real ChatChannel against a
# fake WebSocket. Terraform cannot run locally here, so "push and see" costs a
# PR, a plan, an apply and a live channel — this is the cheap way to catch a
# gate bug before any of that.
node scripts/chat-channel-test.mjs

# The full journey in a REAL browser — the only check that executes
# src/ui/chat.js at all (everything else tests the protocol) and the only one
# that can prove the page raises no CSP violations. Playwright is deliberately
# NOT a dependency; install it ad hoc:
#   npm i --no-save playwright-core
#   npx playwright install chromium     # only if no browser is cached
#   node scripts/chat-browser-test.mjs
# Exits 2 with instructions if playwright-core is absent, so a missing
# dependency never reads as a failing test.
node scripts/chat-browser-test.mjs

# End-to-end encryption against the live object (PR4). Two members, one PIN,
# real browser crypto. Asserts on what the WIRE carried — the relayed bytes must
# contain no trace of the plaintext — and that the server refuses to relay a
# plaintext frame on a gated channel. Use a fresh channel name.
node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/$(openssl rand -hex 8)/ws --e2e-test

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
