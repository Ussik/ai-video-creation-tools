# AI Integration Reliability Implementation Plan

> **For agentic workers:** Implement each task with focused behavioral tests and independent review. Steps use checkbox syntax for tracking.

**Goal:** Make every AI entry participate in durable request identity, error/recovery and result observation, while retaining useful candidates and validating media before delivery.

**Architecture:** Extend the recovered execution layer and domain checkpoint stores. A common operation boundary owns HTTP intent and response recovery; existing director/source/storyboard/jobs continue to own long-running execution. Candidate review evidence and local media stages are subordinate artifacts, not parallel task engines.

**Tech Stack:** TypeScript, Fastify, SQLite, React/Mantine, existing provider adapters and local FFmpeg.

**Spec:** `docs/research/2026-11-13-ai-integration-reliability-audit.md`, reconciled against merged main `2c2b700`.

## Global Constraints

- Preserve every model/provider mapping, explicit reasoning and capability setting, source guard, creator confirmation and old recoverable task.
- No application cumulative request, token, repair-round or business-duration caps for script creation/source analysis.
- Never automatically repeat an uncertain paid submission; explicit new operation IDs permit intentional identical-input generation.
- No live paid requests, formal project writes, deployment, process restart or automatic trace upload in verification.
- Keep existing transport retry, semantic progress/cycle detection and cancellation policies.

## Review Focus

- Accepted request followed by lost HTTP response must return the same retained result through lookup without a second model call.
- Source/config/version409 and cancellation must propagate without paid format correction.
- Complete candidate with failed review must remain editable and re-reviewable, while stale/forged review cannot authorize application.
- Downloaded HTML, truncated/audio-only files and late cancelled results cannot become successful video assets.
- Repeated submission with one identity is replay, while explicit new identity remains a valid new candidate request.

---

### Task 1: Shared operation and error boundary

**Files:** Create `packages/shared/src/api/ai-operations.ts`, `backend/src/modules/generation/ai-operations.ts`, `ai-operation-errors.ts`; modify `backend/src/app.ts`, `model-request-observation.ts`, `gemini-image-analysis.ts`; tests `backend/test/ai-operations.test.ts`, `model-output.test.ts`.

**Interfaces:** Consumes existing model context/observation. Produces operation lookup/list/cancel APIs and allowlisted machine error fields; operation response storage precedes delivery. Request identity is `x-ai-operation-id`, scoped to project plus normalized request fingerprint. Long domain task IDs remain separate.

- [x] Add regressions for lost response, concurrent replay, identity/payload409, explicit new identity and interrupted unknown result with no replay.
- [x] Implement SQLite request reservation and result persistence; add shared AI-route inventory so all current AI route families are covered.
- [x] Preserve category, code, operation/task identity, certainty, diagnostics and safe recovery actions through error serialization.
- [x] Include native Gemini auxiliary requests in existing observation. Bind source-analysis background work to durable observation and Responses recovery; prevent uncertain automatic step resubmission.
- [x] Run operation/error/source recovery tests and TypeScript checks.

### Task 2: Retained and verifiable candidate quality

**Files:** Modify scene and clip storyboard planning/workflow/task/routes + shared storyboard DTOs; skills refinement semantics/evidence/routes; new focused review/repair helpers; corresponding backend tests.

**Interfaces:** Complete results expose quality `passed | needs_work | inconclusive` independently from execution success, retaining reports and candidate version. Review receipts bind exact candidate, source and context. Review-only retry does not regenerate. Targeted repair patches authorized shot indices and preserves all unaffected shots.

- [x] Reproduce complete second-review defect, reviewer transport failure, unresolved evidence and manual-edit bypass.
- [x] Preserve candidate and report before evidence processing; distinguish confirmed/withdrawn/unresolved; expose review-only resume.
- [x] Return editable needs_work/inconclusive outcomes; require current review evidence for formal apply while preserving idempotent commit replay.
- [x] Repair only evidenced shot targets with adjacent context, then run deterministic/global checks and independent review.
- [x] Run storyboard/refinement/source-freshness regressions.
- [x] Close the same candidate-loss and fresh-commit approval gap in independent clip storyboards, preserving historical idempotent replay.

### Task 3: Verified and recoverable media execution

**Files:** Create media-result-validation/media-execution/job-local-results; modify provider media section, speech-provider, job-generation-recovery; integrate in app worker and speech worker; corresponding provider/recovery tests and real local media fixtures.

**Interfaces:** `withMediaExecution({signal,beforeDispatch,onLocalResult},work)` persists dispatch intent immediately before paid fetch and validated local result before final DB commit. Existing request observation remains authoritative. Ready local files carry hash/size/metadata and are revalidated before takeover.

- [x] Verify HTML/JSON/audio-only/truncated files fail video delivery, valid MP4 decodes, cancellation propagates.
- [x] Separate local prepared work from possible paid dispatch; persistence failure prevents POST and unknown dispatched results never auto POST.
- [x] Persist and reuse validated local results after DB failure; retain remote IDs/URLs, refresh expired URL once by querying original task only.
- [x] Preserve stable TTS request IDs and failure evidence; guard final writes against cancellation/changed ownership.
- [x] Run mocked provider and restart/failure-injection tests, with local FFmpeg only.

### Task 4: Frontend recovery and quality workflow

**Files:** Modify shared API client, add operation identity/lookup helper; integrate TaskRecords, StoryboardPlanner, PromptSkillAction and shared response types; focused web tests.

**Interfaces:** Uses Task1 inventory/header/lookup; pending intent survives refresh, successful completion clears pending identity, explicit new generation gets new identity. Domain task refresh and cancellation stay with their current APIs. API errors preserve machine fields without arbitrary object spreading.

- [x] Test refresh/response loss recovers same operation without POST replay; new user intent gets a new identity.
- [x] Integrate durable short-operation lookup and retain legacy backend response compatibility.
- [x] Show operations alongside existing media jobs, with current stage, retained candidate and supported recovery action.
- [x] Keep quality-failed complete candidates editable/reviewable; edits retain historical issues but invalidate approval; formal apply requires current review receipt.
- [x] Run API/error/operation/task UI and source-staleness tests.

### Task 5: Integration and delivery

**Files:** Update audit coverage evidence, task plan and current user-facing reliability notes.

- [x] Cross-review all changes; exercise every inventory family through shared boundary tests and targeted domain fault injection.
- [x] Run final full build, architecture/UI checks, backend and web regression suites after shared build.
- [x] Record actual verified behavior and limits; keep live-provider quality/latency claims explicitly unverified.
- [x] Commit enhancement on its branch after verification; preserve main as the reviewed base and do not merge/deploy enhancement implicitly.

## Final verification

- Full backend: 3232/3232. Full web: 1703/1703. Tooling: 3/3. Unified build, architecture/UI guard and diff checks passed.
- The final web fixture starts with the required project script card, isolating its asset-save assertions from the independent legacy startup migration. No production behavior or business assertions were weakened.
- Review checkpoint ownership and persistence failures were independently reviewed; candidate persistence failure prevents subsequent paid review.
- Runtime/provider quality and latency remain unverified without paid integration calls. Prompt refinement retains normal review-failure candidates and final responses, but has no public in-review crash-candidate recovery path.
