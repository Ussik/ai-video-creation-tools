# Source directory output recovery Implementation Plan

> **For agentic workers:** Execute the following tasks in this session under the user's existing authorization; delegate independent tests and review.

**Goal:** Resume a source directory after confirmed text output exhaustion without rerunning the full page or publishing incomplete coverage.

**Architecture:** Keep the existing fixed work plan. Add a private generation-pages checkpoint beside the existing raw/format checkpoint, preserve validated closed sections, and reuse the existing bounded pagination protocol. Every continuation retains the complete original source; publish only after explicit completion and existing boundary/evidence checks.

**Tech Stack:** TypeScript, Zod, LangGraph, node:test, SQLite test fixtures.

**Spec:** Screenshot failure at 2026-11-14 01:38: max_output_tokens, 8,188 output tokens, no explicit request output limit. Existing source-analysis behavior and this plan define the scope.

## Global Constraints

- Work directly on main and preserve all prior uncommitted changes.
- Do not change model, user output/thinking settings, original source, or independent quality checks.
- Recover only confirmed text output exhaustion; retain normal transport, evidence, boundary repair and journal protections.
- No real model calls or real task/data mutations during verification.

## Review Focus

- A closed final section without a successor must remain private until the whole window completes.
- A restart after a failed continuation must retain the prefix and never repeat the original full-page call.
- Duplicate/outside/non-increasing boundaries must not enter a resumable prefix.
- No-progress pagination must stop after bounded 8/4/2/1 attempts; pure reasoning exhaustion must propagate.
- Revision-reuse indices and default page ranges must stay unchanged.

### Task 1: Directory continuation and durable resume

**Files:** Create `backend/src/modules/script/script-source-map-output.ts`; update shared source types, source-analysis caller, checkpoint resume messages, safe alias normalization and optional pagination recovery filter. Add helper and integration regressions.

**Interfaces:** `generateSourceMapOutput(prompt, selected, generate, { signal, budgetMs, checkpoint, persist, onAttempt?, onProgress? }): Promise<SourceMapResult>`. Existing `output_checkpoint` gains optional `pages` with the established generation checkpoint shape.

- [x] Add failing tests for closed-prefix recovery, restart, invalid boundaries and bounded exhaustion.
- [x] Implement the helper using `generateStructuredOutput`, `recoverArrayStream`, `createGenerationSteps` and `generatePagedReviewItems`.
- [x] Integrate without changing fixed work ranges; surface saved private item counts on resume.
- [x] Verify helper tests, full-source integration, checkpoints and revision reuse.

### Task 2: Validation and evidence

- [x] Review the patch independently for premature publication, lost progress, repeated calls and compatibility.
- [x] Run related backend regressions and the project build, sequentially where shared build output is touched.
- [x] Record actual failure evidence and distinguish simulated recovery from real-provider success.

Commit and push are outside this turn's requested scope.
