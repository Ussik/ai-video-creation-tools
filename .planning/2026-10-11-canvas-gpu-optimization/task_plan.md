# Canvas GPU optimization

PLAN_ID=2026-10-11-canvas-gpu-optimization

## Goal
Reduce GPU/rendering load in idle, selection and settings/media states, with priority on selected canvas nodes. Preserve editing, links, deletion, undo and persistence.

## Phases
- [x] Static selection/connection feedback, earlier visibility pruning, lighter chrome and batched magnet updates.
- [x] Cached bounded media previews and active-only video playback.
- [x] Cap WebGL draw rate/resolution; stop hidden/reduced-motion rendering.
- [x] Focused regressions/builds and real browser GPU-work comparison; docs/cleanup.

## Constraints
- Preserve all unrelated working-tree changes, no staging/commit/push.
- No generation calls or real project graph edits during QA.
- Ego-browser one new TaskSpace for this implementation goal.
- Report draw/paint work as such, not system GPU percentages.

## Decisions
- Keep recognizable static selection borders/edge colors and original media accessible.
- Preview cache must deduplicate/constrain generation, expire by source identity, and preserve original files.

## Errors
- Initial reads were truncated; use smaller independent output budgets.
- Searches referenced absent media.ts/config.ts; actual image/render infrastructure lives in providers.ts/render.ts/db.ts.

## Follow-up: zoomed content and selected connections
- [x] Restore actual content at every zoom, use smaller cached media previews at overview zoom.
- [x] Add bounded compositor transform markers along visible selected connections, suspend hidden/reduced-motion/multi-selection animation.
- [x] Verify content/motion lifecycle and geometry with focused tests and isolated browser QA; update docs and clean fixtures.
- Existing real project was intentionally deleted by the user; do not restore it. Use one new browser TaskSpace and mocked graph only.
