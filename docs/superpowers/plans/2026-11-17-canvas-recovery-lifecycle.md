# Canvas Recovery Lifecycle Implementation Plan

> **For agentic workers:** Execute natively in this session, task by task; user explicitly requests direct main implementation and isolated verification. No delegation, commits or pushes.

**Goal:** Restore a usable, authoritative recovery path for the selected canvas preparation run without replaying an unknown paid request.
**Architecture:** Reconcile durable run receipts, scoped response checkpoints and execution ownership. Separate status inspection, cancellation and explicitly acknowledged abandonment; preserve run isolation, cumulative budgets, adoption and idempotency. Frontend capabilities come from this reconciled status.
**Tech Stack:** Fastify, TypeScript, SQLite, React, Mantine, Node test runner.
**Spec:** Current user delegation: same project/design/scenes/run binding; no production state edits or real provider calls; no commit/push.

## Global Constraints
- Work directly in /Users/caoyanzu/workspace/ai-video-creation-tools on main; preserve existing changes and data.
- Read production state and Langfuse only. Mutate task/checkpoint fixtures only in temporary databases.
- No real model calls, production cancellation, checkpoint repair, commits or pushes.
- Timeouts and missing responses are not proof of provider failure or cancellation.
- Preserve budgets, explicit adoption and completed results; keep requested footer text removed.

## Review Focus
- A retired executor must not leave a settled partial or complete result permanently locked.
- An actually active owner must block competing work while allowing status inspection and a real cancel request.
- An unresolved accepted response stays unknown after local abort; abandonment must require explicit acknowledgement and no live owner.
- Historical unknown responses must not block a valid selected run or a different project/design/scene scope.
- Reopen and duplicate clicks must preserve authoritative state and request identity.

### Task 1: Establish evidence and regression
**Files:** web/test/canvas-recovery-integration.test.tsx; read-only production evidence saved under /private/tmp.
- [x] Add and run stale-running status API → React → retry regression; record red output.
- [x] Read the selected durable run, request records, server process and matching Langfuse metrics without changing state.

### Task 2: Reconcile ownership and scoped recovery
**Files:** backend/src/modules/canvas/canvas-preparation-runs.ts; backend/test/canvas-preparation-runs.test.ts; packages/shared/src/api/contracts.ts.
- [x] Add explicit execution ownership and inspection information; distinguish live, retired, settled and unresolved cases.
- [x] Reconcile settled completion/partial receipts without issuing provider calls; scope pending detection to selected run.
- [x] Test stale running, live execution, complete plus historical unknown, scope isolation and idempotent receipts.

### Task 3: Implement explicit recovery actions
**Files:** backend/src/modules/canvas/script-canvas-preparation.ts; web/src/features/storyboard/useCanvasPreparationRecovery.ts; ReferencePreparationRecovery.tsx; StoryboardProductionDialog.tsx; StoryboardPlanner.tsx.
- [x] Expose status and guarded cancellation; report cancellation uncertainty truthfully.
- [x] Permit explicitly acknowledged abandonment only with no active executor, an isolated new run and a durable idempotent request.
- [x] Keep status inspection enabled under unknown/running, align local uncertainty with authoritative status and show actionable controls.

### Task 4: Verify full recovery paths
**Files:** web/test/canvas-recovery-integration.test.tsx; web/test/storyboard-production.test.tsx; backend/test/canvas-preparation-runs.test.ts.
- [x] Exercise all user acceptance cases through actual status APIs and UI with fake providers and temporary databases.
- [x] Run focused regression tests, types, architecture/UI checks and build.
- [x] Check rendered dialog controls and requested footer removal with Ego Lite; report current cause, evidence and limitations only.


## Verification result
- Implementation location: `/Users/caoyanzu/workspace/ai-video-creation-tools`, branch `main`; existing edits preserved, no commit or push.
- Read-only production evidence: `/private/tmp/canvas-recovery-current-evidence.json`. The inspected selected run was partial and recoverable, with settled responses and a finished Langfuse task; the prior screenshot alone does not prove an active upstream request.
- Backend focused regression: 94 passed, 0 failed, 1 skipped (private historical replay fixture unavailable).
- Frontend focused regression: 111 passed, 0 failed; includes 12 real API → React cases using temporary SQLite and a fake provider.
- Added source-revision cumulative-ledger checks, adoption value comparison independent of object key order, and close-live → reopen → reuse/adopt verification.
- Saved business fingerprints can reuse adopted references even though saving changes the pre-adoption signature. A genuine source change requires an explicit restart.
- Ego Lite checked running progress, direct inspection/stop controls, unknown-response warning/confirmation, and 320px/390px layouts without horizontal overflow. No real recovery action or model call was performed.
- Full production build includes architecture, UI component, shared/backend/web TypeScript and Vite checks. Existing bundle-size warning remains.
- Production database, provider requests and checkpoints were not changed by the diagnosis or fixtures. Temporary preview server and Ego task space were closed.
