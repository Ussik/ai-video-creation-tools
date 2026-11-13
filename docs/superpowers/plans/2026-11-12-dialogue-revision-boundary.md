# Dialogue Revision Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep dialogue-only revisions from changing action, narration, speaker identity or story facts through free-text replacements.

**Architecture:** Independently identify changed spoken-text ranges in source/candidate difference windows. Verify exact quotes and occurrences, then require every byte outside those ranges to remain identical. Bind successful review to the complete draft content and source versions so unchanged confirmation reuses it and subsequent edits invalidate it.

**Tech Stack:** TypeScript, Zod, existing structured generation and node:test.

**Spec:** User-authorized implementation delegated in the current chat: preserve existing dirty work; implement initial proposal, continuation and confirmation paths; ambiguous text must fail with a recoverable explanation; do not infer speech with keywords or punctuation.

## Global Constraints

- Preserve long dialogue, catchphrases and the creator's genre and language style.
- No real model requests during verification; use mocked structured output.
- No commits, resets or changes to severity/workflow templates.

## Review Focus

- Repeated utterances must use explicit occurrence indexes.
- Parenthetical performance and speaker labels remain outside editable speech.
- Legacy pending drafts without review cannot inherit a successful stamp.
- Failed or cancelled review must not write draft changes.
- A changed candidate or source cannot reuse a previous approval.

---

### Task 1: Add semantic range validation and exact preservation checks

**Files:** Create `backend/src/modules/script/script-dialogue-boundary.ts`; test `backend/test/script-dialogue-boundary.test.ts`.

**Interfaces:** Consumes source/candidate text and scene context plus `StructuredGenerator`; produces a validated result or recoverable `ScriptToolProblem`. Exposes a deterministic exact-quote checker for mocked tests.

- [x] Add tests for repeated speech, unchanged protected text, action/parenthetical changes, unsupported ranges and style-preserving long dialogue.
- [x] Implement difference windows, semantic review schema, quote occurrence resolution and protected-byte comparison.
- [x] Run `node --import tsx --test test/script-dialogue-boundary.test.ts` in backend.

### Task 2: Bind tool proposals, continuations and shared commits

**Files:** Modify `backend/src/modules/script/script-document-tools.ts`; test `backend/test/script-dialogue-revision.test.ts`.

**Interfaces:** Add an injectable review callback to tools, a draft review fingerprint and production structured generation using existing cancellation/request policies.

- [x] Require successful review before new or changed dialogue drafts are persisted.
- [x] Check the same fingerprint at shared commit; unchanged confirmation performs no new semantic request.
- [x] Clear dialogue metadata when an explicitly ordinary revision changes the draft; reject ambiguous legacy drafts until reviewed.
- [x] Test proposal, continuation, failed review, stale review and confirmation/REST paths.
- [x] Run both dialogue suites and relevant document-tool tests; run TypeScript checks.

Validation: four related suites passed 118 tests; after the final cache-eviction change, both dialogue suites passed 17 tests again. Backend `tsc --noEmit` passed. All model responses were mocked; no real-model style or classification quality was measured.

User authorization already covers implementation; execute in this delegated task without an additional approval gate.
