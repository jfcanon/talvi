# talvi learn — runbook

Operational guide for the Tribunal Learn worker at `/learn`. Written for someone who has never seen this codebase. If a procedure here needs knowledge that is not on this page, that is a bug in this page.

**Live URL:** `https://app.ygdcbtmc4u.uk/learn/`

The worker is the `learn/` tree in github.com/jfcanon/talvi. It teaches the Living Tribunal machinery (independence, grounding, recorded dissent) as a Duolingo-style path. Sign-in lives on the hub at the app root; learn never serves a login page.

---

## Auth

Learn verifies the host-wide Clerk `__session` cookie in-worker. It does not call the Clerk API per request.

- Implementation: `learn/src/lib/auth.js`.
- `createClerkClient` is constructed with `jwtKey: env.CLERK_JWT_KEY` (Clerk's PEM public key). Passing `jwtKey` makes `authenticateRequest` **networkless** — the JWT is verified in the V8 isolate, no JWKS fetch.
- All three bindings are required (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY`). Missing keys fail closed: `getUserId` returns null and the request is treated as signed-out.
- Authorized parties are full origins: `https://app.ygdcbtmc4u.uk`, `https://talvi.ygdcbtmc4u.uk`, `https://accounts.ygdcbtmc4u.uk`. Session tokens carry the instance `home_url` or the auth domain in `azp`, not the app host the visitor landed on.
- Unauthenticated pages (`GET /learn/`, `/learn/lesson/…`, `/learn/gate/…`) 302 to `/sign-in?redirect=<pathname>`. Unauthenticated `POST` and `/learn/api/*` return 401 JSON.
- Public (no cookie): `/learn/healthz`, `/learn/s.css`, `/learn/s.js`, `/learn/favicon.ico`.

### Whole-host Cloudflare Access

`app.*` is wrapped by Cloudflare Access. Access is the outer door; Clerk is the inner session. A request that reaches the worker has already passed Access (or is on an allowlisted path). Do not treat Access as a substitute for the Clerk gate, and do not remove the Clerk gate because Access exists.

### `PUBLIC_MODE` stays `false`

Leoncito has a `PUBLIC_MODE` binding that skips Clerk for recruiter demos. **Learn has no such binding and must not gain one set to `true`.** The course and the XP ledger are single-owner and Clerk-gated. A public-mode bypass would skip the in-worker gate, leak curriculum + player state, and contradict deny-by-default. If a `PUBLIC_MODE` switch is ever added for symmetry with leoncito, it stays `"false"`.

---

## Deploy

Terraform **never** runs locally. Not "just this once". Not to "fix the state".

1. Open a PR against `main`. CI (`.github/workflows/terraform-learn.yml`) runs `cd learn && npm ci && npm test`, then `terraform init` + `terraform plan`.
2. Merge to `main`. The same workflow runs `terraform apply -auto-approve`.
3. The apply uploads `learn/dist/index.js` (esbuild output) as the `talvi-learn` Worker.

State:

- Backend: R2 bucket `talvi-tfstate` (S3-compatible).
- **Key:** `talvi/learn/terraform.tfstate`
- Isolated from every sibling key (`talvi/terraform.tfstate`, `talvi/hub/…`, `talvi/relay/…`, `talvi/chat/…`, `talvi/3d/…`).

Routes (already in `learn/main.tf`; `/learn/*` covers `/learn/favicon.ico` — no extra route resource):

- `app.ygdcbtmc4u.uk/learn` (exact — the hub blade links here with no trailing slash)
- `app.ygdcbtmc4u.uk/learn/*`

The hub owns `app.ygdcbtmc4u.uk/*`. More-specific learn patterns win.

---

## D1 `talvi-learn-meta`

Database name: `talvi-learn-meta`. Binding: `DB`. Created by `cloudflare_d1_database.talvi_learn_meta` in `learn/main.tf`. Separate from `talvi-meta` and `talvi-blue-meta`.

Schema lives in `learn/src/lib/store.js` (`ensureSchema`). `CREATE TABLE IF NOT EXISTS` at the top of any handler that touches D1 — no migration tooling. ISO timestamps are always `new Date().toISOString()` in JS, never SQL `datetime()`.

```
xp_events        id INTEGER PK AUTOINCREMENT, ts, lesson_id, skill, xp
                 UNIQUE(lesson_id) — one event per lesson (single-owner MVP)
lesson_progress  (user_id, lesson_id) PK, state, best_score, attempts, last_completed_at
player_state     user_id PK, xp, streak_days, last_day, hearts, level, updated_at
```

`xp_events` is the append-only source of truth. `lesson_progress` and `player_state` are **derived**. `player_state.xp` is a cache of `SUM(xp_events.xp)`, never a second store of truth. The ledger is app-wide (no `user_id` on `xp_events`); derived tables are per-user for forward-compat.

### Rebuild derived tables from `xp_events`

`store.syncDerived(db, userId, { lessons, player }, hearts)` materialises the reduced ledger into `lesson_progress` + `player_state`. `store.readState` already does this on every authenticated page/API read:

1. `ensureSchema`
2. `SELECT … FROM xp_events ORDER BY ts`
3. `reduceLedger(events)` → `{ lessons, player }`
4. preserve stored `hearts`
5. `syncDerived(...)`

To force a rebuild after a bad cache row: delete the derived rows for that user (keep `xp_events`) and hit any authenticated learn page or `GET /learn/api/state`. The next `readState` rewrites the derived tables. Do not hand-edit `player_state.xp`.

Award policy: 10 XP per completed lesson (`XP_PER_LESSON`). The client never sends an XP amount. Double-POST is a no-op (app check + unique index on `xp_events(lesson_id)`).

---

## Content

Curriculum is code, not database rows. JSON files in `learn/curriculum/` (`u1.json` … `u5.json`). A content change is a PR.

`node scripts/content-lint.mjs` (wired into `npm run build` / `npm test`) enforces:

1. Every fact, every exercise, and every unit checkpoint has a non-empty `cite`.
2. Cite format: `<file>:<section>` — non-empty section after the last colon.
3. `<file>` must start with `secondbrain/docs/HUB-BLUEPRINT.md` or `sidequests/`.
4. Forbidden un-gated strings (`7-FTE`, `cinto`) may appear only in documents/lessons with `gated: true`.

The lint checks shape and gating. The author still verifies each cite string against the secondbrain/sidequests corpus.

---

## Verify

Unauthenticated live checks (no Clerk session):

```bash
cd learn
node scripts/verify-learn.mjs https://app.ygdcbtmc4u.uk
```

The script exits non-zero on any failure and prints a table. It asserts:

- `/learn/healthz` → 200
- `/learn/` → 302 to `/sign-in?redirect=%2Flearn%2F`
- `/learn/api/state` → 401
- `/learn/s.css` and `/learn/s.js` → 200, `immutable` cache-control, correct content-type
- every learn response carries `content-security-policy` starting `default-src 'none'`
- `/learn/favicon.ico` is not 404
- sibling apps from the sibling `main.tf` route blocks stay non-5xx (`/relay`, `/chat`, `/leoncito`, hub `/`, `3d.ygdcbtmc4u.uk/`)

Local suite before any PR:

```bash
cd learn && npm ci && npm test
```

### Manual XP round-trip

The verify script cannot mint a Clerk session. After deploy, do this once as the owner:

1. Sign in at `https://app.ygdcbtmc4u.uk/sign-in?redirect=%2Flearn%2F`.
2. Open `/learn/` — path graph renders, CSP is `default-src 'none'…`.
3. Complete the frontier lesson. `POST /learn/api/complete` with `{ "lesson_id": "<id>", "skill": "<skill>" }` should return `{ ok: true, gained: 10, alreadyCompleted: false, player: { xp: … } }`.
4. Reload `/learn/` — that node is mastered, the next node is the frontier, HUD XP went up by 10.
5. Repeat the same `complete` POST — `gained: 0`, `alreadyCompleted: true`, XP unchanged.

---

## Takedown / rollback

To take learn off the host without destroying data:

1. PR that removes (or comments out) the two `cloudflare_workers_route` resources in `learn/main.tf` (`learn` and `learn_root`).
2. Merge — CI apply drops the routes. The hub `/*` fallback then owns `/learn`.
3. **Keep** `cloudflare_d1_database.talvi_learn_meta`. The ledger stays. Restoring the two route resources puts the app back on the same D1.

To roll back a bad worker: revert the merge commit on `main`; CI apply uploads the previous `dist/index.js`. Do not `terraform apply` from a laptop.

A blade-icon rollback is owner-side on the hub (see below) — revert the hub change; do not edit the hub 3D world from this tree.

---

## Limits

- **Single owner.** `xp_events` has no `user_id`. The unique index is per `lesson_id`, not per user. This is a one-player MVP. Do not open the gate to a second Clerk user without changing the ledger.
- **Hearts are optional-off** (locked decision 6). `store.syncDerived` passes `hearts` through untouched; they are not derived from the ledger. `HEARTS_ENABLED` in `src/index.js` controls whether the server renders the hearts pill. Do not treat hearts as required product surface.
- **Unit 5 is gated.** `learn/curriculum/u5.json` has `"gated": true`. The worker 404s gated lessons/gates (`unitGated`). Nothing in Unit 5 ships until a factcheck sitting against the real cinto repo verifies the underlying claims. Do not un-gate it in a drive-by.

CSP is `default-src 'none'` from day one. No inline script, no inline style, no `eval`. CSS/JS are files at `/learn/s.css` and `/learn/s.js`, versioned `?v=<hash>`, immutable.

---

## Blade icon (TODO, owner)

The hub 3D world is owner-coordinated. This runbook does not change it.

Link the LEARN blade to exactly:

`https://app.ygdcbtmc4u.uk/learn`

No trailing slash. `learn/main.tf` registers the exact `/learn` route so that URL hits this worker instead of the hub `/*` fallback.
