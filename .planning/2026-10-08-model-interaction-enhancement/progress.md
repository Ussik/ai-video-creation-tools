# Progress

- 2026-10-08: User authorized implementation of the enhancement recommendations and requested a final inventory by mechanism.
- Initialized isolated plan. Existing dirty workspace changes are from preceding tasks and will be preserved.
- Read planning skill; no subagents, external model calls or commits are needed.

- Split native tool document protocol from legacy JSON return instructions; missed native questions stay unclassified and can enter cached reply recognition. Added completion kind and source metadata.
- Added capability-configured structured output transport for Responses/Chat Completions and local optional-null restoration; fixed tasks get one bounded correction. Migrated profiles, Skill refinement, intents, legacy workflow drafts, themes, continuity, reply extraction, shot plans and full scripts.
- Asset confirmation now uses a typed bilingual result endpoint and saves only the editable Chinese prompt. Added model-setting controls for output capability and strict function arguments. Initial backend build passed.
- Patch verification failed once due to an inexact existing error string; checked the current source and applied the corrected patch. Earlier nonexistent search paths were corrected.

- Added professional review functions with current-version, complete-read and verbatim-evidence validation. Review records are versioned; markers are review hints rather than automatic stage failure. Drafts list downstream stage, scene and actual visual-binding implications.
- Added six visual/storyboard functions and shared versioned resource drafts (profiles, references, new shots, shot patches). Editing/confirm/discard reuse the existing draft UI and transaction. Visual profile changes reuse the direct API implementation, retaining previous board candidates and binding snapshots.
- Resource context loads enabled visual/storyboard/image/video Skills on demand and records actual rule loads. Resource mutations require explicit-intent checks and existing version validation; no media generation tools were added.
- Both builds passed after resource preview and review UI integration. Added persistence for native/extracted interaction provenance and structured review reports, with history-context invalidation for answered questions.
- Added root-schema reference handling, scoped discard/commit guards, duplicate/invalid resource edit checks, and local draft restoration for resource values.
- Added frontend regressions for missed question recovery, resource edit synchronization, and review/provenance history restoration. Targeted suites and the full backend suite pass; frontend full suite and both TypeScript/Vite builds pass.
- Wrote the source-backed inventory and usage guide at `docs/model-interaction-controls.md`.
