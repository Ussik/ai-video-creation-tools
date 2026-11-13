# Shot Trash Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to hide empty storyboard scenes and permanently remove recycled records.

**Architecture:** Extend the existing revision-checked management actions with transactional purge operations; derive scene visibility from the current tab and design. Preserve script scenes, media files and historical tasks.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Mantine, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-09-shot-trash-deletion.md`

## Global Constraints

- Modify the dirty checkout in place and preserve all pre-existing work.
- Purge only recycled records belonging to the current project; validate all candidates before mutation.
- Preserve script scenes, media files, storyboard designs and historical tasks.
- Use snapshot revision and immediate transactions, with no partial deletion on failure.

## Review Focus

- Filters must not limit project-wide empty-trash operations; confirmation must show project counts.
- References added after recycling and stale revisions must reject deletion without partial writes.
- Active and foreign-project IDs must never be purgeable.
- Completed output tasks survive with no dangling result pointer; active task and downstream references remain protected.
- Empty scenes must remain accessible for planning, including explicit initial scene scopes and mobile controls.

### Task 1: Permanent deletion API

**Files:** `packages/shared/src/storyboard/shot-management.ts`, `backend/src/modules/storyboard/shot-management.ts`, `backend/test/shot-management.test.ts`.

**Interfaces:** actions `purge` + `shot_id`, `purge_many` + `shot_ids`, `purge_asset` + `asset_id`, and `empty_trash`; optional `purge_blockers: string[]` on shot entries and recycled assets, plus project-wide `empty_trash_blockers: string[]` for joint deletion.

- [x] Add failure-first API tests for purge, atomic batch/empty trash, stale revisions, active/foreign IDs, references added after recycling and retained history/files.
- [x] Implement candidate resolution, blockers, transactional deletion and fresh snapshots.
- [x] Run `node --import tsx --test test/shot-management.test.ts` from `backend/`.

### Task 2: Management controls and scene visibility

**Files:** `web/src/features/storyboard/ShotManager.tsx`, `web/src/features/storyboard/shot-manager.css`, `web/test/shot-manager.test.tsx`.

**Interfaces:** Consume Task 1 actions and optional blocker metadata through the existing `act` function.

- [x] Add failure-first tests for empty-scene visibility/reset, single/batch purge, cancel, complete project empty-trash confirmation and blockers.
- [x] Implement reusable confirmation locking, recycled selection, destructive controls and responsive layout.
- [x] Run `node --import tsx --test test/shot-manager.test.tsx` from `web/`.

### Task 3: Integration and review

**Files:** `docs/shot-management.md`, this plan, affected source and tests.

- [x] Build shared, backend and web; run targeted management and canvas regression tests.
- [x] Review the completed changes independently for permanent deletion and regression risk.
- [x] Verify browser workflows using disposable test data and isolated runtime, including narrow screen layout; record limitations and `git diff --check` result.

Validation: backend 23/23, management UI 33/33, canvas regression 13/13; full build and diff checks passed. Independent review found and resolved joint deletion false blockers, indirect video history references, foreign-project output references and unbounded blocker text. Browser evidence is in `docs/superpowers/acceptance/2026-11-09-shot-trash-deletion/README.md`.
