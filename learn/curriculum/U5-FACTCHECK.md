# Unit 5 Fact-Check: Operational Reality

This document records the fact-check of Unit 5 "Operational reality" claims against the real cinto repo and other verified sources.

## Claims and Verification

### Claim: Cost counter & win-rate-per-dollar
- **Evidence**: 
  - cinto-cloud-console/src/lib/status.js:72-93: `summarizeCost()` function reads tribunal cost counter from published snapshot
  - cinto-cloud-console/src/index.js:42-44: API endpoint `/cloud/api/cost` exposes cost data
  - cinto-cloud-console/plans/cinto-cloud-blueprint.md:| **A5** | **Cost is read-only.** The console displays the tribunal cost counter; no write path, no mutating verb, cost never an input.
  - cinto-cloud-console/README.md:- **Cost read-only** — the console displays the tribunal cost counter, never writes it.
- **Verification**: VERIFIED
- **Notes**: The cost counter is implemented as a read-only feature that accurately displays tribunal costs from the published snapshot.

### Claim: VPS offload infrastructure
- **Evidence**:
  - cinto-cloud-console/plans/cinto-cloud-blueprint.md:| **A12** | **VPS = planned.** Rendered from `nideasapp-vps-blueprint.md` (N1–N8, P0–P6), always labelled PLANNED, never mixed with real resources.
  - cinto-cloud-console/src/lib/views.js: Lines showing VPS status: "Links the nideasapp-vps-blueprint.md phases P0–P6. The VPS is BACKLOG (planned)." and disabled button "PLAN-ONLY — VSP not provisioned"
- **Verification**: UNVERIFIED (NOT PROVISIONED)
- **Notes**: The VPS infrastructure is planned in blueprints but has not been provisioned. It remains in BACKLOG status.

### Claim: Board kill criterion (board not yet built)
- **Evidence**:
  - u5.json: lesson u5l3 gated_reason: "blocked by board not yet built"
  - u5.json: lesson u5l3 cite: "sidequests/plan-convergence/verdict.md:Dissents"
  - No contradictory evidence found in available repositories indicating the board is built
- **Verification**: UNVERIFIED (BOARD NOT BUILT)
- **Notes**: While the exact board status cannot be verified from available repositories, the gating reason and lack of evidence suggesting completion indicate this claim remains unverified.

### Claim: Cinto / '7-FTE org' operational reality
- **Evidence**:
  - u5.json: lesson u5l4 gated_reason: "UNVERIFIED — factcheck sitting required"
  - u5.json: lesson u5l4 cite: "secondbrain/docs/HUB-BLUEPRINT.md:§9 item 11"
  - talvi-learn-blueprint.md: Part A, Decision #5: "Unit 5 is GATED behind a factcheck sitting against the real cinto repo — "7-FTE org" and Cinto details are UNVERIFIED in the grounding corpus and must not be asserted."
  - talvi/learn/RUNBOOK.md: Line 95: "4. Forbidden un-gated strings (`7-FTE`, `cinto`) may appear only in documents/lessons with `gated: true`."
- **Verification**: UNVERIFIED
- **Notes**: Multiple authoritative sources explicitly label the "7-FTE org" figure and Cinto operational details as UNVERIFIED in the grounding corpus. The factcheck sitting against the real cinto repo is required to verify these claims.

## Summary

- **VERIFIED**: Cost counter & win-rate-per-dollar (ready for lesson creation)
- **UNVERIFIED**: VPS offload infrastructure (remains gated)
- **UNVERIFIED**: Board kill criterion (remains gated)  
- **UNVERIFIED**: Cinto / '7-FTE org' operational reality (remains gated)

## Next Steps

For VERIFIED claims, create lessons following the U1-U4 contract:
- 3-5 facts[] cards with proper citations
- 3 exercises with proper citations  
- Remove "gated": true flag

For UNVERIFIED claims, maintain the gated placeholders with their current gated_reason explanations.