# Unit 5 Fact-Check: Operational Reality (corrected)

> Challenger pass (Lane CC-DS) on PR #234 / OC-OR claim for NID-416.
> Verdicts here are against the real cinto repo (README, top-level docs, `plans/`, and the
> cited infra/source lines) and the curriculum contract. Each entry is
> claim -> evidence (`<file>:<line/section>`) -> VERIFIED / UNVERIFIED / CONTRADICTED.

## Claims and Verification

### Claim 1: Cost counter & win-rate-per-dollar (u5l1)

**1a. The tribunal cost counter is read-only** — **VERIFIED**
- Evidence:
  - `cinto-cloud-console/src/lib/status.js:74-90` — `summarizeCost(rows)` only reads rows; comment: "The cost counter is READ-ONLY: this function only reads rows. It never writes."
  - `cinto-cloud-console/README.md:11` — "**Cost read-only** — the console displays the tribunal cost counter, never writes it."
  - `cinto-cloud-console/plans/cinto-cloud-blueprint.md:21` (A5) — "**Cost is read-only.** The console displays the tribunal cost counter; no write path, no mutating verb, cost never an input."

**1b. Cost data comes from a published snapshot, not hard-coded values** — **VERIFIED**
- Evidence:
  - `cinto-cloud-console/src/index.js:224-227` — `/cloud/api/cost` handler does `readSnapshot(env, "snapshot/cost.json")` and `summarizeCost(snap.rows)`; empty snapshot falls back to `summarizeCost([])` (honest, not hard-coded).
  - `cinto-cloud-console/src/index.js:340-345` — `/cloud/cost` page renders the same snapshot data.

**1c. The API endpoint is `/cloud/api/cost`** — **VERIFIED**
- Evidence: `cinto-cloud-console/src/index.js:224` (`PREFIX + "/api/cost"`, `PREFIX = "/cloud"` at line 14).

**1d. "Win-rate-per-dollar"** — **UNVERIFIED**
- Evidence: string searched across cinto README, `plans/`, and `src/` — not found. The title claim is unsupported; do not teach it, and do not keep it in a lifted lesson title.

### Claim 2: VPS offload (u5l2)

**2a. VPS is planned, not provisioned** — **VERIFIED** (as a planned state)
- Evidence:
  - `cinto-cloud-console/src/lib/views.js:305-306` — "Links the nideasapp-vps-blueprint.md phases P0–P6. The VPS is BACKLOG (planned)." with a disabled button "PLAN-ONLY — VPS not provisioned".
  - `cinto-cloud-console/plans/cinto-cloud-blueprint.md:28` (A12) — "**VPS = planned.** Rendered from `nideasapp-vps-blueprint.md` (N1–N8, P0–P6), always labelled PLANNED, never mixed with real resources."

**2b. Functioning VPS offload (as the lesson title implies)** — **UNVERIFIED / not present**
- The VPS is in BACKLOG. There is no provisioned VPS to teach. Lesson stays GATED.

### Claim 3: Board kill criterion — "blocked by board not yet built" (u5l3)

**UNVERIFIED** — evidence is the placeholder's own cite, not ground truth
- Evidence: `u5.json` u5l3 `gated_reason` and `cite` (`sidequests/plan-convergence/verdict.md:Dissents`). That source was never read; "no contradictory evidence found" is an argument from silence, not evidence. No cinto file contradicts or confirms. Keep GATED.

### Claim 4: Cinto / "7-FTE org" operational reality (u5l4)

**UNVERIFIED**
- Evidence: `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 11` — the same source the issue labels UNVERIFIED for the "7-FTE org" figure and Cinto operational details. `talvi-learn-blueprint.md` Decision #5 confirms the gate. Keep GATED; never assert the figure.

### Gap: Multica-evaluation / integration claims (task requirement)

**NOT COVERED** in the original fact-check. The issue requires recording claims from "the operational-reality / Multica-evaluation sections of `secondbrain/docs/HUB-BLUEPRINT.md`" and teaching the evaluation (blueprint-derived) AND the integration (labelled "owner-confirmed-current", not blueprint-derived). The PR's U5-FACTCHECK.md has no Multica section. This must be added before the issue can be called done.

## Lesson-lift assessment (why the lift as implemented must not ship)

The cost-counter claim is VERIFIED and CAN be taught — but the lifted lesson in PR #234 is not shippable:

1. **Blank facts in the player.** Facts use the key `statement`; the lesson player renders `fact.text` (`learn/src/ui/lesson.js:21`). U1–U4 all use `text` (105 uses, zero `statement`). A player opening u5l1 sees empty fact cards.
2. **Accuracy contract violated in reachable content.** content-lint forbids `cinto` in an un-gated lesson (RUNBOOK:95; `content-lint.mjs` FORBIDDEN_IF_UNGATED). u5l1's facts/exercises say "Cinto Cloud" repeatedly. It only passes lint because the unit-level `gated: true` shields the lesson (`lessonGated = isGatedUnit || lesson.gated`) — the gate was kept to dodge the check, not to satisfy it.
3. **Circular citations.** Every fact/exercise cites `secondbrain/docs/HUB-BLUEPRINT.md:§9 item 11` — the very section marked UNVERIFIED. The verified evidence lives in the cinto files; the cites should point there.
4. **Soft-lock.** Unit stays `gated: true`, lesson `gated: false`. In `learn/src/lib/curriculum.js` `buildRail`, u5l1 becomes the active (playable) node, but the unit-level gate makes c5's `unlocked = unitUnlocked && allLessonsDone` permanently false — the player can play u5l1 and never progress past it.
5. **Out-of-scope + dead script change.** `content-lint.mjs` is not in the issue's "Files you own" list; its `cinto-cloud-console/` root addition is unused by the lesson and leaves the header comment stale.

**Conclusion:** the lift cannot ship within this issue's scope. Keep all four lessons GATED; record the verified claim; file the gate-rework as a follow-up.

### Ready-to-lift draft for the cost-counter lesson (once the gate is reworked)

Facts and exercises use the U1–U4 contract (`text` key, verified cites):

- Fact: "The tribunal cost counter is a read-only feature of the cloud console — it reads published snapshot rows and never writes a cost." cite `cinto-cloud-console/src/lib/status.js:74`
- Fact: "Cost data is derived from a published snapshot (`snapshot/cost.json`) at read time; an absent snapshot is reported honestly as stale/empty, never hard-coded." cite `cinto-cloud-console/src/index.js:224`
- Fact: "The cost endpoint is `/cloud/api/cost`; it returns the summarised counter (total, missing, by-lane) as JSON." cite `cinto-cloud-console/src/index.js:224`
- Exercise (select): "Is the tribunal cost counter mutable or read-only?" [Mutable / Read-only / Write-only / Access-controlled] -> Read-only. cite `cinto-cloud-console/src/lib/status.js:74`
- Exercise (select): "What data source backs the cost counter?" [Live DB queries / Published snapshot files / Hard-coded values / User input] -> Published snapshot files. cite `cinto-cloud-console/src/index.js:224`
- Exercise (select): "Which endpoint exposes cost data?" [/cloud/api/resources / /cloud/api/cost / /cloud/api/monitor / /cloud/api/activity] -> /cloud/api/cost. cite `cinto-cloud-console/src/index.js:224`

Title should drop "& win-rate-per-dollar" until 1d is verified.
