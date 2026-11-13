# Storyboard Stream Recovery Implementation Plan

> **For agentic workers:** Execute the scoped tasks below in this authorized repair session, with independent review before completion.

**Goal:** Reduce the failed long-response workload shown in the screenshot and preserve verified progress inside initial generation.

**Architecture:** Keep direct generation for short single-scene work; multi-scene, longer, reestimated, or explicitly larger shot plans use a compact scene plan followed by bounded shot expansion batches. Only complete validated structured results become checkpoints; final source, duration, identity and directing review remain required. Native Anthropic requests carry the generated JSON Schema once, with the full prompt contract retained for capability fallback.

**Tech Stack:** TypeScript, Zod, existing SQLite planning checkpoints, Node test runner.

**Spec:** User screenshot and runtime task c41e9d76-8f9a-4d6f-b064-583c3f4342f6: generating 457292 ms; upstream stream_read_error; no complete candidate.

## Global Constraints

- Preserve model, reasoning, project facts, source dialogue, requested timing and existing shot identities.
- Never treat truncated provider text as an accepted result.
- Do not write production project data or automatically resume paid generation.
- Preserve unrelated dirty workspace changes; no commit requested.

## Review Focus

- Interruption in a later expansion batch resumes without regenerating accepted earlier batches.
- Existing failed tasks without batch checkpoints can resume through the new path.
- Restored checkpoints must match the exact task, plan and initial/repair namespace.
- Wrong scene, duplicate shot index, altered identity/timing and unsupported dialogue remain rejected.
- Native format fallback restores the full Schema in the prompt; user text is never stripped.

### Task 1: Native contract request size

**Files:** `backend/src/modules/generation/model-output.ts`, `backend/src/infrastructure/providers/text-anthropic.ts`, related provider tests.

- [x] Mark only the generated contract instruction with internal metadata.
- [x] Omit the duplicate Schema from Anthropic native request text; keep it for prompt fallback.
- [x] Verify native/fallback/ordinary user content and new batch contract behavior.

### Task 2: Durable bounded storyboard batches

**Files:** `backend/src/modules/storyboard/storyboard-planning-batches.ts`, `backend/src/modules/storyboard/storyboard-planning.ts`, focused module and route tests.

- [x] Generate and validate a compact complete plan with scene direction, shot boundaries, timing and audio allocation.
- [x] Expand at most two shots per response; retain complete validated batches before proceeding.
- [x] Revalidate restored checkpoints; retain final compilation and directing review.
- [x] Keep the direct path for short single scenes; use batches for reestimation regardless of historical duration, multiple scenes, duration over 30 seconds, more than two existing shots, or suggested shot count over two. Verify long-scene interruption and explicit resume via routes.

### Task 3: Verification and review

- [x] Run focused provider, planning, workflow and route regressions in isolated data directories.
- [x] Run the build and obtain independent review of this repair's diff against its local baseline.
- [x] Record verified behavior and real-provider limitations without claiming the external gateway is repaired.

## Verification

- Planning/batch/task/route regressions: 112/112; provider and adjacent storyboard regressions: 103/103.
- Frontend task helpers and Planner: 57/57.
- Full build passed. Independent reviews passed after fixing the short historical duration → long reestimate branch.
- Existing screenshot task remains failed at generating and resumable; read-only runtime inspection issued no model request.
- No live model retest or production project writes. Upstream reliability and elapsed-time improvement remain unmeasured.
