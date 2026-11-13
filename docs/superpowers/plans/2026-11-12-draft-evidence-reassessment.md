# Draft Evidence Reassessment Implementation Plan

> **For agentic workers:** Execute the authorized bug fix in this session, with a separate test worker and an independent review before completion.

**Goal:** Recover a draft review when a retained finding has no supporting candidate quotation, including a scoped reviewer incorrectly reporting sibling deliverables as missing.

**Architecture:** Keep the bounded quotation locator. If it explicitly cannot locate evidence, run one read-only semantic reassessment with the complete original review context and numbered candidate sources. Each unresolved finding receives an explicit confirmation, reasoned withdrawal, or unresolved verdict. Keep verified findings and completed sibling checks; retain the reassessment record and strictly validate final sources and quotes.

**Tech Stack:** TypeScript, Zod, existing generation checkpoints, node:test.

**Spec:** User report and screenshot in this chat; actual `draft-review` checkpoint for project `17a81aaa03b8474ca59a07c485bc759c`.

## Global Constraints

- Preserve source manuscripts, formal documents, generated candidates and model settings.
- Never treat an unresolved verdict, malformed response, cancellation or provider failure as a passed review.
- Do not infer semantic validity from keywords or delete findings automatically.
- Reuse completed sibling reviews and generation steps.

## Review Focus

- False missing-document findings from a scoped review can be withdrawn with a recorded reason.
- A true finding can correct its source only to an actual candidate in the same review scope.
- Verified findings survive another finding's withdrawal; unresolved findings remain recoverable.
- Unknown, duplicate or missing IDs, invalid coordinates and unsupported verdict shapes fail closed.
- Single and paged locators, cancellation and existing retained checkpoints use the same recovery path.

### Task 1: Bounded semantic reassessment

**Files:** Create `backend/src/modules/script/script-draft-evidence-reassessment.ts`; modify `backend/src/modules/script/script-draft-review-evidence.ts`; test `backend/test/script-draft-evidence-reassessment.test.ts` and existing evidence tests.

- [x] Add failing coverage for repeated null evidence, scoped false positives, real findings, source correction, partial progress and invalid responses.
- [x] Implement explicit per-finding verdicts with reasons and exact source-unit extraction; retain the audit record without declaring unfinished review complete.
- [x] Route explicit locator nulls and paged null stalls into one reassessment, preserving all verified progress.
- [x] Run targeted evidence, recovery, scoped-review and completeness tests, typecheck and architecture checks.
- [x] Independently review the patch and use a controlled continuation to verify the affected task if the local service is available; preserve pending-save behavior.

## Verified Outcome — 2026-11-12

- Real-provider validation exposed an additional upstream conflict: local reviewers received the nine-document delivery contract with only their own group's candidate bodies. Local tasks now receive their own acceptance contract plus a metadata-only inventory of all retained candidates. Applicable author constraints remain mandatory, and the independent global review still receives all bodies and the complete contract.
- Recovery task `e19b691b-7dd0-4166-9401-799619e8f2b9` completed successfully using all nine retained documents without regenerating them. It created pending draft `14b229ee034f451e8f485e296471f25c` and cleared the obsolete resolution only after draft creation succeeded.
- Independent read-only verification initially confirmed the source, formal artifacts and scenes were unchanged, with the exact nine candidates in the pending draft. A subsequent save at `2026-11-12T05:35:02.668Z` moved those same nine documents into formal artifacts; all titles, types, order and UTF-8 content match the retained candidates exactly. The recovery script and browser verification did not invoke save, and the database does not identify the actor.
- Final state: nine saved formal documents; source unchanged; no formal scenes, pending draft or unresolved resolution. Local API and browser show the next available stage as character design.
- Final combined regression: 221 passed, 0 failed across 11 files, excluding one independently reproduced pre-existing timing assertion (`nine authorized issues ...`). TypeScript, architecture and scoped diff checks passed. Final independent code review found no blocking issue.
