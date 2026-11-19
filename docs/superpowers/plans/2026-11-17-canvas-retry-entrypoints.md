# Canvas Retry Entrypoints Implementation Plan

> **For agentic workers:** Execute the bounded tasks below natively in this session. User explicitly authorized implementation and offline verification; do not pause for another plan approval or delegate work.

**Goal:** Make row retry, batch failure retry and a scoped new visual-preparation run discoverable, durable and safe.

**Architecture:** Keep validated unit checkpoints and original response bindings. Add a preparation-run manifest in the existing checkpoint store; wrap provider execution with persistent per-run and task-wide usage ledgers. New runs use distinct namespaces and never clear old budgets or results. Return explicit recovery capabilities and restore the active preparation through a read-only status endpoint.

**Tech Stack:** TypeScript, Fastify, SQLite checkpoint store, React/Mantine, node:test/JSDOM.

**Spec:** User delegation in this chat on 2026-11-17, six acceptance requirements for canvas preparation recovery.

## Global Constraints
- Work directly in main; preserve existing changes and data; no commits/pushes.
- Use fake providers and temporary databases only; no real paid calls.
- Preserve PROP-FRIED-NOODLE, PROP-BRONZE-GONG, PROP-WOOD-CLAPPER.
- New runs only regenerate visual reference preparation for selected scenes; no screenplay/storyboard regeneration or canvas/asset deletion.
- Unknown/in-flight delivery blocks competing actions. No checkpoint or budget deletion.

## Review Focus
- Five validated siblings and three rejected props: bulk retry creates only three new attempts.
- Duplicate requests and reopen: stable intent IDs recover the original action.
- Restart with unknown delivery: deny before provider dispatch and explain the reason.
- Restart completion/cancellation: preserve existing business records until explicit adoption.
- Long lists/narrow screens: visible row actions, deliberate footer stacking and bounded scrolling.

### Task 1: Recovery API and run accounting
**Files:** shared/api/contracts.ts; backend/modules/canvas/canvas-preparation-runs.ts; script-canvas-preparation.ts; visuals/visual-profiles.ts.
**Interfaces:** prepare accepts run_id, request_id, retry_units and restart_from_run_id; response includes preparation capabilities; recovery endpoint returns current plan and reasons.
- [x] Add failing API fixture tests for five complete and three failed props, batch retry, idempotency and isolated restart.
- [x] Implement durable run/action receipts, explicit namespace versioning, per-run/task budgets and unknown-delivery guards.
- [x] Retain all existing validation/adoption logic and protect completed new-run adoption with run identity.
- [x] Run API regressions using temporary DB and fake provider; verify old response entries and business rows remain unchanged.

### Task 2: Visible actions and restored state
**Files:** ReferenceFailurePanel.tsx; reference-failure.ts; useCanvasPreparationRecovery.ts; StoryboardProductionDialog.tsx; StoryboardPlanner.tsx; associated CSS.
**Interfaces:** consume preparation capabilities/plan; generate one persisted request_id per explicit user action; keep failure details collapsible.
- [x] Add failing UI tests for visible row retry and bulk retry when all three failures need new attempts.
- [x] Add low-emphasis restart with scope/usage explanation, explicit confirmation and a separate adoption step for completed fresh results.
- [x] Restore preparation state from the API on reopen; close/later actions never imply an import.
- [x] Exercise real isolated API responses through both UI actions; assert request bodies and absence of accidental commits on partial results.

### Task 3: Final verification
- [x] Run focused UI and expanded backend regressions, types, UI/architecture guards and full build.
- [x] Verify main and diff hygiene; report only this recovery closure and its remaining limits.

## Completion Evidence
- Implemented directly in `/Users/caoyanzu/workspace/ai-video-creation-tools`, branch `main`; no commit or push. Existing unrelated changes remain in place.
- Frontend: 106 passing tests, including eight real Fastify API-to-React integrations using temporary databases and fake providers. Both dialogs exercise visible row retry, three-item bulk retry, preserved successful siblings, reopening and separate fresh-result adoption. Unknown outcomes and exhausted budgets disable competing UI actions.
- Backend: 122 passing tests and two existing skips. Includes six run coordinator tests for durable receipts, concurrency, process/source changes, cancellation, unresolved responses, request/token admission, per-run limits and cumulative budgets.
- TypeScript no-emit checks, architecture/UI guards, `git diff --check` and `npm run build` passed. Build retains the existing Vite chunk-size warning.
- Cancellation ownership is tested directly with AbortController; app.inject UI integration does not claim to simulate a socket disconnect. Unknown responses stay blocked for inspection, without automatic resend or historical checkpoint deletion.
- All model transports were fake and all application data used by the tests was temporary. No production records, checkpoints or budgets were cleared.
