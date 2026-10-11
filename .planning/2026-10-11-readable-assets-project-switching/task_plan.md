# Readable asset names and project switching

## Goal
Show useful names for existing and future generated assets based on their visual profile, shot and generation/canvas context. Add a Mantine project switcher to the main header and retain the active workspace when switching. Preserve storage filenames, asset IDs, generation, downloads and existing project polling.

## Phases
- [x] Inspect asset metadata and project lifecycle.
- [x] Implement a shared display-name resolver and integrate asset titles/search/previews.
- [x] Add the header project switcher and clear stale project-specific UI.
- [x] Verify focused naming and project-switching regressions, build, browser desktop/mobile checks.

## Constraints
- Work on current checkout; preserve unrelated uncommitted changes.
- This task owns this directory; do not change `.planning/.active_plan`.
- Do not mutate project data or perform generation/export while checking UI.
- Keep file paths, stored filenames and backend contracts intact.

## Errors
- Initial search used a nonexistent wildcard path; replace guessed paths with `rg --files` discovery.
- Broad search for 林昭 matched prompts on multiple assets; use the full display title to verify a single search result.
- Browser page had returned to the gallery during shared development. Re-observed and navigated normally. The canvas overlays global navigation, so used its 返回项目 button before opening assets.

## Result
- Shared presentation metadata renders meaningful historical/current asset names, revision/type and request specs; long card titles use up to two lines.
- Header Mantine project selector supports search, keeps the asset workspace/subview and clears stale selection/filter/preview/dialog state.
- 37 focused tests passed, including GET-only project switching and request isolation; frontend component check, TypeScript and Vite build passed. `git diff --check` passed.
- Browser space 35 validated nine hospital assets, exact-title search, preview with original filename and 2K/16:9, switching to 紫夜 with selection/query cleared, and 390px layout with dropdown inside viewport. Finished the space successfully.
- No project data, stored media names, backend contracts or generation/download behavior changed. No commit/push in this refinement.
