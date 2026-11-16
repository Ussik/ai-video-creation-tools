# 原稿分析与复用恢复 Implementation Plan

> **For agentic workers:** Execute in the current session; the user explicitly requested direct implementation on main. No delegation, commit, push, paid model calls, or live data mutations.

**Goal:** 上传后保留全文分析、进度和结果，按原稿版本复用故事、人物、设定目录、分集及原文索引，取消自动质量审核修补循环和审核通过门槛。

**Architecture:** 沿用原稿分析的目录与全剧整合检查点，保留本地结构、覆盖及证据校验。完整结果按原稿版本复用，模型与配置仅约束未完成请求恢复；普通生成直接交付预览，显式评审入口保留。

**Tech Stack:** TypeScript, Fastify, SQLite, React, node:test, jsdom.

**Spec:** 当前聊天用户关于“恢复剧本上传后的原文分析”的请求。

## Global Constraints

- 当前 main；保留全部既有改动及数据库。
- 不调用真实付费模型，不提交或推送。
- 不重复分析未修改的完整原稿，不伪造审核通过。
- 保留原文版本绑定、原文位置、正文保存确认与结构校验。

## Review Focus

- 切换模型、重开页面、重启后相同原稿复用完整分析。
- 历史审核失败但目录与故事完整时不重复请求。
- 部分完成、损坏证据与原稿修订不能误复用完整结果。
- 上传触发分析，读进度不发起创作，结果可回查原文。
- 普通生成不自动评审，显式评审/修订与保存授权保留。

## Tasks

- [x] 清理本轮误加的无关分镜诊断，核实基线与需求回归。
- [x] 完整分析跨模型复用；历史完整结果本地恢复；部分结果按当前版本恢复。
- [x] 移除普通生成的自动审核门槛，保留显式操作与程序契约。
- [x] 对齐进度、全剧信息和原文索引展示以及回归测试。
- [x] 运行隔离后端/前端回归、完整构建及 git diff --check。

## Verification Results — 2026-11-16

- Backend: 376 passed, 0 failed/skipped/cancelled. Command:

  ```sh
  node --import tsx --test --test-concurrency=4 backend/test/script-source-*.test.ts backend/test/script-generation-no-review-gate.test.ts backend/test/script-generation-resume.test.ts backend/test/script-generation-checkpoint-compatibility.test.ts backend/test/script-draft-task-recovery.test.ts backend/test/script-draft-repair-source-sync.test.ts backend/test/script-episode-repair-finalization.test.ts backend/test/script-draft-preview.test.ts backend/test/script-chat-source-context.test.ts backend/test/script-activity-progress.test.ts backend/test/script-document-review-output-recovery.test.ts
  ```

- Frontend: 27 passed, 0 failed/skipped/cancelled. Run from `web/`:

  ```sh
  node --import tsx --test test/script-source-upload.test.tsx test/director-source-context.test.tsx test/director-message-history.test.ts
  ```

- `npm run build`: passed architecture/UI guards, shared/backend/web TypeScript and Vite. Existing large-bundle warning remains.
- Build and tests must run sequentially: shared build cleans `dist`, which otherwise causes transient module-loading errors in concurrent tests. The final backend run above started after the build completed.
- `git diff --check`: passed.
- Mocked integration covers original upload and analysis, 20 stage artifacts, first-episode scene preview and confirmed save; historical pending quality candidates remain stored without blocking normal creation.
- Identical-upload regression first reproduced cancellation of active analysis, then passed after preserving active work for unchanged source.
- All verification uses isolated test data and mocked model responses. No paid model calls, live database changes, commits or pushes. Existing unrelated working-tree changes are retained.
