# 原稿目录定点修复与启动追踪实现计划

**Goal:** 在 main 修复目录重复生成和开头遗漏，保留完整候选，减少重复付费请求；普通开发启动恢复本机 Langfuse 配置。

**Architecture:** 沿用现有 LangGraph、SQLite 分析快照、累计预算、派发屏障和独立质量核对。目录格式修正使用现有结构补丁，边界问题由独立图校验并定点修复，正式目录仅在完整覆盖与原文证据通过后追加。

**Tech Stack:** TypeScript、Zod、LangGraph、Node.js 22、npm workspaces。

## Constraints

- 直接操作 main；不改原稿和正式创作成果，不擅自重试付费任务。
- 合法目录无新增模型调用；已结算候选在恢复时不重新生成。
- 保留取消、累计预算、未知派发保护和独立全文质量复核。
- 凭据只留本机忽略文件，尊重显式环境配置，不上传正文或密钥。

## Review Focus

- 正文前的标题和类型说明必须覆盖；不能改首ID掩盖内容遗漏。
- 重复、倒序、越界边界必须精确定位并保留其余语义字段。
- 修复成功、失败和中断重放都保留完整候选及失败身份。
- 结构补丁不能覆盖已经有效的字段；多页与旧检查点继续有效。
- 本机配置缺失、显式关闭和配置异常不能造成秘密输出或意外追踪。

### Task 1: 保留并恢复结构候选

Files: backend/src/modules/generation/model-output.ts、packages/shared/src/script/script-source-document.ts、backend/test/model-output-repair.test.ts。
Interface: 结构输出接受持久候选检查点与保存回调；修复返回完整合并候选，已完成响应恢复不重新请求。

- [x] 添加失败候选恢复、补丁越权和正常一次调用回归。
- [x] 实现候选持久化及复用现有字段定点修正。
- [x] 运行结构输出相关测试。

### Task 2: 目录边界修复与流程集成

Files: script-source-map.ts、新 script-source-map-boundary-repair.ts、script-source-analysis.ts、script-source-checkpoints.ts、相关 backend/test。
Interface: 有效候选零额外请求；非法边界使用精确问题及最小补丁，候选保存后恢复；原有证据检查与独立复核照常执行。

- [x] 添加首段遗漏、重复倒序、越界、证据跨界、多页恢复与无进展防重回归。
- [x] 实现目录子图与现有分析图连接，保留原有保护。
- [x] 用本次已保存响应只读重放结构和边界，不发真实模型请求。

### Task 3: 普通启动加载追踪与集成验证

Files: scripts/dev.mjs、启动环境helper及工具测试、docs/langfuse-observability.md、README.md。
Interface: 可选加载根 .env.langfuse.local；已有环境优先，显示脱敏状态。

- [x] 验证缺失、显式关闭、已有环境覆盖与无秘密日志。
- [x] 运行相关后端、tooling及构建检查，独立审阅本轮diff。
- [x] 重启 main 并核验 API/追踪；记录真实验证边界和性能证据。
