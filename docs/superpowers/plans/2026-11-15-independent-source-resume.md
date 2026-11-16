# Independent Source Resume Implementation Plan

> Execution: native implementation with parallel backend and UI workers. The user has authorized implementation on main; no additional model dispatch, record cleanup, commit or push is authorized. Referenced optional sub-skills are unavailable; use the current native tools and targeted regression tests.

**Goal:** Let an explicitly continued, genuinely new story task use its own ordinary request while keeping old unknown requests and their dedicated permits protected, and present one actionable current status.

**Architecture:** Persist a private ordinary continuation grant on the explicit analysis POST, bound to run, effective source, configuration, feedback and existing protected tasks. An initial-attempt producer proof binds logical task and exact request; the recovery adapter rechecks it before dispatch and never borrows a sibling epoch. Render current status separately from one collapsed, lossless diagnostic disclosure.

**Tech Stack:** TypeScript, AsyncLocalStorage, SQLite transactions, Fastify, React/Mantine, node:test.

**Spec:** The current delegated user request: resolve `source_request_sibling_pending` for independently authorized new work; preserve all 16 saved results and unknown-request protection; one current stage, one reason, one actual next action; full technical details collapsed; distinguish materialized tasks from workflow completion.

## Global Constraints
- Develop and verify in `/tmp/source-sibling-resume-20261115/mirror`; hash-check the incremental main application.
- No paid or real provider requests; no unknown-request resubmission; no model changes, Langfuse cleanup, commit or push.
- Local-only adoption of an already saved response is authorized through the revalidation button after offline proof; do not manufacture a paid grant or abandon an unknown request.
- Preserve the successful results and request ledger captured immediately before each change. The first capture had 16 results / 46 requests; the current capture has 19 results / 50 requests.

## Review Focus
- A changed prompt or format correction for an old logical task cannot impersonate a genuinely new task.
- Prepared permits, unresolved dispatched requests, and ordinary explicit continuation are separate conditions.
- Revoked, stale or replaced authorization fails at the final dispatch boundary without partial permission consumption.
- Read-only GETs, queued restarts and automatic start/revision paths never manufacture an explicit continuation decision.
- Hidden details retain full current/historical diagnostics; default UI never mixes stale progress with current materialized task counts.

### Task 1: Independent dispatch identity and ordinary grant
**Files:** source-story-dispatch-identity.ts, source-model-recovery.ts, script-source-story-parts.ts, script-source-ordinary-dispatch.ts, script-source-analysis.ts, shared script-source-document.ts; focused recovery/grant tests.
- [x] Add failing pairs for no grant versus valid independent grant, exact producer proof, changed identity, unknown siblings, correction attempts and final-boundary revocation.
- [x] Add a first-format-attempt producer proof and isolate ordinary requests from the sibling supersession path.
- [x] Persist private grants only for explicit analysis POSTs; protect completed/previously attempted logical tasks and bind dispatch to current run/source/config/feedback.
- [x] Test restart persistence, automatic entry exclusion, active-request guards and unchanged original/sibling ledger records.

### Task 2: Public status and UI
**Files:** script-source-documents.ts, script-source-story-progress.ts, ScriptSourceAnalysisView.tsx and presentation helper; route and UI tests.
- [x] Return an executable continue action for safe, not-sent new work while retaining reconciliation for unknown delivery.
- [x] Strip the private ordinary grant from all public status routes; assert GET does not mutate state or ledger.
- [x] Default to one phase, one short human explanation and one next action. Place full identifiers, request details, previous progress and raw diagnostics in one collapsed technical disclosure.
- [x] Cover failed, paused, running, queue, poll failure, ready, format exhaustion, reconciliation and dynamic 16/17 task counts with visible-DOM assertions.

### Task 3: Integration and delivery
- [x] Capture current main data read-only and replay it in an isolated database with provider calls mocked; preserve all 16 results and old permits.
- [x] Run targeted backend/web, type and architecture checks; review the coherent increment.
- [x] Verify idle main and baseline hashes, apply only the increment, inspect actual page in Ego Lite using GET/UI navigation only.
- [x] Report code and UI verification separately from unexecuted paid merge/quality work; no whole-suite pass claim.


## Verification (2026-11-15)
- Applied the 19-file increment to `/Users/caoyanzu/workspace/ai-video-creation-tools` on `main` after checking every changed file against the captured baseline. Existing unrelated edits were retained; no commit or push.
- Backend expanded regression: 443 passed, 1 skipped optional captured-checkpoint fixture, 0 failures. Separate real-analyzer concurrency group: 6/6 passed. Frontend status/request-recovery: 30/30 passed.
- Main verification: backend/web TypeScript noEmit, architecture and UI component checks passed; 78 targeted tests passed.
- The captured 16/17 snapshot replay passed with zero external fetches. A second mocked replay expanded nine new merge tasks and reached the initial quality review; original 46 request rows and the old prepared epoch remained unchanged. This proves routing and isolation, not model content quality.
- Main GET now advertises `continue` for the genuinely unstarted merge. Eight protected business-table fingerprints remained identical after application; real status remained failed at 16/17 materialized tasks.
- No tool-initiated real model calls or business continuation POST, old JSON adoption, request abandonment, epoch consumption or Langfuse cleanup were performed in this change.
- Ego Lite inspected the live main page: current phase and one enabled continue action were visible; details were collapsed by default. Expanding retained the complete task hash, protected request key, historical 13/21 progress and full diagnostics. Details were collapsed again; no generation action was clicked.


### Task 4: Ordinary initial response and its one not-sent correction
Observed after the first deployment: a separately started live run advanced from 16/17 to 19/20, saving three additional valid merge results and one complete initial reply. The first correction for that new reply was still incorrectly blocked by the old sibling permit. No correction POST was sent; its complete original reply and frozen correction identity are retained.
- [x] Bind the one derived correction to a precise completed ordinary initial request, its original response hash, candidate and frozen correction input; recheck at dispatch.
- [x] On a new explicit continuation grant inherit only the unconsumed correction eligibility from the prior ordinary grant; never lift initial-request protection or old candidate/unknown guards.
- [x] Persist the same boundary for the first direct quality review; existing quality/repair or unsupported page corrections retain their established protection.
- [x] Replay the actual new snapshot offline, rerun relevant regressions, apply the additional increment and recheck the live status without starting another model request.


### Task 5: Reuse valid saved bytes before requesting more model usage
The later 19/20 snapshot contains valid JSON. Its two complete names occupy one model character record, and the cited original section explicitly names the single character 黑水龙王/九门尸魁. The existing coverage check incorrectly rejected the slash label. Fix this evidence-bound local check before considering the derived correction path.
- [x] Accept exactly two slash-separated directory names only when both complete names are retained in one model record and the cited section supports the complete compound identity; preserve other evidence and alias boundaries.
- [x] Add a local-only revalidation endpoint, independent of model selection. Bind it to the current analysis/source/configuration; use a pure completed-response reader that cannot create a run, ledger entry or provider request.
- [x] Replay the real 19/20 snapshot with all external fetches and provider calls forbidden: reuse one saved response, retain the original 19 successful results and 50 request rows, and pause at 20/21 when a new response is genuinely needed.
- [x] Keep locally initialized, unsent empty tasks eligible for a later explicit ordinary generation decision; unknown or already used requests remain protected.
- [x] Render the current three phases, saved-task count, local validation summary and one main action in a compact rounded card. Group technical fields, allow identifier copying/wrapping and disclose diagnostics separately.
- [x] An empty recovery list refreshes the latest analysis with GET and closes; it must not fabricate a recovery decision or send a generation POST.
- [x] Complete independent local-only regressions, hash-check and apply the increment to main.
- [x] Use Ego Lite to click the live local-only action, inspect the narrow card/details, and verify preserved request/recovery records. Do not confirm any new model generation.


## Final verification of the local-only path (2026-11-15)
- The second 25-file increment was hash-checked against the first deployed baseline and applied to main; a later scoped CSS adjustment reduced the technical-details height. Unrelated main changes were preserved. No commit or push.
- Latest coherent backend regression: 364/364 passed, including six local revalidation tests for zero network/provider use, unchanged request/run/recovery records, stale entry and midflight binding changes, concurrent ownership, retained unknown/used outputs, and later explicit continuation of local empty tasks. Frontend status/recovery tests: 37/37 passed. Backend and frontend type checks, architecture and UI guard passed. Main production build passed; the final CSS also received a fresh frontend build.
- The real 19/20 snapshot replay reused one valid saved character response locally and reached 20/21 with zero fetches/provider calls. It preserved all original 19 task records and 50 request rows, the ordinary grant, directory and recovery tables. Subsequent work requires a genuinely new model response; current task counts are materialized work, not total workflow completion.
- Ego Lite performed the actual main-page local revalidation button path. The real analysis retained its id and is now paused at 20/21 with local_validation.reused_tasks=1. All nine non-analysis protected business-table fingerprints remained unchanged, including request/run/response ledgers, source document, recovery actions/epochs/resolutions/links/events. The original 365-character upstream response remains in the unchanged completed request row.
- Ego Lite verified the next-generation confirmation and cancelled it. No new generation was confirmed. It also checked the 411px sidebar with details open, actual detail scrolling, and a 650px-high viewport; there was no horizontal overflow and the input remained usable. A discovered detail-expansion input squeeze was fixed locally before completion.
- Empty recovery-list refresh is covered by component tests; the actual live page now goes directly to local revalidation rather than opening that empty modal. No live empty-modal interaction is claimed.
- No new paid provider request, unknown-request abandonment, permit consumption, model change or Langfuse cleanup occurred. The live page is retained for the user at the paused local-validation result.
