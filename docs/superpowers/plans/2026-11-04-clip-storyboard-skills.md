# Clip Storyboard Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为没有剧本的小视频提供真实使用分镜 Skills 的独立规划、保存与制作路径。

**Architecture:** 新增片段规划路由与方案来源表，复用分镜环节的技能执行和结构化生成；前端独立规划器复用技能选择控件，管理和画布统一交接。既有剧本规划契约保持兼容。

**Tech Stack:** React、Mantine、TypeScript、Node、SQLite、node:test。

**Spec:** docs/superpowers/plans/2026-11-04-clip-storyboard-skills-design.md

## Global Constraints

- 不创建伪剧本场次；保存只写片段方案和镜头，不自动整理参考或生成素材。
- 分镜 Skills 必须实际加载给模型；自动选择无关键词回退，手动 [] 优先。
- 不提交、不推送，保留现有未提交编辑；写入验收使用独立数据库和假模型。
- 每镜1–30秒，总时长1–120秒，镜数1–30，镜头总时长必须一致。

## Review Focus

- 自动/手动技能实际进入模型输入；技能变更拒绝旧预览提交。
- 无剧本项目能够走通，已有剧本和分镜不被替换。
- 重复保存、重复加入画布不重复创建；跨项目、回收镜头、已删除画布拒绝。
- 关闭/切项目后的晚响应不写入，保存成功但刷新失败仅重试回调。
- 混合片段/剧本方案不绕过范围校验，来源选择受未保存保护。

### Task 1: 后端片段规划和 Skills

Files: new backend/src/modules/storyboard/clip-storyboard.ts、packages/shared/src/storyboard/clip-storyboard.ts；db.ts、shot-management.ts、app.ts；backend/test/clip-storyboard.test.ts。

- [x] 添加自动和手动技能注入、无场次保存、时长约束、配置漂移、幂等及精确制作范围测试，验证失败。
- [x] 实现设计文档四个路由及独立来源表，复用 resolveCreationSkillContext 和 generateStructuredOutput。
- [x] 运行新测试及相关后端规划/管理回归，共 98 项通过。
- [x] 后端类型检查与完整构建通过，见 Task 4。

### Task 2: 片段规划器

Files: new web/src/features/storyboard/ClipStoryboardPlanner.tsx、clip-storyboard-planner.css、web/test/clip-storyboard-planner.test.tsx。

Interfaces: `opened,onClose,detail,models,onRefresh,onSaved,onNotice`；onSaved 接受 ScriptCanvasResult。

- [x] 添加输入、自动/手动 Skills、预览编辑、独立保存、刷新重试与晚响应测试，验证失败。
- [x] 实现输入、Skills 与多镜预览编辑；展示实际使用技能与理由，保护未保存预览。
- [x] 运行片段规划组件测试，13 项通过，包含规划与保存的 409 配置冲突恢复。
- [x] 最终联合 UI guard，见 Task 4。

### Task 3: 管理与画布集成

Files: ShotManager.tsx、ProjectCanvas.tsx 与相关测试；docs/shot-management.md。

- [x] 来源选择受 dirty guard，新增 onPlanClip；无场次直接进入片段规划，脚本入口保留场次选择。
- [x] 保存后选中片段方案；片段加入画布调用专用精确scope接口，pending与现有画布路径兼容。
- [x] 分镜管理 18 项通过；管理/画布集成 7 项通过，覆盖无剧本→使用Skills→保存→管理→所选镜头入画布，禁止误用script准备接口。

### Task 4: 验证

- [x] 只读复核技能实际调用与输入契约；隔离 API 验证自动/手动/空选规则注入、独立保存、幂等与精确所选镜头返回。
- [x] 完成技能版本/取消保护与制作交接边界复核；浏览器证据 32 个检查均为 true。
- [x] 最终源码后端 5 文件联合回归 98/98（`/tmp/clip-storyboard-backend-regression.log`）；前端 8 文件联合回归 145/145（`/tmp/clip-storyboard-web-regression.log`）；类型/UI/架构检查、根目录 `npm run build`（`/tmp/clip-storyboard-build.log`）与 diff 检查通过。
- [x] 隔离浏览器验收无剧本项目、自动/手动分镜Skill、首镜标题编辑、保存/重新进入、精确首镜制作与次镜复用、390px/深浅色和关闭确认。
- [x] 记录假模型与真实技能 fixture 的验证范围；归档 3 份 JSON 和 4 张截图，见 [验收记录](../acceptance/2026-11-04-clip-storyboard-skills/README.md)。手动空选由 API/组件覆盖，409 由组件覆盖。
- [x] 专用浏览器空间及 `18890`、`18003`、`18004` 已关闭；原用户 `8888`/`8000` 服务保留。

变更已实现并验证，保留未提交、未推送。真实模型质量未测；用户主后端未重启，新迁移与路由需重启后生效。最终命令、日志与适用范围见验收记录。
