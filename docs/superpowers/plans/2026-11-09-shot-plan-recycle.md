# Shot Plan Recycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible whole-plan and multi-shot recycle actions to storyboard management.

**Architecture:** Extend the existing revision-checked shot-management action route with atomic batch operations over `shots.deleted_at`. Keep design records and all canvas, media, job and profile references intact; derive active and recycled plan choices from the shots visible in each tab.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Mantine, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-09-shot-plan-recycle.md`

## Global Constraints

- Use soft deletion through the existing `shots.deleted_at` field; do not hard-delete storyboard designs.
- Preserve revision conflict handling and all current shot-delete blockers.
- Batch operations must be atomic and must not remove canvas nodes, jobs, assets, or bindings.

## Review Focus

- One blocked shot in a mixed selection rejects the whole batch; test no partial `deleted_at` writes.
- Stale revisions reject recycle and preserve current state; test HTTP 409.
- A scheme with `design_id = null` remains manageable as the base scheme; test scheme filtering and batch recycle.
- A scheme whose shots have different blockers reports all affected shot titles and reasons; test response details.
- Restoring a scheme does not restore unrelated recycled shots; test exact restored ID set.

---

### Task 1: Atomic recycle API

**Files:**
- Modify: `packages/shared/src/storyboard/shot-management.ts`
- Modify: `backend/src/modules/storyboard/shot-management.ts`
- Test: `backend/test/shot-management.test.ts`

**Interfaces:**
- Consumes: existing `ShotManagementSnapshot`, `shotDeleteBlockers`, and revision field.
- Produces: `trash_many` with `shot_ids: string[]`; `trash_design` and `restore_design` with `design_id: string | null`.

- [x] **Step 1: Add tests** for successful multi-shot recycle, scheme recycle, scheme restore, all-or-nothing blocker rejection, and stale revision conflict.
- [x] **Step 2: Run** `node --import tsx --test test/shot-management.test.ts` in `backend/` and confirm the new cases fail before implementation.
- [x] **Step 3: Implement** validated all-or-nothing actions in the existing immediate transaction; aggregate blocker details before writing any `deleted_at` values.
- [x] **Step 4: Re-run** the focused backend test command and confirm existing single-shot restore/trash behavior remains intact.

### Task 2: Plan and batch actions in the manager

**Files:**
- Modify: `web/src/features/storyboard/ShotManager.tsx`
- Modify: `web/src/features/storyboard/shot-manager.css`
- Test: `web/test/shot-manager.test.tsx`

**Interfaces:**
- Consumes: Task 1 `trash_many`, `trash_design`, and `restore_design` actions.
- Produces: explicit batch recycle, plan recycle, and plan restore controls with blocker summaries.

- [x] **Step 1: Add UI tests** for selected-shot recycle, plan recycle, restore, and blocker feedback.
- [x] **Step 2: Run** the focused ShotManager test and confirm the new UI cases fail before implementation.
- [x] **Step 3: Implement** confirmation dialogs, active/recycle-bin plan filtering, and disabled or rejected states that explain blockers without losing the current selection.
- [x] **Step 4: Re-run** the focused web test and the relevant type/build check.

### Task 3: Final validation

**Files:**
- Verify: `backend/test/shot-management.test.ts`
- Verify: `web/test/shot-manager.test.tsx`

**Interfaces:**
- Consumes: completed API and UI behavior.
- Produces: verified batch and plan recycle workflows.

- [x] **Step 1: Run** backend and web focused tests. Backend `shot-management.test.ts` passed 14/14; web `shot-manager.test.tsx` passed 22/22, including explicit default-plan (`design_id = null`) coverage.
- [x] **Step 2: Run** `git diff --check` and review the changed-file diff for preservation of the pre-existing worktree edits. Focused review found no blocker in batch blockers, transaction handling, or restore ordering; unrelated worktree edits were left intact.

Validation note: `git diff --check` passes. The backend full suite ran with local socket access: 2,209/2,210 tests passed. The unrelated failure is `backend/test/image-prompt-document-generation.test.ts:239` (`system-only structured prompts and system-only board overrides cannot enqueue generation`), which returned 200 where the test expects 422. The focused storyboard suites both pass.
