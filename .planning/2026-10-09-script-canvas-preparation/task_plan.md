# Script canvas preparation

## Goal
One action checks/reuses visual settings, organizes missing drafts, creates missing shots and inserts related nodes/links into the current canvas. Visual settings remain a separate management entry; image generation remains manual.

## Next Step
Completed; ready for user use.

## Phases
- Discovery: complete
- Backend preparation and draft persistence: complete
- Canvas handoff and chat progress: complete
- Verification: complete
- Delivery: complete

## Decisions
- Use a read-only preparation response followed by version-checked atomic commit; stale model output cannot overwrite newer script or visual settings.
- Keep newly organized definitions as drafts; preserve existing confirmed definitions/boards.
- Use the active canvas editing queue via a typed handoff so local uncommitted nodes are preserved.
- Add only missing profile/shot nodes and links, with collision-free placement.
- Track scene preparation fingerprints to reuse a completed preparation on retry without another model call.

## Errors
- Discovery referenced absent backend/src/canvas.ts; canvas routes are inside server.ts.
- Test file creation initially used backend-prefixed path from backend cwd; fixed by root-relative apply_patch. Broader tests require local test listener permission.
