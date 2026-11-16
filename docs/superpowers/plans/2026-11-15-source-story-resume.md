# Source Story Resume Implementation Plan

> Execution: native implementation in this session; user has authorized implementation and application to main. No commits or live provider calls.

**Goal:** Recover and explain the 14/16 story synthesis stop without losing complete answers or resetting paid correction allowances.

**Architecture:** Keep exact logical-task candidates and immutable initial/correction identities. Read completed ledger results before considering dispatch; permit no sibling to consume another task's recovery epoch. Normalize only the known lossless uncertainty envelope and keep the semantic validation gate.

**Tech Stack:** TypeScript, Zod, node:test, React, SQLite read-only production snapshots.

**Spec:** Current delegated user request: uncertainties:0/2 recovery, candidate durability, epoch isolation, truthful progress/actions.

## Global Constraints
- Develop and test in /tmp mirror of actual main, hash-check each applied file.
- No model requests, model changes, unknown resubmission, business data/checkpoint mutation, trace deletion, commit or push.
- Preserve f525b870ee3362e4bb88427c397b68105d461498c39d408ad372473360af2933 and its prepared epoch unchanged.

## Review Focus
- Conflicting aliases, unknown fields, invalid source IDs and semantic errors remain rejected.
- Diagnostic changes cannot reset a correction or initial dispatch guard.
- A saved syntax-invalid complete response remains inspectable and never becomes accepted empty data.
- Independent completed siblings replay without modifying the pending epoch; new dispatch remains guarded.
- Public progress contains no raw outputs and disables exhausted no-op continuation.

### Task 1: Durable candidate and correction identities
**Files:** model-output.ts, model-output-checkpoints.ts, script-source-story-parts.ts; checkpoint and part recovery tests.
- [x] Reproduce repeated failure, lost baseline replay and correction-diagnostic drift with offline generators.
- [x] Retain candidates, freeze correction request, guard initial dispatch and preserve exact identity.
- [x] Replay exact baseline legacy responses into durable candidates without issuing provider calls.

### Task 2: Lossless uncertainty compatibility
**Files:** script-source-uncertainty-output.ts and focused normalization/real-sample tests.
- [x] Map the exact summary/explanation/source/current-state envelope to description and union IDs, preserving all text and evidence roles privately.
- [x] Require true source IDs in the current batch and preserve semantic gate; reject conflict, overflow and syntax-invalid JSON.

### Task 3: Epoch isolation and public progress
**Files:** source-model-recovery.ts, script-source-checkpoints.ts, shared source types and status view; recovery, route and web tests.
- [x] Isolate completed sibling replay from pending permits, retain global dispatch barrier.
- [x] Return actual task counts, remaining keys, valid recovery action and current diagnosis.
- [x] Retain textual output requirements for source contracts with native schema, without changing saved request hashes.

### Task 4: Delivery
- [x] Replay both real samples, run focused and expanded tests against refreshed baseline.
- [x] Compare database fingerprints, verify idle backend, hash-check and apply only changed files to main.
- [x] Run main targeted/type/architecture checks; report real remaining blockers.

## Stage 1 checkpoint: regression audit complete
- [x] Compare the existing whole-suite logs by qualified TAP case, not just counts: 22 added failures, 18 top-level cases.
- [x] Replace inspection-only generator exceptions with verified persistence pauses before dispatch; keep unknown failure/cancellation paths protected. No ambiguous error was relabelled not_sent.
- [x] Preserve consumed correction evidence and assert zero repurchase; add provider-fact and sibling-epoch guard matrices.
- [x] Directed affected files: 91 passed / 1 existing baseline failure. Safety suites: 67/67 passed. Individual mapping: /tmp/source-story-resume-20261115/stage1-added-failure-audit.json.
- [x] Completed Stage 2: assessed the late-response assertion, ran the necessary checks, applied the verified increment and verified actual main.

Historical Stage 1 result: main was not yet changed at that stage. Main delivery and live verification are recorded below.

## Stage 2: main delivery and current-case verification
- [x] Confirm actual main is still the baseline and current failed analysis has the same 65-section directory and 14/16 saved task results.
- [x] Resolve the baseline deadline assertion: retain late complete bytes privately; assert no late adoption, scope escalation, correction or other state mutation.
- [x] Exercise public GET routes at 14/16 and 15/16; frozen prompts/raw/allowances stay private and GET does not mutate checkpoints or the ledger.
- [x] Current-case isolated replay: 0 provider calls, 15/16 simulated, original correction/unknown permit intact; uncertainties:2 remains strict JSON syntax failure at position 78, line 4, column 50.
- [x] Targeted backend 233/233, web 28/28, both noEmit checks and architecture check passed. No whole-suite rerun or whole-suite pass claim.
- [x] Hash-check and apply only the listed incremental files to actual main; verify health/UI and unchanged business database.
- [x] Report the code delivery separately from actual business completion. No unknown resend or paid repair without explicit authorization.

## Main delivery result — 2026-11-15
- Applied 26 listed files on actual main with before/after hashes; all 1,651 inspected repository files outside the patch were unchanged.
- Immediate pre/post application database fingerprints matched across all 83 tables. No analysis/resume/repair POST was issued by this verification.
- Main validation: 30/30 backend targeted cases, 20/20 web targeted cases, latest captured case replay 1/1 with zero provider calls, backend/web noEmit and architecture check passed.
- The temporary replay harness first needed an ESM (.mts) extension outside the repository; the corrected harness passed. This was not a product failure.
- During live verification the stored analysis advanced from cd9be8734da54d1f8f8886056d43d11d (14/16) to 315a1dda6a8e4658843dd1bdea877860 (15/16). Therefore the final database is not claimed globally unchanged. All 46 source request rows and the recovery epoch remained byte-equivalent to the captured pre-UI rows.
- Ego Lite observed actual 15/16, uncertainties:2 pending, the disabled exhausted-correction action, and the retained uncertainties:0 unknown-response notice. No analysis action was clicked; the verification space was closed.
- Remaining business blocker: the stored 485-character correction is invalid JSON at position 78, line 4, column 50. It was not edited, accepted, regenerated or replaced with empty data. Story synthesis and independent quality validation remain incomplete.
- Main delivery is complete; 16/16 business completion is not. Any manual format correction or additional paid repair is a separate explicit action. No commit or push was performed.

## Explicitly approved manual format adoption — 2026-11-15
- User approved: “允许采纳本地格式修正，继续校验”. This supersedes the earlier prohibition on adopting this one manually corrected candidate; no new model call or trace deletion was authorized.
- Applied the exact reviewed candidate: 4 literal quotation pairs received 8 backslashes. All original characters remain in order; descriptions and section references were not rewritten. Original model and correction responses remain unchanged in their private checkpoints.
- Ran existing native task validation on all 16 retained task results, with network disabled and provider dispatch forbidden. Other 15 task checkpoints/results were deep-equal, and all section data and existing work remained unchanged.
- Continuing native synthesis revealed a previously unmaterialized duplicate-character merge. It has no exact completed ledger response. The run stopped at task creation, before any initial-dispatch marker or provider call. An earlier dry-run input included document metadata and was corrected to the exact filename/content identity before native validation; it did not change production state.
- Current persisted analysis remains 315a1dda6a8e4658843dd1bdea877860, now paused: 16/17 materialized tasks complete; remaining characters_merge:4a8cd8695e420e16203944af82a4e897e5202e78b88d33dcc0f98a4fb05a473e. This count is the materialized task count, not a guarantee that no later merge/review work exists.
- CAS transaction updated only script_source_analyses and added one private source-manual-format audit checkpoint with original task, candidate, hashes and user decision. Post-write read-back matched. All other 81 business tables, all 46 request rows, and the prepared recovery epoch were unchanged.
- Public API verified 16/17, remaining 人物归并, action continue, no raw/prompt/private audit leakage. No continue/model action was invoked. Story assembly and independent quality review have NOT completed.
- This was an audited one-case administrative recovery, not a general product recovery entry. The UI still lacks a general reviewed local-format candidate preview/adoption path for exhausted corrections. A correction allowance must constrain automatic paid dispatch without preventing local checks and confirmed format-only adoption; ambiguous syntax and domain validation must remain guarded.
- Completion claim: the approved uncertainties:2 format adoption is complete. The full business workflow and generic recovery UX remain incomplete. No model request, unknown-request resubmission, recovery-allowance consumption, commit, push, or Langfuse cleanup occurred.
