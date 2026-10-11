# 成片工作台职责修正

PLAN_ID=2026-10-11-2026-10-11-final-cut-workspace

## Goal
画布承担分镜规划和生成；成片工作台仅选片、裁剪、接镜、预览与导出，能返回对应镜头节点。

## Phases
- [x] Audit current duplicate generation, timeline and canvas navigation.
- [x] Replace generation inspector with editing controls and remove obsolete App generation flow.
- [x] Implement per-shot return to matching canvas/node, retaining multi-canvas drafts and no duplicate nodes.
- [x] Meaningful integration regressions, production build, isolated browser QA and docs/cleanup.

## Constraints
Preserve unrelated uncommitted changes; no real project graph writes or paid generation during QA. No commit/push. Preserve existing selection, trimming, cut review, timeline/export and source audio contracts.
