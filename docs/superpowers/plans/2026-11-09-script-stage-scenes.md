# Script Stage Scene Validation Implementation Plan

> **For agentic workers:** Implement in this session, preserving the existing working tree.

**Goal:** Prevent non-episode creation from requesting scene data, recover a complete draft once without rewriting its prose, and explain unrecovered errors clearly.

**Architecture:** Use stage-specific examples and wire schemas. Quarantine a complete otherwise valid non-episode response containing scenes, request one explicit correction, and accept it only if every document title and body stays unchanged. Preserve the original candidate for resume if correction fails.

**Tech Stack:** TypeScript, Zod, Node test runner, React.

**Spec:** User request in this chat: optimize the unexpected “本轮未完成” scene-stage validation error during outline generation.

## Global Constraints

- Preserve existing edits, saved documents, original manuscripts and stage acceptance checks.
- Do not silently remove creative data or mark rejected output successful.
- Do not retry corrections indefinitely or change model settings.

## Review Focus

- Extra scenes alongside otherwise complete outline documents: correct once and preserve exact prose.
- Invalid scenes, missing documents or conflicting content: reject without bypassing validation.
- A failed correction followed by resume: retain the original candidate.
- Episode creation: continue requiring real scenes with complete scene fields.
- Historical raw validation errors: show readable reasons without changing stored records.

### Task 1: Stage contracts and controlled recovery

**Files:** `backend/src/modules/script/script-workflow.ts`, `script-stage-continuation.ts`, `script-document-tools.ts`, new `script-stage-scene-repair.ts`, associated backend tests.

- [x] Add regression coverage for stage-specific examples/contracts and scene mismatch recovery, failure and resume.
- [x] Provide scene examples only for episode creation and remove scene item details from other stage contracts, including explicit Function Calling workflows.
- [x] Quarantine complete extra-scene candidates and request one correction with exact artifact comparison.
- [x] Reject truncated envelopes containing quarantined scenes before completion or continuation; retain the original data.
- [x] Run focused backend regressions, API integration with an isolated database, and TypeScript/build checks.

### Task 2: Readable failure display

**Files:** `web/src/features/script/script-display-text.ts`, related presentation tests.

- [x] Map the historical scenes validation JSON and current contract diagnostics to a clear Chinese explanation.
- [x] Verify historical message rendering, mixed diagnostics and unrelated text.
- [x] Review final changes and run repository checks.

Validation: stage generation, continuation, checkpoint compatibility, document tools, workflow integration and failure rendering regressions passed. `npm run build` passed. Independent review found the truncated-envelope bypass, which was reproduced in a failing regression and fixed. Real-model behavior has not been rerun.
