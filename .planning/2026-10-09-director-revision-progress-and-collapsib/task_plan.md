# Task: Compact revision progress and collapsible composer

## Goal
Collapse revision status details by default; add expand/collapse controls to the conversation composer without losing unsent input or access to stopping generation.

## Phases
- [x] Audit existing revision progress and composer layout.
- [x] Implement compact progress (agent) and collapsible composer (root).
- [x] Run relevant existing checks and mocked browser QA.
- [x] Remove fixture, finish browser and deliver.

## Constraints
Preserve extensive prior uncommitted work. Mock API for browser QA; do not read/modify real projects or call generation services. Keep neutral gray project styles and existing confirmation/error controls.

## Decisions
- RevisionProgress keeps public API and defaults to a compact disclosure row in live and review contexts.
- Composer defaults open. Collapsing hides skills and input controls together, preserves all current drafts/references, and leaves a stop control visible during chat generation.
- New question, explicit quoted reference, targeted revision or new conversation reveals the composer so required input is discoverable.
