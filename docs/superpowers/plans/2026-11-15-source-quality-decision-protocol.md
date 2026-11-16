# Source Quality Decision Protocol Implementation Plan

> **For agentic workers:** Implement the root-assigned repair protocol scope in this mirror only. Root retains orchestration and approval of shared contracts.

**Goal:** Make every repair disposition explicit, evidence-bound and auditable without buying another response because a protocol changed.

**Architecture:** Keep existing atomic patch/ref machinery and request journals. Add explicit decisions and immutable evidence hashes; preserve legacy modified progress while refusing to reinterpret old withdrawn responses as retain decisions. Coordinate independent-review history and public summaries with the quality-policy owner.

**Tech Stack:** TypeScript, Zod, node:test, existing exact-request recovery.

**Spec:** Root's current assigned decision protocol and shared-contract messages.

## Constraints

- Edit only assigned repair/progress/shared types and new corresponding tests inside this mirror.
- Do not touch main, business data, paid models, commits or pushes.
- Keep raw, exact checkpoint identities, one format correction and dedicated recovery permits intact.
- No free-text keyword matching to assert semantic correctness.

## Review Focus

- Old withdrawn responses remain historical and cannot authorize new progress.
- Unknown or started paid requests cannot be resent after a schema/prompt upgrade.
- Retain decisions identify the exact finding, current analysis values and source units.
- Modify decisions must commit actual atomic changes and preserve unrelated facts.
- Uncertain decisions persist evidence and stop further model work.

### Task 1: Shared contract

- [x] Agree decision audit, finding assessment and public summary names with root/policy owner.
- [x] Export typed decisions, summaries and private review history without changing existing source-content hashes.

### Task 2: Explicit single-finding decisions

- [x] Add decision schema, exact finding/evidence checks and audited commit rules using the existing atomic change implementation.
- [x] Preserve true legacy patched modifications; stop rather than reinterpret old withdrawn records.
- [x] Persist uncertain decisions before a recovery stop and preserve all original response journals.
- [x] Add isolated tests for valid and invalid decisions, current-field references, evidence and local saved-answer replay.

### Task 3: Progress and recovery compatibility

- [x] Validate decision chains and counters; reject stale, duplicate or uncertain completion claims.
- [x] Prove used correction and unknown request markers never refresh after an upgrade.
- [x] Coordinate root's finite dispatch/batch identity and policy summary integration.

### Task 4: Bounded small-batch efficiency

- [x] Agree an independent max-three batch journal/identity API with root; never synthesize per-item model responses.
- [x] Only batch new unstarted, unbounded work with explicit same-type assessments and disjoint replace targets.
- [x] Retain partial raw and locally validated items; do not resend the whole batch after partial validity.
- [x] Verify focused tests and TypeScript, then report exact files and limitations to root.

## Verification

- Isolated owner suite: 198 tests passed, zero failed; no provider/network calls.
- Backend TypeScript check passed.
- Small batches use zero remote whole-package corrections; saved complete members are checked locally and unresolved members stop the workflow.
- Main checkout, live data, commits, pushes and deployments were not touched.
