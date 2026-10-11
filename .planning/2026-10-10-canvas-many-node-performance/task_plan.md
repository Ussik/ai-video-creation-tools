# Canvas many-node performance

## Goal
Support the existing 500-node canvas with less rendering, media and interaction work, preserving selection, editing, links, persistence and undo.

## Phases
- [x] Inspect rendering/update paths and establish a reproducible 100/300/500-node baseline.
- [x] Add visibility/zoom-based rendering, stable node data, active-only editors and indexed updates.
- [x] Verify regressions, benchmark actual browser interactions and clean temporary fixtures.

## Constraints
- Preserve unrelated working-tree changes; no commits or DB writes.
- Keep 500-node/1000-edge API limits and generation contracts.
- Use official React Flow visibility handling, retain data/geometry offscreen.
- PLAN_ID=2026-10-10-canvas-many-node-performance

## Errors
- Bounded initial reads still exceeded combined output budget; reduce later reads.
- Browser wait selector matched100 nodes; changed to specific node0 selector.
- Intermediate patch did not match current file; inspected then applied focused patch.
- Build accidentally invoked repo root without package.json; reran in web.
- Focused test command invoked repo root with relativeweb loader paths; reran inweb.
- JSDOM ResizeObserver microtasks emitted excessive act warnings; deliver observations through controlled test animation frames.
- Many-node test treated percentage viewport size as 100 pixels, leaving one visible node; add an explicit viewport size for those fixtures and preserve existing box-selection coordinates.
