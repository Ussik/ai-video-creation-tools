# Storyboard Redesign Recovery Implementation Plan

> **For agentic workers:** Execute locally in this conversation; the user has authorized this fix. Side-conversation instructions prohibit subagents.

**Goal:** Restore replanning into a newly created canvas after current shots are recycled or a previous design canvas is deleted, with one planning-mode control.

**Architecture:** Planning context distinguishes historical plans from active shots and identifies designs whose canvas is missing. The planner defaults those scenes to redesign; update requests for a missing canvas fail before generation or writes. Existing redesign confirmation creates the dedicated canvas.

**Tech Stack:** React, Mantine, TypeScript, Fastify, SQLite, node:test.

**Spec:** User request in this conversation: preserve replanning followed by automatic new-canvas creation on confirmation, including recycled shots and deleted design canvases.

## Global Constraints

- Preserve unrelated working-tree edits, historical shots, recycled resources and existing provider contracts.
- Do not write to the business database or invoke live models.
- Keep healthy-plan reuse and update behavior; opening context remains read-only.
- No commits, service restarts or subagents.

## Review Focus

- A recycled last shot still exposes redesign even when the original canvas exists.
- A deleted design canvas forces redesign even if shots remain valid and fresh.
- Missing canvases discovered after preview cannot partially commit an update.
- Mixed scene selections redesign together while unselected scenes remain untouched.
- Redesign retries reuse the created canvas and preserve recycling/history state.

### Task 1: Report recoverable planning state and protect updates

**Files:** `packages/shared/src/storyboard/storyboard-planning-types.ts`, `backend/src/modules/storyboard/storyboard-planning.ts`, `backend/test/storyboard-planning.test.ts`.

**Interfaces:** Optional per-scene `has_previous_plan` and `requires_redesign` booleans in `StoryboardPlanningContext`.

- [x] Add failing isolated-database tests for recycled shots, deleted canvases, early update rejection and idempotent redesign recovery.
- [x] Report historical-plan and missing-canvas metadata without treating historical shots as active inputs.
- [x] Reject update planning/commit against a deleted design canvas before model calls or writes.
- [x] Run the storyboard planning and adjacent canvas/shot-management suites.

### Task 2: Restore planner entry and new-canvas handoff

**Files:** `web/src/features/storyboard/StoryboardPlanner.tsx`, `web/test/storyboard-planner.test.tsx`, `docs/project-canvases.md`.

**Interfaces:** Consume the optional context flags; preserve compatibility with contexts without these flags.

- [x] Add failing component tests for zero active shots with history and fresh shots with a missing canvas, including mixed selection and confirmation handoff.
- [x] Unify reuse, update and redesign in the top planning-mode selector. Remove the duplicate checkbox; keep only duration controls below. Select redesign for missing canvases and explain automatic creation on confirmation.
- [x] Verify healthy plan reuse, draft invalidation and retry behavior in the existing planner suite.
- [x] Run architecture/UI checks, TypeScript checks and `git diff --check`; document verified behavior and limits.

Verification and unrelated baseline failures: `docs/superpowers/acceptance/2026-11-01-storyboard-redesign-recovery.md`.
