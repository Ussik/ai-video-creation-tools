# Director interaction and workflow

## Goal
Enhance confirmation/choice/input recognition, retain multiple pending questions, and make next-stage guidance use saved project artifacts instead of blindly advancing after the last generated stage. Preserve manual stage selection, saved content and skip delegation.

## Phases
1. Audit existing contracts, cache, question panel and saved-stage handling — complete.
2. Implement explicit confirmation and multiple-question contracts, robust long-reply recognition and sequential answering — complete.
3. Implement saved-state workflow progress and consistent authoring guidance — complete.
4. Run focused and regression tests, builds and isolated UI QA — complete.
5. Review and deliver — complete.

## Constraints
- Existing uncommitted skill-center changes remain intact. No commit/push requested for this task.
- No paid model/media calls or changes to real project data during QA.
- Recommended professional order: story direction → full-story outline → character identity/relationships → locations → props → episode script → storyboard. Existing artifacts are reusable; updates require explicit intent, not automatic regeneration.
- Stage order guides recommendations; creator may explicitly jump stages.
