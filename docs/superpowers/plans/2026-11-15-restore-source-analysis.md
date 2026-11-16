# Restore Source Analysis Implementation Plan

> **For agentic workers:** Implement natively in this session. User authorizes direct main implementation and verification; no delegation, real paid models, commits or pushes.

**Goal:** 恢复上传后的原稿分析、进度、结果及故事/人物/设定/分集/原文索引复用；取消质量审核修补复核循环，不将审核通过作为制作门槛。

**Architecture:** 上传选定模型后运行持久化 extraction 分支：原文地图 → 全剧整合 → 完成。沿用现有断点、技术格式/证据校验和未知请求保护；旧审核资料保留但不参与新分析图和制作门禁。同文重传保留任务与版本，已完成资料跨模型复用。

**Tech Stack:** TypeScript, Fastify, SQLite, LangGraph, React/Mantine.

**Spec:** 本轮用户请求，覆盖之前上传不分析的边界文档；旧文档仅为历史记录。

## Global Constraints

- 直接main；保留开始时320项已有未提交改动与现有业务数据。
- 不清库或Langfuse，不调用真实付费模型，不提交推送。
- 页面加载仅查询和轮询，不自动重发失败或未知请求。

## Review Focus

1. 同文重传、重开页面、切模型均不重买完成分析。
2. 改稿使旧资料失效但保留历史，不覆盖新版本。
3. 分析中/失败/旧审核未过不阻止具体制作。
4. 提取完成后零质量审核、修补、复核调用；技术校验仍保留。
5. 轮询取消、暂停、迟到响应不得覆盖新上传来源。

### Task 1: 分离提取与审核并恢复上传触发

**Files:** backend script-source-analysis.ts, script-source-documents.ts, script-source-checkpoints.ts; shared script-source-document.ts; story/parts schemas; backend tests.

**Interfaces:** 持久化 analysis_mode=extract；同文上传返回已有来源和分析；上下文复用故事、设定和分集坐标，不包含审核门禁。

- [x] 添加隔离回归，先验证现有上传不分析与重复上传丢弃资料的问题。
- [x] 实现提取图、原稿幂等上传、已完成资料复用及设定存储；保留断点和请求保护。
- [x] 恢复任务上下文中的提取资料，不触发ensure或独立审稿。

### Task 2: 恢复进度和结果界面

**Files:** ScriptDirectorPanel.tsx, ScriptSourceAnalysisView.tsx, DirectorSourceContext.tsx, frontend tests.

**Interfaces:** 上传附选中模型；展示提取进度/暂停/显式继续和地图/全剧资料；仅queued/running轮询，校验来源身份；无审核意见循环操作。

- [x] 覆盖父页面上传、轮询、结果、同文重开、任务不受审核状态阻断的测试。
- [x] 实现进度组件、结果预览和安全轮询；无模型时保留文件并提供开始分析。

### Task 3: 验证交付

- [x] main定向前后端回归与完整构建。
- [x] 对比业务DB指纹和基线未提交改动；所有模型用量仅隔离模拟。主库存在并发数据差异，详见结果报告，未宣称完全不变。
- [x] 记录最终行为和验证限制，无提交推送。

## 最终界面纠偏

用户明确要求恢复误改前的原版，覆盖中途新增紧凑布局建议。已使用 `/tmp/source-production-20261115/main-pre-delivery-files` 定位原有页面；后续 `main-before-latest-files` 已含错误按集制作布局，不作为基线。撤销新增默认制作卡片、紧凑状态组件和单独大纲快捷入口，恢复原“创作依据”、原分析面板及五阶段操作位置，仅将分析步骤改为提取而非审核。

- [x] 用历史基线与恢复后实际离线页面截图对照。
- [x] 原步骤组件承载进度、暂停和未知请求的只读详情入口。
- [x] 前端最终83项、后端139项、完整构建通过；没有真实付费模型、提交或推送。
