# Model Provider Forms Implementation Plan

> **For agentic workers:** Execute the user-authorized implementation in this chat with scoped implementation workers and an independent reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 标准模型配置表单化，并保留 Chat Completions、Responses 的可靠协议选择与旧配置兼容。

**Architecture:** 共用模块定义标准文本配置与旧模板识别；后端解析标准设置后复用现有请求与容量检查；前端以连接、目录和模型表单操作配置，JSON 作为专家扩展入口。相关设置只在用户保存时改变，旧任务快照不迁移。

**Tech Stack:** TypeScript、React、Mantine、Zod、Node.js test、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-09-model-provider-forms.md`

## Global Constraints

- 保留当前未提交工作、既有模型、用户选择、任务快照和自定义模板。
- Chat Completions 与 Responses 均可选，不自动更改真实 Gemini 配置。
- 不调用真实生成接口，不写用户数据库，不提交或部署。
- 表单值进入真正请求；容量预留不冒充请求输出上限。

## Review Focus

- 老模板含 thinking、自定义路径、不同流式模板时不得被静默重建或覆盖。
- 显式清空输出或推理后不能有旧模板值继续生效；新表单与高级配置不能存在不明优先级。
- 协议往返切换不丢失上下文、费用、能力及可兼容请求参数。
- 普通/工具/非流式请求使用同一解析结果，截断工具与取消仍安全结束。
- 标准图片/视频入口无需 JSON，未知自定义接口仍可保存及恢复。

## Task 1: Shared settings and provider adaptation

**Files:** 新共用文本接口设置模块、`backend/src/infrastructure/providers/`、`backend/src/modules/models/validation.ts`、隔离请求测试。

- [x] 确定共享设置接口及旧配置识别，覆盖协议往返与未知字段保留。
- [x] 标准配置在三条请求路径统一解析，校验实际输出与推理字段。
- [x] 用模拟 fetch 证明标准表单配置生效、无参数时不注入额度、旧自定义模板保持。

## Task 2: Model configuration forms

**Files:** `web/src/features/models/`、相关 Web 回归。

- [x] 增加标准文本参数表单及最终发送设置摘要，输出预留放入高级区域。
- [x] 对接协议选择和旧设置编辑，普通添加/保存模型无需 JSON。
- [x] 增加现有标准视频预设表单入口，保留已有图片与计费表单。
- [x] 覆盖保存、清空、协议往返、旧模板、目录导入与编辑恢复。

## Task 3: Integration and acceptance

**Files:** 隔离集成测试、研究验收文档。

- [x] 独立复核配置兼容与实际请求，修复已证实问题。
- [x] 运行相关回归、类型和架构检查并记录准确结果。
- [x] 用隔离浏览器/本地测试数据验证主要配置流程，完成验收记录。

验收：`docs/research/2026-11-09-model-provider-forms.md`。后端160项、前端核心34项、画布/图片/选择/视频扩展134项不同测试通过（合计328项，重复运行不重复计数）；构建、类型、架构、UI检查通过。真实模型与渠道支持未验证。
