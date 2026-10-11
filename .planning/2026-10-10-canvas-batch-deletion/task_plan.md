# Canvas batch deletion

## Goal
Make large canvases easy to clean up with a selection toolbar, contextual batch deletion, canvas-only select-all, and confirmed clear-canvas. Preserve assets, shots, jobs, autosave, and undo/redo.

## Phases
1. Inspect selection, menus, shortcuts, persistence and test harness — complete.
2. Implement accessible controls and shared deletion flow — complete.
3. Validate interactions, cancellation, undo/redo, autosave and shortcut boundaries — complete.
4. Review diff and report — complete.

## Decisions
- Reuse React Flow controlled selection and graph history.
- Preserve existing unrelated workspace changes.
- Use one confirmation per operation; prevent overlapping confirmations.
- Reuse existing canvas colors and floating-control styling.

## Errors
- Initial search referenced nonexistent backend canvas files; routes live in server.ts.
- apply_patch rejected delete/add on the same planning path; initialized files with a scoped Python write.
