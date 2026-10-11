# Node composer below-node positioning

## Goal
Keep the selected node composer centered below its node through canvas pan, zoom and node movement. Preserve scrolling and expanded editing. Do not switch sides or automatically reframe the viewport.

## Phases
- [complete] Inspect current placement and LibTV reference.
- [complete] Implement stable bottom positioning and focused regression coverage.
- [complete] Run focused tests, frontend build and browser verification.

## Constraints
- Preserve unrelated working-tree changes; no commit or generation requested.
- Use browser TaskSpace 14 throughout this goal.
- Own this plan directory only; do not modify the shared active plan pointer.

## Errors
- External browser click on anonymous snapshot ref was rejected by automatic approval review. Read-only DOM inspection now identifies the image node group and focus surface; establish concrete low-risk selection target before retry.
- LibTV follow-mode exit button was inert; re-observation confirmed the selected editor had appeared normally. Measured its fixed-width below-node panel during view panning.
- Local editor wait after selecting through the sidebar and closing the sidebar timed out; re-observation shows node centered but deselected. Continue by selecting the visible node directly.

## Follow-up: compact composer and skill-selection popup
- [complete] Reproduce portaled skill-selector clicks dismissing the canvas node and prompt modal.
- [complete] Reduce normal editor height and preserve nested overlay interactions.
- [complete] Run focused integration tests, frontend build and browser checks.

User authorized both changes on the follow-up turn. Reuse the existing plan, preserve unrelated work, and use a new browser TaskSpace because space 14 is finished.

Follow-up test harness initially used Mantine's test environment, which disables portals. Enable real portals with zero-duration transitions for this regression. Before fix, the corrected integration test fails on dropdown header pointerdown; real browser reproduces the same selection/modal removal.

## Follow-up: remember prompt skills across nodes
- [complete] Trace selection reset on modal close and node remount.
- [complete] Remember prompt selections per project and stage, preserve explicit default actions.
- [complete] Verify actual node switching, remount, project separation, default reset and browser behavior.

Scope: only prompt refinement opts into remembering. Store local choices by project, keep image/video independent, and avoid automatically writing backend defaults.
