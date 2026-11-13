# Storyboard Reliability Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make storyboard planning resumable, observable and less wasteful, and restore complete reference preparation and canvas imports.

**Architecture:** Persist private, versioned planning tasks and validated stage outputs in the existing checkpoint store. Start/query/cancel tasks independently of browser connections, retain the synchronous API for compatibility, and route scene production through one reference-aware canvas import. Keep transport retries bounded and separate from task resume.

**Tech Stack:** TypeScript, Fastify, SQLite, Zod, React/Mantine, node:test.

**Spec:** `docs/research/2026-11-13-storyboard-reliability.md`

## Global Constraints

- Preserve model selection/settings, strict source/dialogue/timing constraints and director review.
- No new runtime dependency and no mutation of existing formal project records for verification.
- Preserve the dirty workspace; snapshot owning files before editing. No unrelated commits, resets or cleanup.
- User explicitly authorized research followed by implementation in this session; execute this plan without another approval handoff.

## Review Focus

- A lost task-start response must not dispatch a second paid generation.
- Browser disconnect and server restart must preserve validated candidates without silently replaying paid work.
- A stale source/model/skill must never receive a cached result from another input.
- A legitimate empty visual scene must remain supported, with explicit reasoning rather than blind keyword inference.
- Existing target canvases and historical reference snapshots must survive idempotent reference-aware imports.

---

### Task 1: Durable planning workflow and task APIs

**Files:** Create `backend/src/modules/storyboard/storyboard-planning-tasks.ts` and focused workflow module as needed; modify `storyboard-planning.ts`, `storyboard-planning-preview.ts`, `script-generation-checkpoints.ts`; add backend tests and shared task types.

**Interfaces:** POST `/script/storyboard/tasks` consumes planning input plus `request_id` and optional `fresh`; returns task snapshot. GET `/tasks/:id` queries without work. POST `/tasks/:id/cancel` cancels explicitly. Snapshot has status/stage/timing, candidate, final result, recovery and diagnostics fields. Original `/plan` remains compatible.

- [x] Add failing tests for same-input deduplication, lost response retry, candidate→review failure resume, revised candidate→recheck resume, explicit cancellation/restart, and stale input/config rejection.
- [x] Persist validated stages and expose start/status/cancel routes with one active task per project and durable request identity; reject conflicting active inputs.
- [x] Reduce duplicated review context and parallelize independent skill preparation. Keep required semantic review and bounded revision.
- [x] Run focused planning, preview, directing and checkpoint tests and backend type checking.

### Task 2: Bounded transport recovery and truthful diagnostics

**Files:** Modify `text-anthropic.ts`, `text-errors.ts`, `model-output.ts` and focused provider/model-output tests.

**Interfaces:** Preserve typed provider failures; only approved read-only storyboard contracts use one bounded transport retry sharing existing request/deadline budget. Partial visible text is diagnostic, never a successful output.

- [x] Add failing SSE tests for stream_read_error followed by success, repeated failure, cancellation, redacted diagnostic text, and no tool replay.
- [x] Retain sanitized upstream details/request identity and explicitly incomplete visible partial text; remove unsupported claims about saved results.
- [x] Enable one caller-level retry for storyboard generation/review while preserving format correction and attempt/deadline limits.
- [x] Run targeted provider, retry and model-output tests.

### Task 3: Complete reference preparation and canvas handoff

**Files:** Modify `visual-profiles.ts`, `script-canvas-preparation.ts`, `ProjectCanvas.tsx`, canvas import/handoff helpers and production dialog as necessary; add backend and web integration tests.

**Interfaces:** Preparation returns explicit visual coverage or reasoned no-dependency decisions. Production imports consume `ScriptCanvasResult` for the actual target canvas, creating/reusing both profile and shot nodes.

- [x] Add failing tests for omitted visible objects, reasoned empty scenes, old binding protection, existing canvas preparation success, valid preparation cache with missing nodes, repeat imports, target canvas and historical snapshots.
- [x] Validate structured coverage before replacing bindings or writing preparation success; avoid global three-kind requirements and keyword-based identity guessing.
- [x] Unify scene production/import handoff through reference-aware nodes while preserving clip and historical behavior.
- [x] Run reference preparation, visual profile, handoff, import and production integration tests.

### Task 4: Observable and recoverable planner UI; integrated acceptance

**Files:** Modify `StoryboardPlanner.tsx`, its styles, focused task polling helper/hook and tests; update `docs/shot-management.md` and research results.

**Interfaces:** Consume Task 1 snapshots, display real stage/timing and saved candidate while review is pending, offer continue/cancel, prevent unreviewed submission, preserve dirty-draft guards and old completed preview recovery.

- [x] Add UI tests for background progress, failed polling without duplicate start, reconnect/reopen, candidate preview plus review failure/continue, cancellation and completed result validation.
- [x] Implement polling with abortable local observers and explicit server cancellation, binding each response to active project/input/task.
- [x] Run focused backend/web suites, shared build and full build; independently review changed behavior and resolve actionable findings.
- [x] Exercise the integrated UI against isolated fixtures; report observed results and any remaining real-provider uncertainty without overstating latency gains.
