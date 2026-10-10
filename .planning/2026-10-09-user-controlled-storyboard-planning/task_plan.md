# User-controlled storyboard planning

## Goal
Explicitly select scenes, reference documents, model and storyboard skills before requesting a model. Preview and edit before saving or adding to canvas. Canvas import must not implicitly invoke models.

## Phases
- [x] Audit existing planning and canvas flows.
- [x] Implement scoped planning context, selected skills, versioned draft save and model-free canvas import.
- [x] Add a shared planner to director, script editor and shot studio; reuse existing shot IDs.
- [x] Verify scoped reads, no implicit generation, timing, draft editing and existing media preservation with focused tests and browser mock QA.

## Decisions
- Keep unrelated workspace changes and existing API compatibility.
- Use a shared planner and dedicated routes for the explicitly controlled flow.
- Replanning preserves existing shot IDs and media; models may add shots but may not silently remove existing shots.
- Enabled skills are selectable per request; an empty selection uses base rules.
- Selected source documents and timing are visible before generation.

## Errors
- Initial backend fixture used an incorrect route and omitted its script row; corrected isolated test setup and validation status.
- Two incomplete patch hunks were rejected without mutations; corrected complete patches applied.
- Ego role locator required a name; switched to CSS. Hot reload and viewport reflow invalidated browser targets; refreshed observed checkbox refs and rebuilt the mock preview.
- React test act warning resolved by awaiting asynchronous test interactions; all three planner tests passed cleanly afterward.
