# Script Generation Attempt Isolation Implementation Plan

> **For agentic workers:** This task is being implemented directly in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every fresh script generation a distinct checkpoint identity while preserving exact resume for the same durable task.

**Architecture:** Add a generation-attempt ID to the checkpoint identity. Fresh tasks use their new task ID; explicit continuation uses the original task ID and may read pre-upgrade identities only through a resume-only compatibility list.

**Tech Stack:** TypeScript, Node test runner, SQLite-backed generation checkpoint store.

**Spec:** User authorization in the current conversation.

## Global Constraints

- Do not call a model or modify the active 8000/8888 services.
- Preserve existing project state, saved documents, and checkpoints.
- Keep work local; do not commit or push.
- A fresh retry must not inherit private candidates from an earlier attempt.
- Continuing the original task must keep its checkpoint identity.

## Review Focus

- Old pending prop candidates must not enter a fresh attempt; test with a persisted failed props checkpoint.
- Pre-upgrade task checkpoints must remain resumable; test resume-only legacy identity compatibility.
- Fresh checkpoints must archive, not erase, the older task checkpoint; assert both identities remain readable.
- A fresh retry must not receive legacy aliases; assert its compatibility list excludes pre-attempt identities.
- Existing generation routes must use stable IDs across stream fallback and task continuation; verify through typed server checks and targeted tests.

### Task 1: Pin Fresh Retry And Resume Isolation

**Files:**
- Modify: `backend/test/script-generation-checkpoint-compatibility.test.ts`
- Create: `backend/src/modules/script/script-generation-attempt.ts`

**Interfaces:**
- Produces `scriptGenerationCheckpointAttempt(identity, attemptId, explicitResume, compatibleIdentities)` returning a primary identity and a compatibility list.

- [x] Add failing tests for fresh props retry isolation and same-task legacy resume.
- [x] Run the focused test and confirm it fails before implementation.
- [x] Implement the attempt identity and resume-only aliases.
- [x] Run the focused test and confirm fresh and resume paths pass.

### Task 2: Bind Durable Task IDs To Checkpoint Identity

**Files:**
- Modify: `backend/src/app.ts`
- Test: `backend/test/script-generation-checkpoint-compatibility.test.ts`

**Interfaces:**
- Fresh task start and direct fallback pass one attempt ID; task continuation passes the existing task ID and enables legacy compatibility.

- [x] Thread attempt identity through director execution to stage generation.
- [x] Keep all existing prompt/workflow compatibility variants within the same attempt.
- [x] Run focused checkpoint and stage recovery tests.
- [x] Run backend type checking; do not contact active services.

## Verification

- 14 focused tests passed across checkpoint compatibility, long-source generation resume, and episode task recovery.
- `npx tsc -p backend/tsconfig.json --noEmit` passed.
- `git diff --check` passed. No provider or live application service was contacted.
