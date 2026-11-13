# Final Cut Asset Status Implementation Plan

> **For agentic workers:** Implement the scoped tasks below and verify the combined result before reporting completion.

**Goal:** 成片工作台的项目素材能按已确认、候选、其他筛选，每条素材明确显示状态。

**Architecture:** 读取来源画布当前使用的图片/视频，并结合现有项目选用、设定确认和归档记录派生展示状态。在素材类型筛选上方增加独立状态筛选，支持与搜索和媒体类型组合；保持项目数据和剪辑操作不变。

**Tech Stack:** React、TypeScript、Mantine、Node test runner、ego-browser。

**Spec:** 本次用户请求及截图中圈出的 BasicFinalCutStudio 项目素材列表。

## Global Constraints

- 用户补充：画布当前使用的图片、视频即为已确认；镜头/配音选用和有效设定确认记录也作为确认来源，个人收藏与审核通过不等于确认。
- 导入、导出、归档和旧版参考单独标明；添加到独立剪辑不改变源素材确认状态。
- 不修改现有未提交工作，不提交或推送本次改动。

## Review Focus

- 相同名称的不同候选必须能通过状态筛选定位。
- 已收藏、审核通过但未选用的素材不能误标确认。
- 已确认的导入素材应优先显示确认。
- 已归档和旧版参考不能混入普通候选。
- 状态筛选必须与关键词和视频/图片/音频筛选同时生效，保持预览与添加可用。

### Task 1: Derive asset confirmation state

**Files:** Create `web/src/features/final-cut/final-cut-asset-status.ts` and `web/test/final-cut-asset-status.test.ts`.

**Interfaces:** `finalCutAssetStates(detail: ProjectDetail, nodes: FinalCutAssetNode[] = []): Map<string, FinalCutAssetState>`; state contains `status: 'confirmed' | 'candidate' | 'other'` and `label: string`.

- [x] Derive state using current canvas image/video assets, shot selections (including preserved historical shots), speech selections, current visual confirmations, and archive records.
- [x] Verify confirmation precedence, ordinary generated candidates, imported/exported assets, references, and no source mutation with focused tests.

### Task 2: Add filtering and row badges

**Files:** Create `web/src/features/final-cut/useFinalCutAssetStates.ts`; modify `web/src/features/final-cut/BasicFinalCutStudio.tsx`, `web/src/features/final-cut/basic-final-cut-studio.css`, and `web/test/basic-final-cut-studio.test.tsx`.

**Interfaces:** Consume Task 1's state map for filtering and visible status labels.

- [x] Add “全部 / 已确认 / 候选 / 其他” status controls and colored text badges while preserving type tabs and search.
- [x] Cover combined filtering, empty results, source read-only behavior, candidate preview/add, canvas current use and failed status synchronization/retry with interaction tests. Keep “全部” available during a synchronization failure.
- [x] Run focused final cut tests, UI/architecture checks and web build.
- [x] Inspect the local interface in a browser, checking badge readability and compact sidebar layout.

## Verification

- 26 focused tests passed; final TypeScript and whitespace checks passed.
- UI/architecture checks and production web build passed.
- Real local project: 12 videos split into 4 confirmed current canvas versions and 8 candidates. Candidate search composed with video/status filters correctly.
- Browser checked dark/light badge colors and no horizontal overflow at 1512px. No asset selection, timeline or generation mutation was submitted during browser checks.
