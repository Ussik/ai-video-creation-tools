# Task records page

Goal: Improve current-project task history with contextual actions, filters, preview, empty states and refresh feedback. Preserve paid generation/recovery rules and existing work.

## Phases
- [x] Inspect App, task detail, retry rules and existing design conventions.
- [x] Implement a focused Mantine task records component and App integration.
- [x] Verify filters, recovery actions, refresh lifecycle, build and browser layouts.
- [x] Review changes and deliver.

## Decisions
- Hide shared header speech entry on task history; retain failed speech task's return action.
- State tabs: all, active (queued/running), failed, succeeded. Add type and search filters.
- Reuse existing media preview and task information popover.
- No new dependencies or paid generation during validation.
- Scope polling optimization to task history; keep canvas refresh behavior.

## Errors
- Initial batched output was too broad; use focused bounded reads.
- web/tsconfig.app.json does not exist; use existing npm build configuration.
- First build found unused LoaderCircle/Sparkles App imports after extraction; current file already has these removed.
- Follow-up patch encountered concurrent App edits; re-read before patching and preserved current working tree.
- ego-browser bootstrap cannot connect in default sandbox; escalated local browser connection successfully (TaskSpace 37, p1).
- Initial full tests: 424 passed, 4 new task-record tests failed because test DOM omitted global Document; fixed the harness.
- Browser type dropdown wait timed out after high-level click; inspect DOM before changing interaction path.
- Diff check found a trailing blank line after CSS extraction; removed it.
- Automatic approval review timed out for final browser cleanup; retry once with only TaskSpace.finish.
