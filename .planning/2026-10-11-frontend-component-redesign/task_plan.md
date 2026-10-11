# Frontend component and visual redesign
PLAN_ID: 2026-10-11-frontend-component-redesign
PWF_PLAN_ROOT: /Users/caoyanzu/workspace/ai-video-creation-tools/.planning

## Goal
Back up current code to GitHub, then refresh every frontend surface using Mantine interaction components and a consistent professional graphite visual system. Preserve all business behavior, API contracts, state, canvas gestures, editing and media workflows.

## Phases
- [complete] Publish backup and capture build/test/browser baseline.
- [complete] Unify design tokens and component theme, migrate basic controls.
- [complete] Replace native disclosure, selection, upload, media controls and hand-written overlays with library components.
- [complete] Refresh projects, canvas, script, storyboard, assets, models, skills, speech and final cut surfaces.
- [complete] Static component guard, complete regression tests/build, browser interaction and responsive review.

## Decisions
Keep React / Mantine / React Flow / Tiptap / Lucide; no framework replacement. Use actual library components; layout HTML, rich editor document and canvas/media engines remain appropriate. New branch codex/frontend-refresh; backup 34ed4e9. Final redesign stays reviewable locally unless publication explicitly requested.

## Errors
Direct 129-file push to main rejected by automatic review. Backup committed to independent branch instead. Ego CLI requires elevated execution in this environment. Prior audit accidentally added a script node through a write-on-open path and restored that exact node; avoid this during read-only checks.

## Follow-up: tabs, shot references and connection selection
- [complete] Remove canvas tab separator and give the asset separator a 14px gap.
- [complete] Embed a shot-scoped reference editor in the composer, reusing persistence and frozen-reference behavior.
- [complete] Use neutral gray idle links and gray-blue active links, retaining efficient motion dots.
- [complete] Reference/selection regression checks, build and targeted browser review in Ego TaskSpace 28.
