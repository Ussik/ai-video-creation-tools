# Independent Storyboard Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分镜可独立规划保存，并在完整分镜工作区维护后按需进入画布制作。

**Architecture:** 沿用当前规划/镜头管理 API 与组件，在 commit 上增加兼容的 save_only 模式，为未进入画布的新方案保存显式状态。分镜管理使用全屏工作区，规划器独立保存后回到管理；原画布流程继续可用。

**Tech Stack:** React 19、Mantine 9、Tiptap、TypeScript、Node、SQLite、node:test。

**Spec:** docs/superpowers/plans/2026-11-03-independent-storyboard-design.md

## Global Constraints

- 不提交、不推送；保留已有未提交改动。
- 独立保存不得创建画布、节点、参考设定或触发参考设定模型。
- 不将已删除画布解释为尚未创建；保留旧幂等请求的兼容性。
- 保留同方案同场次排序、回收保护、版本冲突和未保存确认。
- 页面使用现有 Mantine、图标和主题，不新增 UI 依赖。
- 用隔离数据做写入和生成流程验收；不调用真实计费模型。

## Review Focus

- save_only 新方案的首次提交、重复提交、再次更新，不产生画布。
- 参考设定未就绪与已删除画布，拒绝提前创建/静默恢复。
- 刷新失败、卸载和切项目，避免重复保存或晚到回调污染。
- 保存后切回管理时选中正确方案，保留新镜头可见性。
- 窄屏/深色/无镜头/回收站状态和脏数据导航可操作。

---

### Task 1: 独立保存与延迟画布

**Files:** backend/src/modules/storyboard/storyboard-planning.ts、backend/src/infrastructure/database/db.ts、packages/shared/src/storyboard/shot-management.ts、backend/src/modules/storyboard/shot-management.ts；相关 backend tests。

**Interfaces:** commit body 增加 save_only?: boolean；design 增加 canvas_pending；返回沿用 ScriptCanvasResult（target_canvas_id 可空）。默认调用保持旧行为。

- [x] 写独立保存、重试、迁移、参考未就绪、旧画布删除测试并验证失败。
- [x] 实现 pending 状态与延迟创建画布，保留历史幂等摘要；历史 pending 方案制作绑定显式 design_id 与方案来源指纹。
- [x] 运行 storyboard-planning、design-history/recovery/migration 相关测试。

### Task 2: 规划器独立保存与剧本入口

**Files:** StoryboardPlanner.tsx、storyboard-planner.css、ScriptEditor.tsx、ScriptDirectorPanel.tsx、web/test/storyboard-planner.test.tsx 与脚本入口测试。

**Interfaces:** intent?: 'plan'|'canvas'（默认 canvas）；onSaved?: (result: ScriptCanvasResult) => void|Promise<void>；脚本入口可用 onOpenShotManager?: (sceneIds?: string[])=>void。

- [x] 添加独立保存不调用画布/参考模型、刷新失败重试、取消晚响应测试。
- [x] 规划模式显示保存方案、隐藏制作准备；脚本入口进入分镜工作区并可规划分镜。
- [x] 运行规划器与脚本入口相关测试。

### Task 3: 完整分镜管理工作区

**Files:** ShotManager.tsx、shot-manager.css、web/test/shot-manager.test.tsx。

**Interfaces:** onPlan?: (sceneIds?: string[])=>void；initialSceneIds?: string[]；initialDesignId?: string|null；刷新/加入画布回调沿用。

- [x] 添加场次汇总、状态、规划入口、筛选/脏数据保护测试。
- [x] 实现场次导航、镜头表、分组详情和批量交接，保留所有已有管理动作。
- [x] 运行镜头管理测试，检查空态和回收站；窄屏浏览器验收见 Task 4。

### Task 4: 集成与验收

**Files:** ProjectCanvas.tsx、App.tsx、必要导航/集成测试、docs/shot-management.md。

**Interfaces:** 项目菜单与剧本入口进入同一分镜工作区；保存后刷新并选中方案；制作交接明确处理 pending 方案。

- [x] 连通管理→规划→保存→管理与剧本→分镜工作区→规划路径。
- [x] 运行管理/规划/制作交接集成测试和架构/UI检查。
- [x] 运行最终构建；前端相关测试 126/126、后端相关测试 99/99 通过。
- [x] 隔离运行浏览器验收：独立保存、重新进入、编辑、回收恢复与后续加入画布；桌面/390px/主题检查；历史 A/B 隔离、第二场继续制作及重复导入复用。
- [x] 独立审查整体变更并修复发现，包括已选片缩略图优先级、历史方案来源隔离及后续场次参考检查；记录验证范围与限制。

验收记录：`docs/superpowers/acceptance/2026-11-03-independent-storyboard/README.md`。模型上游为隔离假服务，仅证明流程与数据隔离，未评价真实分镜和参考设定的生成质量。
