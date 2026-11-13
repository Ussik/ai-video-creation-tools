# Storyboard Directing Quality Implementation Plan

> **For agentic workers:** Use the current session's native collaboration tools. Implement the independent helper, video handoff, and test fixture tasks in parallel, then have a fresh evaluator inspect the integrated change.

**Goal:** Improve motivated camera motion and usable shot transitions in script storyboard generation and preserve those decisions through video handoff.

**Architecture:** Require scene and shot directing metadata in the generation-only schema, compile it to the existing saved shot fields, and automatically review the entire sequence with at most one semantic repair. Load video prompt rules in a separate scoped stage while preserving all configured bindings and the explicit base mode. Give downstream single-shot handoff only immediate eligible neighbors and freeze that context for concurrent-change detection.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite, React, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-09-storyboard-directing-quality.md`

## Global Constraints

- Use the current model and project/global skill bindings; explicit empty skill selection remains base mode.
- No real model calls, live database edits, automatic saves, database migration, or new dependencies.
- Preserve unrelated work in this dirty checkout; do not commit it.
- Keep the saved/commit storyboard shape compatible. Scene direction and camera/cut records are generation-only and compiled into existing fields.
- Run semantic review after structural validation, repair once, review again, and reject remaining errors with actionable diagnostics.

## Review Focus

- A fixed shot or motivated ellipsis must not be rejected simply for lacking movement or matching endpoint text.
- A review must not reference another scene/shot outside the draft or a nonadjacent related shot.
- Repaired output must retain selected scene scope, existing shot identities, source-backed speech, and total timing.
- Composed prompts must not silently truncate creative material or multiply managed boundaries.
- Neighbor lookup must exclude other designs, deleted/superseded shots, and must not leak neighbor dialogue into current speech.

## Task 1: Professional directing contract and compilation

**Files:** Create `backend/src/modules/storyboard/storyboard-directing.ts` and `backend/test/storyboard-directing.test.ts`.

**Interfaces:** Export `directingSceneSchema`, `directingShotSchema`, `composeDirectedShot`, `storyboardDirectingInstructions`, `storyboardDirectingReviewSchema`, `storyboardDirectingReviewPrompt`, `buildStoryboardDirectingReviewContext`, and `validateStoryboardDirectingReview`.

- [x] Test metadata compilation, fixed-camera support, bounds, source preservation, and invalid review references.
- [x] Implement scene anchors/blocking/axis/dramatic progression and camera movement/start/trigger/path/end/motivation, with cut type/moment/carry/reason.
- [x] Run `node --import tsx --test backend/test/storyboard-directing.test.ts`.

## Task 2: Runtime generation, review, and visible result

**Files:** Modify `backend/src/modules/storyboard/storyboard-planning.ts`, `packages/shared/src/storyboard/storyboard-planning-types.ts`, `web/src/features/storyboard/StoryboardPlanner.tsx`; adapt existing planning fixtures and add `backend/test/storyboard-directing-integration.test.ts`.

**Interfaces:** The existing plan endpoint still returns legacy `scenes` plus scoped video skill provenance and a textual `directing_review` summary; the commit endpoint remains unchanged.

- [x] Add integration assertions for the two scoped rule sets, rich schema, review/repair/review, persistent error rejection, base mode, stale skill/source rejection, and no writes before save.
- [x] Generate rich metadata, validate legacy scope/timing/audio, compose legacy fields, and review full sequence and source data.
- [x] On semantic errors, regenerate against evidence exactly once, validate and review again. Report warnings separately; never mark them as picture/video validation.
- [x] Show the extra rule stage and review state using existing disclosure/status components; manual draft edits invalidate the displayed review status.
- [x] Run focused backend planning and frontend planner tests.

## Task 3: Production handoff continuity

**Files:** Modify `packages/shared/src/storyboard/shot-prompts.ts`, `backend/src/modules/canvas/video-audio-plan.ts`, and their focused tests.

**Interfaces:** `shotVideoPrompt` always includes one replaceable saved state/cut block. Handoff snapshots include eligible immediate neighbors, whose speech is excluded from the permitted speech sources.

- [x] Test authored video prompt boundaries and idempotency; test same-design neighbors, stale neighbor changes, scene changes, and forbidden neighbor speech.
- [x] Preserve current image design authority and explicitly separate cut/angle changes from camera trajectories.
- [x] Run isolated shared consumer and video handoff tests.

## Task 4: Integration verification and independent evaluation

- [x] Build shared package; run focused backend and frontend regressions, TypeScript/build, architecture/UI checks, and diff whitespace checks.
- [x] Independently review changed behavior against the spec and repair material findings; do not re-run unchanged failing unrelated suites.
- [x] Record actual pass/fail counts and real-model quality limits in a research note.

Execution is already authorized by the user. The plan was self-reviewed for scope, interface consistency and failure coverage; continue implementation in this session.

## Completion

Implemented and independently reviewed in this session. Related backend regressions 167/167 and frontend regressions 253/253 passed; final build and guards passed. Evidence and limits: `docs/research/2026-11-09-storyboard-directing-quality.md`. No real-model calls, automatic saves, commits, or deployments.
