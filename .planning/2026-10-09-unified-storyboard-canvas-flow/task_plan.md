# Unified storyboard canvas flow

## Goal
Expose one “加入画布” entry. Require professional storyboard planning before new scenes enter the canvas, reuse saved plans, and redesign the modal with clear selection/configuration/preview regions.

## Current phase
Complete.

## Next step
Deliver the unified flow and redesigned modal. No commit or push requested.

## Phases
- [x] Inspect current flow, screenshots, modal and endpoints.
- [x] Unify director/editor/studio entries (storyboard_entry_unification).
- [x] Require plans in backend canvas import and verify readiness (storyboard_import_flow_audit).
- [x] Redesign planner and combine planning/confirmation/import workflow (root).
- [x] Test native requests, reuse/mixed plans, retry and explicit model invocation.
- [x] Build and mocked browser QA at desktop/narrow sizes.
- [x] Clean fixtures and deliver.

## Constraints
Preserve local changes, installed skill choice/default logic, explicit user model generation control, editable previews, shot identity/material bindings and idempotent commit. Do not use real models/project data for QA.
