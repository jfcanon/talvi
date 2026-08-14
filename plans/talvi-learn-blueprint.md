# talvi-learn — the Tribunal Learn blueprint

**Status:** DRAFT (PR 1 of 7) — the blueprint that locks the shape of the
Tribunal Learn build. Every decision in Part A is LOCKED and is not renegotiated
by a later PR. Parts B/C/D fill in architecture, the one-PR-per-step build plan,
and open decisions.

**Parent:** NID-37 (Tribunal Learn build). **This step:** NID-96 (PR 1 — this
blueprint). **Repo:** jfcanon/talvi. **Mount host:** `app.ygdcbtmc4u.uk/learn/*`.

**Thesis (locked):** teach the Living Tribunal's *machinery* — the discipline of
independence, grounding, and recorded dissent — by making each game mechanic a
literal mapping of one piece of that machinery (decision 6). The value being
taught is the discipline, not the tools (`formalize THINLY`,
`secondbrain/docs/HUB-BLUEPRINT.md:Thesis`).

---

## Part A — Locked decisions

These were converged in the NID-37 Stage 1 design phase across six lane verdicts
(claude-fable-5, deepseek-v4-pro, deepseek-v4-flash, glm-4.7-flash, gpt-oss-120b,
nemotron-3-ultra-free). A later PR that contradicts one of these is out of scope
and must stop.

| # | Decision | Status |
|---|---|---|
| **1. Architecture** | A standalone Worker at `learn/` inside the talvi repo (the `blue/` subdir precedent, now the `relay/`/`chat/`/`hub/`/`3d/` subdir convention), mounted on `app.ygdcbtmc4u.uk` at path route `/learn/*` — Cloudflare route pattern `app.ygdcbtmc4u.uk/learn/*`, most-specific-pattern wins (owner's talvi-hub-blueprint A2/A5/A11). Own `learn/main.tf` + own tfstate key + own CI workflow (PR→plan, merge→apply). **Terraform never applies locally** (RUNBOOK rule 1). | LOCKED |
| **2. Auth** | Clerk, owner-only, verified **in-Worker** via `@clerk/backend` with `jwtKey` (networkless per-request; the blue release's proven pattern, now the hub/relay port — `hub/src/lib/auth.js`, `blue/main.tf`). `app.*` also carries whole-host Cloudflare Access (A5a) — the Worker gate is the additional in-app layer, **never a substitute**. Only `/learn/healthz` is public; everything else under `/learn` deny-by-default → 401 / redirect to sign-in. Do NOT weaken the CSP (`default-src 'none'`, zero inline/eval, versioned path-prefixed assets `/learn/s.css`). | LOCKED |
| **3. Persistence** | Own D1 database `talvi-learn-meta` (separate from `talvi-meta`/`talvi-blue-meta` — release isolation). Gamification state in D1: append-only `xp_events(id, ts, lesson_id, skill, xp)` event ledger + derived tables (`lesson_progress`, `player_state` with streak/hearts). The tribunal's files-as-ledger doctrine mirrored: **state is rebuildable from the event ledger**. Use talvi's idiom: `CREATE TABLE IF NOT EXISTS` at the top of any handler touching D1 (no migration tooling), ISO timestamps computed in JS (never SQL `datetime()`). | LOCKED |
| **4. Content** | Curriculum = static JSON bundled by esbuild (never a DB), versioned with code. Every lesson fact carries a `cite: "<file>:<section>"` field referencing `secondbrain/docs/HUB-BLUEPRINT.md` or a `sidequests/` file. A CI content-lint fails the build on any citation-less exercise. | LOCKED |
| **5. Curriculum** | 5 units, ~30 lessons + 5 checkpoints. U1 Inception & "formalize thinly" (5) · U2 Harness engineering fundamentals (6–7) · U3 The tribunal's own architecture (8–11, the core unit) · U4 Loop engineering (4–7) · U5 Operational reality (4–6). **MVP = Units 1–4 (~24 lessons); Unit 5 is GATED** behind a factcheck sitting against the real cinto repo — "7-FTE org" and Cinto details are UNVERIFIED in the grounding corpus and must not be asserted. `~/orca/projects/living/docs/estado-y-tareas.md` is a furniture layout, NOT a tribunal source — do not cite it. Multica: the blueprint records the license-gate rejection; the later integration is evidenced by this very workspace — teach the evaluation AND the integration, label the integration as owner-confirmed-current, not blueprint-derived. | LOCKED |
| **6. Game mechanics map the machinery** | checkpoints = gate-enforced verdicts; mastery/legendary = claim `review_state` / ≥3-validated rule; XP ledger = tribunal ledger; path graph = `_moc.md`. Hearts/lives optional-off; leagues cut from MVP (single owner) — "past-you" ghost as stretch. | LOCKED |
| **7. Build sequence** | PR1 blueprint → PR2 inert skeleton + guards → PR3 Clerk gate → PR4 D1 data layer + APIs → PR5 curriculum content → PR6 UI (path, lesson player, gamification) → PR7 verify pass + hub blade + RUNBOOK. One PR per step, CI-only apply, live-verify by curling the real URL after apply — "CI went green" is not verification. | LOCKED |

---

## Part B — Architecture

### B.1 Route map

`app.ygdcbtmc4u.uk` is one hostname, many Workers, split by Cloudflare route
pattern (most-specific-pattern wins — the talvi2 split generalised, `hub/main.tf`).
The hub owns the `/*` fallback; learn mounts a more-specific route and is
untouched by — and does not touch — green/relay/chat/cinto/3d.

```
app.ygdcbtmc4u.uk/learn/*   → talvi-learn worker (new route, this build)
app.ygdcbtmc4u.uk/*         → talvi-hub  (existing fallback, untouched)
app.ygdcbtmc4u.uk/relay/*   → talvi-relay (existing, untouched)
app.ygdcbtmc4u.uk/chat/*    → talvi-chat  (existing, untouched)
… cinto, 3d — all untouched
```

The `app` DNS record already exists (the hub created it — `hub/main.tf`
`cloudflare_dns_record.app`). Learn adds **only a route**; no new DNS record.

Route-level access table (deny-by-default, decision 2):

| Path | Access | Notes |
|---|---|---|
| `/learn/healthz` | public | the only anonymous content route; live-verify target for PR2 |
| `/learn/s.css`, `/learn/s.js` | public | versioned path-prefixed assets (A11), served immutably `?v=<hash>` — the strict CSP requires them to be files, not inlined |
| `/learn/*` (everything else) | Clerk-gated | no valid `__session` → 302 to `/sign-in` (host root, served by the **hub**), API paths → 401 JSON |
| `/sign-in`, `/sso-callback`, `/api/signout` | — | **not learn's routes.** The Clerk sign-in surface lives at the app ROOT, served by the hub (`hub/main.tf`, `hub/src/lib/auth.js`). Learn verifies the host-wide cookie and redirects; it never serves sign-in itself. |

The sign-in redirect targets `app.ygdcbtmc4u.uk/sign-in` — the hub's page — not a
learn-local route. This is the same shape the relay uses (relay keeps an
in-worker gate; the hub owns the sign-in surface).

### B.2 Auth flow (Clerk, networkless, in-Worker)

Ported verbatim from the proven pattern — `hub/src/lib/auth.js` (which itself
ports the blue release, `s7/talvi-blue-auth-handover.md`):

- `createClerkClient({ secretKey, publishableKey, jwtKey: env.CLERK_JWT_KEY })`
  with `jwtKey` = Clerk's PEM public key → session verification happens in the
  V8 isolate, **no JWKS fetch per request**.
- `authenticateRequest(request, { authorizedParties: ["https://app.ygdcbtmc4u.uk"] })`
  — the cookie-replay guard (the `azp`/origin rule). One entry: the whole-host
  origin.
- **Fail-closed:** a missing/invalid cookie is the same as no cookie → 401 / 302.
  A misconfigured deploy refuses access loudly, never silently opens.
- **Owner-only** is delivered by the whole-host Cloudflare Access allowlist (A5a,
  owner email) layered **over** this in-worker gate. The gate answers "is there a
  valid session for app.*"; the Access allowlist answers "is the holder the
  owner". If a second Clerk user is ever added, the owner-email check moves INTO
  the Worker (a declared extension point — see Part D). Neither layer is a
  substitute for the other.

Bindings needed by learn (verify-only; the publishable key is bound for the
fail-closed presence check and to match the relay/hub shapes): `CLERK_SECRET_KEY`
(secret_text), `CLERK_PUBLISHABLE_KEY` (plain_text), `CLERK_JWT_KEY` (plain_text).

### B.3 Worker directory layout — `learn/` (mirrors `relay/`)

```
learn/
  main.tf                 # own state key talvi/learn/terraform.tfstate; D1 + route + Clerk bindings
  wrangler.jsonc          # local dev only (never used for apply)
  package.json            # build: build-assets + esbuild bundle; content-lint wired in PR5
  scripts/
    build-assets.mjs      # embeds CSS/JS + curriculum JSON via JSON.stringify (never template literals)
    content-lint.mjs      # PR5: fails build on any citation-less exercise
    verify-learn.mjs      # PR7: live curl checks (healthz 200, gate 401, sign-in redirect)
  src/
    index.js              # entry: route handler, deny-by-default
    prefix.js             # path-prefix helper (mirrors relay/hub prefix.js)
    lib/
      auth.js             # Clerk gate — verbatim port of relay/hub auth.js
      store.js            # D1: ensureSchema + xp_events/lesson_progress/player_state queries
      curriculum.js       # imports the bundled curriculum JSON; exposes path graph + lesson lookup
    ui/
      path.js             # PR6: the path-graph page (rendered server-side)
      lesson.js           # PR6: the lesson player
      style.css           # PR6: instrument aesthetic (talvi single-hue system)
    generated/
      assets.js           # build-assets output: CSS/JS/curriculum as strings
  dist/                   # esbuild output (gitignored)
```

### B.4 D1 schema — `talvi-learn-meta`

Append-only event ledger is the source of truth; the derived tables are
rebuildable from it (decision 3 — the files-as-ledger doctrine mirrored). ISO
timestamps computed in JS, never SQL `datetime()` (RUNBOOK §4 / `src/index.js`).

```sql
-- The event ledger (append-only; never UPDATE, never DELETE)
CREATE TABLE IF NOT EXISTS xp_events (
  id         TEXT PRIMARY KEY,   -- uuid, generated in JS
  ts         TEXT NOT NULL,      -- ISO 8601, new Date().toISOString()
  lesson_id  TEXT NOT NULL,
  skill      TEXT NOT NULL,      -- the skill tag the event awards (e.g. "convergence")
  xp         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_events_ts     ON xp_events(ts);
CREATE INDEX IF NOT EXISTS idx_xp_events_lesson ON xp_events(lesson_id);

-- Derived: rebuildable from xp_events by re-running the reduction
CREATE TABLE IF NOT EXISTS lesson_progress (
  lesson_id    TEXT PRIMARY KEY,
  status       TEXT NOT NULL,    -- 'not_started' | 'in_progress' | 'mastered' | 'legendary'
  attempts     INTEGER NOT NULL DEFAULT 0,
  mastered_at  TEXT,             -- ISO 8601
  legendary_at TEXT              -- ISO 8601
);

-- Derived: single-owner player state (streak/hearts live here, decision 3)
CREATE TABLE IF NOT EXISTS player_state (
  player_id  TEXT PRIMARY KEY,   -- fixed key 'owner' (single user)
  streak     INTEGER NOT NULL DEFAULT 0,
  hearts     INTEGER NOT NULL DEFAULT 0,
  last_seen  TEXT,               -- ISO 8601
  updated_at TEXT NOT NULL       -- ISO 8601
);
```

Game-mechanic → machinery mapping (decision 6), enforced in the schema and code:

| Mechanic | Machinery mapping |
|---|---|
| checkpoint | a **gate-enforced verdict**: the unit cannot "close" until the checkpoint's gate record exists (mirror `hub gate` — `sidequests/plan-convergence/verdict.md:Phase 2`) |
| mastery / legendary | mastery = a claim with `review_state: accepted` (≥1 real re-check); legendary = the **≥3 validated sittings** rule from skills compounding (`sidequests/_claims-schema.md:Lifecycle`, `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 8`) |
| XP ledger | the tribunal's `ledger.md` (`secondbrain/docs/HUB-BLUEPRINT.md:§7`) |
| path graph | `sidequests/_moc.md` (the Mermaid Map of Contents) |

### B.5 CSP rules

Every learn page carries the talvi header set verbatim (`src/index.js:HTML_HEADERS`,
`hub/src/lib/html.js`):

```
default-src 'none'; style-src 'self'; script-src 'self';
img-src 'self' data:; connect-src 'self'; form-action 'none';
frame-ancestors 'none'; base-uri 'none'
```

plus `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
`x-robots-tag: noindex, nofollow`.

- Zero `'unsafe-inline'`, zero eval — which is *why* CSS/JS are files at
  `/learn/s.css` / `/learn/s.js`, versioned `/learn/s.css?v=<hash>` (immutable,
  hash from contents — `RUNBOOK.md:§8`).
- The two Clerk pages (`/sign-in`, `/sso-callback`) are **the hub's** pages and
  carry their own nonce'd CSP — learn never serves them, so learn's strict CSP
  never moves. Learn pages load no clerk-js.

### B.6 Cost note

Free tier, far inside every limit (same analysis as `talvi-hub-blueprint.md:Part F`):
one D1 database (metadata-sized rows, write-rate = a single human playing),
one route, one workflow. No R2, no Durable Objects, no Workers AI in MVP. The
curriculum JSON rides in the bundle (≤ a few tens of KiB), so the 3 MB worker
size limit is irrelevant. **No plan change.**

---

## Part C — Build plan (one PR per step)

Every step's live-verify is curling the real URL after CI apply. "CI went green"
is not verification. Branch naming follows the repo (`learn-1-blueprint`,
`learn-2-skeleton`, …). Branches are never deleted.

### PR 1 — Blueprint (this PR)
- **Tasks:** write this file.
- **Verify:** this document is internally consistent; every curriculum fact in
  B/C cites a real `file:section`; Unit 5 explicitly gated.
- **Rollback:** revert the PR (a doc-only commit).
- **Done when:** PR opened against `main` with the routable issue key (NID-96)
  in title/body.

### PR 2 — Inert skeleton + guards
- **Depends:** PR 1.
- **Tasks:** `learn/` scaffold (main.tf with state key `talvi/learn/terraform.tfstate`,
  D1 `talvi-learn-meta`, route `app.ygdcbtmc4u.uk/learn/*`, no bindings yet),
  `terraform-learn.yml` (PR→plan, merge→apply), worker serving only
  `/learn/healthz`; deterministic build. Content-lint scaffolding (runs, finds
  nothing yet).
- **Verify (live):** `curl -sS -o /dev/null -w '%{http_code}' https://app.ygdcbtmc4u.uk/learn/healthz` → 200;
  a no-op PR plans `No changes` (determinism check); green/relay/chat/hub all
  still 200.
- **Rollback:** revert; the route and D1 are the only new resources.
- **Done when:** pipeline proven end-to-end before any content exists.

### PR 3 — Clerk gate
- **Depends:** PR 2.
- **Tasks:** add the three Clerk bindings; port `lib/auth.js` verbatim; wire
  deny-by-default: every `/learn/*` route except `healthz` and the asset paths
  requires a valid `__session`, else 302 → `/sign-in` (API paths 401).
- **Verify (live):** signed-out `curl …/learn/` → 302 to `/sign-in`;
  `…/learn/healthz` still 200; signed-in browser reaches `/learn/`.
- **Rollback:** revert; auth gate removed, routes return to PR-2 open state.
- **Done when:** the gate is proven with a real session cookie; no CSP change on
  any page.

### PR 4 — D1 data layer + APIs
- **Depends:** PR 3.
- **Tasks:** `lib/store.js` `ensureSchema` (the B.4 DDL) + the append-only
  `xp_events` insert + the reduction that rebuilds `lesson_progress` /
  `player_state`; JSON APIs (`/learn/api/progress`, `/learn/api/xp`,
  `/learn/api/checkpoint`) all Clerk-gated.
- **Verify (live):** curl the APIs signed-out → 401; signed-in → correct shape;
  D1 rows append and the derived tables rebuild from the ledger alone.
- **Rollback:** revert; D1 rows are new and disposable.
- **Done when:** state is demonstrably rebuildable from the event ledger.

### PR 5 — Curriculum content
- **Depends:** PR 4.
- **Tasks:** author `learn/curriculum/*.json` (Units 1–4 per the contract below;
  Unit 5 placeholders labeled GATED), bundle it via `build-assets.mjs`, and make
  `scripts/content-lint.mjs` fail the build on any exercise with a missing/empty
  `cite`.
- **Verify:** `npm run build` fails on a deliberately citation-less exercise,
  passes on the real set; a grep of the bundle for the UNVERIFIED strings
  ("7-FTE", cinto operational claims) returns nothing outside the GATED
  placeholders.
- **Rollback:** revert; content is versioned with code, no migration.
- **Done when:** every Unit 1–4 fact carries a real `cite`, Unit 5 is gated.

### PR 6 — UI (path graph, lesson player, gamification)
- **Depends:** PR 5.
- **Tasks:** server-rendered path-graph page (`/learn/`) drawn from the
  curriculum path graph (the `_moc.md` shape), lesson player (`/learn/lesson/<id>`),
  and the gamification surface (XP, streak/hearts, checkpoint gates, mastery →
  legendary). talvi single-hue instrument aesthetic; strict CSP; reduced-motion
  honours; real form controls; no inline/eval.
- **Verify (live):** browser pass — zero own CSP violations (the Cloudflare
  Browser Insights beacon is reported info, never fixed in CSP); path navigation,
  lesson completion writes XP, checkpoint gate enforces.
- **Rollback:** revert; gamification state is rebuildable from the ledger.
- **Done when:** the full loop is playable in a signed-in browser.

### PR 7 — Verify pass + hub blade + RUNBOOK
- **Depends:** PR 6.
- **Tasks:** `scripts/verify-learn.mjs` (healthz 200 / gate 401 / sign-in redirect
  / XP round-trip); add the LEARN blade icon to the hub (owner coordinates the
  hub work — do not touch the hub's 3D world); RUNBOOK entries for learn
  (auth, D1 rebuild, takedown, limits).
- **Verify (live):** `node scripts/verify-learn.mjs https://app.ygdcbtmc4u.uk` all
  pass; blade icon navigates; regression: green/relay/chat/cinto/3d all still 200.
- **Rollback:** revert; blade icon removed.
- **Done when:** live-verified end to end, RUNBOOK self-contained.

---

## Part D — Open decisions + explicit non-goals

### Open decisions (not blockers; resolved later, not by renegotiating Part A)

1. **Owner-email check location.** While single-user, "owner-only" = whole-host
   Access allowlist (A5a) over the in-worker session gate. If a second user is
   ever added, move the owner-email assertion into the Worker. Extension point,
   not a decision to make now.
2. **Hearts on/off default.** Decision 6 says optional-off; confirm the default
   with the owner before PR6.
3. **"past-you" ghost.** Explicitly a stretch goal, not in MVP (decision 6).
4. **Content-lint strength.** CI enforces "no citation-less exercise" + `cite`
   format. Ground-truth of each citation string is verified by the PR author
   against the secondbrain/sidequests corpus — which lives *outside* the talvi
   repo. Snapshotting a cited-corpus copy into the repo (so the lint can also
   check the target path exists) is a possible PR5 increment, not required.
5. **tfstate key naming.** The repo isolates state by *key under one shared
   bucket*: `talvi-tfstate` with keys `talvi/terraform.tfstate` (green),
   `talvi/blue/…`, `talvi/hub/…`, `talvi/relay/…`. Decision 1's "own tfstate
   bucket key (`talvi-learn-tfstate`)" is satisfied by the key
   `talvi/learn/terraform.tfstate` in that same bucket — the isolation property
   is identical and it matches every sibling app. Recorded as a factual
   discovery (see PR body), not a renegotiation.

### Non-goals (explicitly out of scope)

- **Unit 5** ships nothing until a factcheck sitting against the real cinto repo
  verifies "7-FTE org" and the Cinto claims. GATED placeholders only.
- **Leagues, multi-user, any second player.** Single owner. Cut from MVP.
- **Any R2/Durable Objects/Workers AI.** Gamification is D1-only.
- **Weakening the CSP** on any page, ever.
- **Serving sign-in** — the hub owns `/sign-in`; learn never does.
- **Terraform apply locally**, touching CI infra, or starting PR2 — all out of
  scope for this step.
- **`estado-y-tareas.md`** is a furniture layout, not a tribunal source; it is
  never cited.

---

## Curriculum content plan — the contract PR5 fills

Every lesson is a **skill** taught by a small set of **facts**, and every fact
carries a `cite: "<file>:<section>"`. The `<file>` is a path under
`~/orca/projects/sagwebapp/` (`secondbrain/docs/HUB-BLUEPRINT.md` or a
`sidequests/…` file). Section names below are the actual headers in those files,
verified by reading them for this blueprint. **Units 1–4 = MVP (24 lessons + 4
checkpoints). Unit 5 = GATED placeholders.**

### Unit 1 — Inception & "formalize thinly" (5 lessons)

| # | Lesson (skill) | Facts (each with `cite:`) |
|---|---|---|
| 1.1 | The tribunal's vocabulary | tribunal → sitting → quorum → convergence — `secondbrain/docs/HUB-BLUEPRINT.md:Vocabulary` |
| 1.2 | The thesis: formalize thinly | value is discipline, not machinery; the doc + intake + ledger + `hub` = the whole system — `secondbrain/docs/HUB-BLUEPRINT.md:Thesis`, `:§10 Verdict` |
| 1.3 | What it is / is NOT | takes a problem, routes the same brief, grounds, converges; NOT a build env/chat/orchestrator — `secondbrain/docs/HUB-BLUEPRINT.md:§2 Purpose & scope` |
| 1.4 | The core loop | intake → triage → ground → route (blind) → converge → verify → record — `secondbrain/docs/HUB-BLUEPRINT.md:§3 The core loop` |
| 1.5 | Naming & the Quorum recommendation | "Quorum" names the independence property; Crossbench runner-up — `secondbrain/docs/HUB-BLUEPRINT.md:§1 Name` |

**Checkpoint 1 (gate):** reproduce the vocabulary and the thesis, and name the
thing the tribunal is NOT. Gate record = a small "verdict" the player writes and
submits (mirror `hub gate`).

### Unit 2 — Harness engineering fundamentals (6 lessons)

| # | Lesson (skill) | Facts (each with `cite:`) |
|---|---|---|
| 2.1 | Agent = Model + Harness | the harness is everything around the model — `sidequests/harness-baseline/intake.md:Grounding` |
| 2.2 | The eight harness components | guides · sensors · memory · tools · guardrails · loop controller · verification · failure handler — `sidequests/harness-baseline/verdict.md:Component map` |
| 2.3 | Harness changes beat model changes | 5–14 pts, −20% tokens, same model; Manus rewrote its harness 5× in 6 months — `sidequests/harness-baseline/intake.md:Grounding` |
| 2.4 | The failure statistics | ~88% never reach production; ~27% data-quality; verification is the most-skipped layer — `sidequests/harness-baseline/intake.md:Grounding`, `:verdict.md:Verdict` |
| 2.5 | The tribunal's component map | strong (memory/state, guardrails) vs weak (sensors, verification) — `sidequests/harness-baseline/verdict.md:Component map` |
| 2.6 | Sensors, proven | the two live defects (5-lane auto-pick vs MAX_LANES; substring slug match) — `sidequests/harness-baseline/verdict.md:Live defects found` |

**Checkpoint 2 (gate):** classify a fictional system against the eight components
and say which layer the tribunal itself was weakest in.

### Unit 3 — The tribunal's own architecture (8 lessons — the core unit)

| # | Lesson (skill) | Facts (each with `cite:`) |
|---|---|---|
| 3.1 | Files are the only state | session is disposable; a fresh session becomes the hub by reading the doc + ledger — `secondbrain/docs/HUB-BLUEPRINT.md:§7 State & memory` |
| 3.2 | The `hub` CLI | `new/run/verdict/eval/gate/…`; blind parallel fanout; self-rolled watchdog — `secondbrain/docs/HUB-BLUEPRINT.md:§0 Current state` |
| 3.3 | Lanes & the family rule | the lane inventory; count DeepSeek once, nemotron max 2 — `secondbrain/docs/HUB-BLUEPRINT.md:Full lane inventory`, `:§4 Routing policy` |
| 3.4 | Routing policy | which lanes for which class; default 2 lanes, 4 only for high stakes — `secondbrain/docs/HUB-BLUEPRINT.md:§4 Routing policy` |
| 3.5 | Grounding | `sb` RAG + fresh docs; refuse/downgrade when ungrounded — `secondbrain/docs/HUB-BLUEPRINT.md:§6 Grounding` |
| 3.6 | Convergence method | atomic claims, source-or-unverified, majority ≠ convergence, verifier rotation — `secondbrain/docs/HUB-BLUEPRINT.md:§5 Convergence method` |
| 3.7 | State & memory layout | `sidequests/<slug>/{intake,lanes,verdict}` + one ledger line — `secondbrain/docs/HUB-BLUEPRINT.md:§7 State & memory` |
| 3.8 | Claim ledger + MoC | claim schema (claim/source/support/contradiction/confidence/review-state) borrowed from obsidian; `_moc.md` Mermaid map — `sidequests/_claims-schema.md:Record schema`, `sidequests/plan-convergence/verdict.md:Thread C` |

**Checkpoint 3 (gate, the core one):** describe the whole machinery — fanout →
convergence → verify → record — and where the claim ledger and MoC sit in it.

### Unit 4 — Loop engineering (5 lessons)

| # | Lesson (skill) | Facts (each with `cite:`) |
|---|---|---|
| 4.1 | The eval harness | replay past sittings; gate on **deliverable-presence, not exit code** (oc-ds exited 0 with no deliverable twice) — `sidequests/plan-convergence/verdict.md:Phase 1`, `sidequests/harness-baseline/verdict.md:Top-5` |
| 4.2 | Instrumented gates + the seam | gates stay a small script; past ~200 lines, stop and buy — `sidequests/plan-convergence/verdict.md:Phase 2`, `sidequests/harness-baseline/verdict.md:Top-5 #4` |
| 4.3 | Skills compounding | distill playbooks from **≥3 validated** sittings only — `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 8`, `sidequests/plan-convergence/verdict.md:Phase 3` |
| 4.4 | Multica: evaluate AND integrate | the license gate rejected adoption (architecture gate, not just license); the integration later landed — label the integration **owner-confirmed-current**, not blueprint-derived — `secondbrain/docs/HUB-BLUEPRINT.md:§11 Proposal evaluations`, `sidequests/plan-convergence/intake.md:Grounding`, `sidequests/plan-convergence/verdict.md:Thread B` |
| 4.5 | Re-platform triggers | workload-shaped (concurrent mutation, always-on, multi-user), not maturity-shaped — `sidequests/harness-baseline/verdict.md:Ceiling`, `secondbrain/docs/HUB-BLUEPRINT.md:§9` |

**Checkpoint 4 (gate):** order the top layers (eval harness before skills
compounding) and name the re-platform triggers.

### Unit 5 — Operational reality (GATED)

**GATED.** None of these ship until a factcheck sitting against the real cinto
repo verifies the underlying claims. The "7-FTE org" figure and all Cinto
operational details are **UNVERIFIED** in the grounding corpus and must not be
asserted as fact. Placeholders only:

| # | Placeholder (GATED) | What blocks it |
|---|---|---|
| 5.1 | Cost counter & win-rate-per-dollar | verified cost figures — `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 11` |
| 5.2 | VPS offload | unverified infra claim — `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 11` |
| 5.3 | Board kill criterion | board not yet built — `sidequests/plan-convergence/verdict.md:Phase 1` |
| 5.4 | Cinto / "7-FTE org" operational reality | **UNVERIFIED** — factcheck sitting required |

**Checkpoint 5 (gate):** gated alongside the unit.

---

## Adversarial review (self-check, run before FINAL)

- **No self-contradiction on auth:** "only `/learn/healthz` is public" vs "must
  redirect to sign-in" is resolved by the sign-in surface living at the app ROOT
  (hub-owned), not under `/learn`. Learn redirects; it never serves sign-in.
  Assets are public because the CSP forbids inlining — a security decision
  driving a build decision, not a route leak.
- **No step renegotiates a locked decision:** PR2–PR7 each implement exactly one
  locked decision's machinery; none re-opens architecture, auth, persistence,
  content, curriculum, game-mapping, or sequencing.
- **Unit 5 is explicitly gated** in Part A, Part D, and the curriculum table.
- **Every curriculum fact in B/C cites a real `file:section`** that exists in the
  secondbrain/sidequests corpus (read for this blueprint).
- **"7-FTE org" / Cinto are labeled UNVERIFIED** and appear nowhere as asserted
  fact outside the GATED placeholders.
- **tfstate isolation preserved** via `talvi/learn/terraform.tfstate` (recorded
  as a factual discovery, not a change).
