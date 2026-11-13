# Complete Story Outline Implementation Plan

> **For agentic workers:** Implement in this session, validate the integrated request path, and independently review the focused change.

**Goal:** Stage buttons trigger their complete deliverables, while each internal document is processed as its own task.

**Architecture:** Use the existing full `stage_design` contract. Remove summary/full choices from the stage menu and workflow panel, then split backend work by artifact with dependencies and separate continuation checkpoints. Keep existing saved-draft snapshots and explicit editor supplementation compatible.

**Tech Stack:** React, Mantine, TypeScript, Node test runner.

**Spec:** User instructions in this chat, 2026-11-09: “故事大纲直接处理全部”, and “每个大选项内部的小单位要注意拆分处理”, including outline documents and character biographies/relationships.

## Global Constraints

- A new outline request includes all nine existing outline artifact types, with or without an uploaded source.
- The main outline action has no separate summary or remaining-eight-items option.
- Saved outline actions operate on the whole stage; other stages and existing saved content retain their behavior.
- Preserve unrelated workspace changes. No real model calls, commits, or external publication.
- Outline, character, location, and prop subtasks each generate one document. An episode's正文 and matching scenes remain one atomic deliverable.

## Review Focus

- Main button and workflow panel submit the same nine-document scope.
- Uploaded sources do not silently reduce the request to one summary document.
- Source readiness, creative brief, busy state, and unsaved-draft restrictions still prevent invalid requests.
- Historical request snapshots retain their original scope.
- Existing explicit editor supplementation still previews its missing documents before generation.
- Failed subtasks retain completed sibling work; downstream tasks read the necessary prior documents.

### Task 1: Unified entry and request contract

**Files:** `web/src/features/script/ScriptStageActions.tsx`, `web/src/features/script/script-workflow.ts`, `web/src/features/script/ScriptDirectorPanel.tsx`.

- [x] Make the initial outline button submit full stage design directly.
- [x] Remove the summary/full selector and fix outline generation scope to all nine items.
- [x] Keep saved outline revision/redesign actions and other-stage actions.

### Task 2: Validation

**Files:** `web/test/script-stage-actions.test.tsx`, `web/test/script-workflow.test.ts`, `web/test/director-initial-context.test.tsx`.

- [x] Cover direct-click requests and panel requests with and without source material.
- [x] Run focused frontend regressions, architecture checks, and build.
- [x] Independently review and repair actionable findings.

### Task 3: Internal document tasks

**Files:** `backend/src/modules/script/script-task-execution.ts`, `backend/test/script-task-execution.test.ts`, necessary existing backend integration assertions.

- [x] Split every non-episode stage into one task per requested artifact, with narrative dependencies.
- [x] Preserve per-task continuation, successful results, source context, and failure recovery.
- [x] Cover full-stage aggregation, character relationships reading biographies, partial failures, and resumed work.
- [x] Run backend regressions and type checks, then independently review integration.

## Validation

- Frontend: 83 passing tests across stage actions, request contracts, director context, script tools, and editor handoff.
- Backend: 261 passing tests across API contracts, document tools, completeness, source preservation, character continuation, episode/scene handling, and redesign.
- Recovery: 33 additional passing tests across document task execution, old-checkpoint migration, interrupted generation, source outlines, and legacy format recovery.
- Shared, frontend, and backend builds passed; architecture and UI component checks passed.
- Independent review found no remaining blocking issues after legacy recovery fixes.
- All provider calls in validation were mocked. Real model quality, latency, and cost were not evaluated.
