# 原稿制作路径 Implementation Plan

> **For agentic workers:** Use native execution task by task. The user has authorized implementation and prohibited commits, pushes and expanded paid runs; these constraints override the skill's default handoff and commit steps.

**Goal:** 上传只技术读取、保存和展示；仅用户主动发起任务后读取原文，直接交付成果，不分析或审核原稿。

**Architecture:** 默认仅展示文件，无自动原稿处理。主动制作范围选择后按精确原文位置导入，缺正文时由显式source_episode任务直接写作。所有默认任务读取原文，不注入或补跑语义分析；旧记录只读与未知请求保护保留。

**Tech Stack:** TypeScript, Fastify, SQLite, React/Mantine，复用现有结构化输出和请求保护。

**Spec:** docs/superpowers/plans/2026-11-15-source-production-boundary.md

## Global Constraints

- main 现有未提交成果全部保留；先在隔离镜像实现并按本轮基线增量同步。
- 不清库、不清 Langfuse、不 commit/push、不真实调用模型或代确认新用量。
- 原稿及已确认成果只读保留；未通过审稿不伪装为通过。
- 文件、格式、引用、版本、正式保存和未知付费请求保护保留。

## Review Focus

1. 同集多个来源段落/目录重复时应提示局部选择，不能静默拼错正文。
2. 原稿仅有梗概时不能伪造场次；显式改编不强迫先写全套设定。
3. 单集部分已保存、其他集变更时应复用成果，不能覆盖已有场次或重发未知请求。
4. 暂停/失败的旧审稿与保留中的付费请求不阻断无关集本地制作。
5. 上传、启动、原稿修订不能启动全文审稿；旧审稿兼容API与台账保留，默认界面无调用入口。

### Task A: 确定性目录与按集制作 API

**Files:** Create shared/script/script-source-production.ts; backend/modules/script/script-source-production.ts; backend/test/script-source-production.test.ts. Modify infrastructure/database/db.ts and app.ts route registration.

**Interfaces:** `sourceProductionDirectory(content)` 返回带精确 offset/length 的集及场次；`GET /script/source/production` 返回只读就绪状态；`POST /script/source/production/prepare` 接收 source_version、episode_number、scene_offsets、duration，事务保存缺失场次和 provenance、复用已有成果。

- [x] 测试原文不变、对白逐字、重复目录、梗概、旧失败审稿、局部重入、源版本冲突、已编辑场次和0模型调用。
- [x] 实现解析、局部依赖状态、幂等导入和场次原文表；保留每个有效成果。
- [x] 运行定向 API 测试。

### Task B: 默认制作退出原稿分析审核

**Files:** script-source-documents.ts, script-source-analysis.ts, app.ts, script-document-tools.ts, script-generation-checkpoints.ts, shared script-task-contract.ts/script-stage-access.ts, backend script-workflow.ts.

**Interfaces:** `source_episode` 仅允许分集创作，保留正式草稿确认；独立命名空间 `source-production:episode:N` 保留完整/未知响应。其他创作阶段保持原有顺序，既有审稿 API 保留。

- [x] 测试上传即使带 legacy model_id 也不调模型；重启及修订不自动审稿。
- [x] 删除默认生成/保存对全剧审稿的依赖；source_episode 不走全剧分析和语义审稿，直接一次生成，最多一次格式纠正，断连停止。
- [x] 新制作断点及旧审稿/生成断点相互保留，按任务独立隔离；运行合同/保存/恢复测试。

### Task C: 真实父页面制作入口

**Files:** Create ScriptSourceProduction.tsx + tests; modify ScriptDirectorPanel.tsx / DirectorSourceContext.tsx and existing source CSS.

**Interfaces:** SourceProduction props source, existing scenes, unavailable, onRefresh, onAdapt(episode). 仅用户主动选择本次制作范围后显示按集原文/场次和局部选择；默认制作界面移除审稿操作。

- [x] 测试旧 paused 审稿仍可选择/准备目标集，网络失败保留成果、单次点击不重复提交、梗概仅显式改编。
- [x] 接父页面、取消上传自动审稿和默认聊天全局审稿锁。
- [x] 运行 web 定向测试与完整构建。

### Task D: 增量交付与验证

- [x] 校验本轮基线漂移，增量同步 main；原有304项未提交改动保留，非交付文件无额外漂移（构建缓存除外）。
- [x] 使用旧DB隔离副本回放API；Ego Lite实际父页面验证上传零分析、显式按集制作和分镜入口；真实8888只读核对，不调用付费模型。
- [x] main完整构建通过，前端83/83、后端50/50定向回归通过；完成页面、数据保留读回及结果报告，明确真实模型未实测。

## Latest user boundary - supersedes previous steps

Upload only performs technical file reading, validation, storage and display. No original-manuscript analysis or review, automatic directory preparation, semantic extraction or background auditing. Only an explicit creation/production task may read source text as its input. Keep technical validation, original data and unknown request ledgers.

- [x] Remove automatic production-directory fetches on upload or parent mount.
- [x] Retire manuscript audit actions from the default UI; display historical records read-only.
- [x] Verify missing or failed legacy analysis never causes a gate or implicit supplementary analysis.
- [x] Verify actual parent, upload route and explicit task route offline, with zero paid calls.
