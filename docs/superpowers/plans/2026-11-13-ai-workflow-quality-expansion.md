# AI Workflow Quality Expansion Implementation Plan

**Goal:** Apply the existing reliable model integration to all AI features and measure business quality separately from execution.

**Architecture:** Reuse existing provider adapters, capability evidence, durable domain tasks and checkpoints. A shared isolated LangGraph helper routes complex bounded workflows. Common result/stage reporting and dispatch admission extend the current Langfuse and usage scopes.

**Spec:** docs/superpowers/specs/2026-11-13-ai-workflow-quality-expansion.md

## Global Constraints

- Baseline e1fe35e, current branch codex/langfuse-observability; preserve prior evidence and never change selected models/reasoning silently.
- No duplicate retry/checkpoint or paid-generation replay; existing strict source/identity/approval gates remain.
- Fixed enums and numbers only in exported business result metadata; no prompt, output, credentials or reversible identity.
- Root owns this plan, tracing contracts, integration and acceptance; workers own nonoverlapping files.

## Review Focus

- Valid unrelated creative content must survive every repair.
- Broken outlines must be corrected before dependent expansion and may not be frozen as truth.
- Deleting required fields in review suggestions cannot become authorized edits.
- Cancellation and late settlement cannot roll back restored state or dispatch more work.
- Quality failure/inconclusive remains distinct from execution completion. Preserve existing independent review gates and explicit creator confirmation; do not invent a semantic pass for structure-only APIs.

### Task 1: Public stages, result diagnostics and capability admission

- [x] Add typed stage/result reporting to model request context; observe structure and quality independently of transport.
- [x] Extend bounded local Langfuse export and local observation diagnostics with fixed safe enums/numbers.
- [x] Reuse selected-channel capability evidence and preserve typed protocol/network/delivery errors at actual adapters.
- [x] Cover nested scope, late result ownership, auxiliary/paid transports and default compatibility with tests.

### Task 2: Complete the storyboard sample

- [x] Add bounded outline review before expansion with durable accepted checkpoints.
- [x] Repair faulty outline state only from validated evidence and invalidate only affected dependent work.
- [x] Validate review recommendations against fixed edit scope/schema; stop repeated unchanged issues.
- [x] Reduce per-shot/repair context, bound review output; preserve full independent final review and commit gate.

### Task 3: Extend remaining complex workflows in requested order

- [x] Inventory every public AI entry and map actual generation/review/repair/resume/save calls.
- [x] Extract reusable graph tracing isolation and use it in script/director, source, visual and prompt complex loops.
- [x] Apply common cumulative stage budgets to existing durable tasks and recovery checkpoints without losing long-text units.
- [x] Add quality/structure/result observation to understanding, reverse prompting, continuity and canvas proposal paths; preserve their approval flows.
- [x] Close concrete image/video/speech adaptation, polling/cancel/download/terminal gaps using current task identities.

### Task 4: Coverage and real acceptance

- [x] Complete an explicit feature-to-source-to-test coverage matrix; no unimplemented entry marked covered.
- [x] Run focused regressions, independent review, full backend/frontend and sequential unified build.
- [x] Use isolated fixed-source runs on previously chosen model configurations; report first pass, repair, time, usage and recovery work, with sample limits.
- [x] Validate Langfuse business outcomes and strict save gates; stop own services and preserve evidence.

Delivery: commit/push the reviewed changes on `codex/langfuse-observability`; no main merge.

Acceptance evidence: [final report](../../ai-workflow-quality-expansion-acceptance-2026-11-13.md). Backend 3390, web 1704, tooling 9 passed; final unified build passed. GPT storyboard/source/prompt passed their samples; Claude storyboard remains needs_work after one repair and save is blocked. Four actual Langfuse traces (57 observations) verified; disconnected Claude call billing remains unknown. Temporary 8002 service stopped.
