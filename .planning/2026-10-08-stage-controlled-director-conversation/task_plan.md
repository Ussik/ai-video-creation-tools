# Task Plan: Stage-controlled director conversation

## Goal
Control script conversation interactions and document progression by saved project stages, while preserving explicit edits/jumps, existing artifacts and enabled Skills.

## Current Phase
Complete

## Next Step
Delivered stage-controlled conversation behavior; await any further user feedback.

## Phases
### Phase 1: Inspect and design
- [x] Inspect intent coordinator, streamed reply rendering, classification and progress calculation.
- [x] Define typed interaction gates and persistence.
- **Status:** complete
### Phase 2: Implement
- [x] Stage-scoped prompts, generation permissions and interaction validation.
- [x] UI gates for direct JSON and recognized prose; save-driven progression and explicit overrides.
- **Status:** complete
### Phase 3: Verify
- [x] Regression tests for outline first, saved reuse, wrong-order/repeated generation, explicit requests, drafts, reload and Skill injection.
- [x] Both builds and required test suites.
- **Status:** complete
### Phase 4: Deliver
- [x] Review final diff, update docs and report results/limits.
- **Status:** complete

## Verification
- Full regression: backend 142/142, frontend 182/182.
- After final recognition/cache refinements: backend focused 54/54, frontend focused 43/43.
- Both final package builds passed; git diff --check clean.
- Provider calls mocked; no live model requests or production data deletion.
- Typed controls enforce saved stages; semantic labeling and explicit natural-language requests still depend on model recognition.

## Decisions
- Preserve all prior uncommitted work. No commit/push requested.
- Skip means model decides one question; never advances a stage by itself.
- No paid/live model calls; verification uses mocked providers/temp databases.
- No subagents.
