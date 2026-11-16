# Source Quality Decisions Implementation Plan

> Execution: implement the authorized scope in this session with bounded parallel ownership; no additional approval pause, paid model call, commit or push.

**Goal:** Make source-analysis quality decisions explicit, stop unchanged paid repair loops, and permit creation where verified quality findings do not affect the requested work.

**Architecture:** Keep the existing local edit references, durable response journals and dispatch admission. Separate a model's proposed disposition from persisted analysis changes and independent review. Add structured finding locations/impact, a private audit trail and public progress/access summary; preserve legacy findings conservatively.

**Tech Stack:** TypeScript, Zod, existing LangGraph workflow, Fastify, React/Mantine, node:test, Ego Lite.

**Spec:** Current user delegation in this chat, 2026-11-15, six implementation priorities and the required offline replay scenarios.

## Global Constraints

- Work from a fresh isolated copy of current main; preserve unrelated edits when applying verified deltas.
- Inspect live activity read-only before deployment; never cancel/restart an active request or alter its identity.
- Preserve source, saved analysis, raw answers, request ledger, permits and audit records. No Langfuse cleanup.
- No extra provider requests. Offline provider doubles must fail on unexpected network access.
- Historical findings and disposition reasons stay private and never enter independent review inputs.
- Coordinates and valid schema establish structural consistency, not the truth of free-text reasoning.

## Review Focus

- A reason requesting deletion with no edit cannot become an analysis modification.
- A legitimate retain decision stays pending review and preserves actual uncertainty content.
- Changed wording or source-reference order must not reset no-progress protection for the same unchanged target.
- Invalid batch members or shifted array indexes must not overwrite unrelated values or repeat successful requests.
- Unknown delivery, restart and double click preserve the existing dispatch and correction budgets.

### Task 1: Explicit repair decisions and durable accounting

**Files:** shared script-source-document types; script-source-quality-repair.ts; script-source-quality-progress.ts; focused backend tests.

- [x] Add modify_analysis / retain_analysis / uncertain outcomes bound to the current finding, exact analysis references and original source references.
- [x] Validate actual nonempty changes for modification; retain and uncertain never imply corrected content.
- [x] Preserve legacy raw responses and journals; reject ambiguous withdrawn reuse without buying a replacement.
- [x] Test no-op patches, correct retain, partial changes preserving unknowns and checkpoint replay.

### Task 2: Structured impact and unchanged-loop protection

**Files:** script-source-quality.ts; new assessment helpers; focused backend tests.

- [x] Add current analysis locations, issue proposition, substantive/open-question classification and bounded affected sections.
- [x] Keep substantive factual findings blocking; allow verified advisory findings and restrict scoped uncertainty only where relevant.
- [x] Compare review transitions using actual unchanged targets and evidence, preserve history and stop repeat attempts before dispatch.
- [x] Replay the saved five real responses offline and prove no semantic success is inferred from legal references.

### Task 3: Workflow, batching and safe source access

**Files:** script-source-analysis.ts; script-source-checkpoints.ts; script-source-documents.ts; ordinary dispatch and direct dependents as required; backend integration tests.

- [x] Bind summaries and gate checks to current source/configuration and run before queue creation.
- [x] Distinguish full quality pass from usability with advisories or scoped uncertainty; keep unknown requests protected.
- [x] Add conservative bounded same-target batching with separately bound outcomes and stable array edits, retaining full final review.
- [x] Test partial batch failure/order shifts, restart/double start and recovery/UI metadata agreement.

### Task 4: Creator-facing status and actual page verification

**Files:** ScriptSourceAnalysisView.tsx; ScriptDirectorPanel.tsx; minimal helpers and web tests.

- [x] Display handled versus modified/retained/uncertain counts and pending independent review.
- [x] Offer meaningful next steps for no-progress and scoped findings without an unchanged paid retry loop.
- [x] Check the real component in an isolated Ego Lite fixture and current live GET state without triggering autosave or model work.
- [x] Run focused regressions, builds and a final review, then apply only verified drift-checked files to idle main.

## Initial read-only field check

At 2026-11-15 12:35 Asia/Shanghai, analysis c834787b163d4e219443fd7790ed95f4 was failed, with two findings and five completed requests. No queued/running source analyses were present. This is an observation, not permission to alter the recorded failure.

## Delivery evidence

Implementation and focused verification are complete. See `2026-11-15-source-quality-semantics-result.md`; main application/build/readback receipts remain in the local evidence directory. No new paid model calls, commit or push.
