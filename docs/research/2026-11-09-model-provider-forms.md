# 模型配置表单与协议适配验收

日期：2026-11-09。用户授权开始实施，明确保留 Chat Completions 与 Responses 选择。参考本机 Harness 的配置分工，未复制其默认模型额度。

## 交付行为

- 新建标准文本模型只填连接、模型 ID、协议和表单选项；无需写请求 JSON、请求路径或响应提取路径。
- 表单管理实际最大输出、Chat 兼容输出字段、推理强度和 thinking 兼容开关。默认不发送这些参数，不根据模型名猜测容量或支持情况。
- Responses 将额度映射到 `max_output_tokens`，Chat 映射到选定的 `max_completion_tokens` 或 `max_tokens`。推理强度分别进入 `reasoning.effort` / `reasoning_effort`，显式 thinking 选择进入 `thinking.type`。
- 上下文容量只用于本地完整请求估算；高级输出预留是没有实际输出参数时的估算备用值。实际请求额度优先。额度输入接受十进制 K/M。
- 标准设置只有 `text_api` 一份受管请求来源，重复旧模板配置会被拒绝。后端在统一入口解析，流式、工具和非流式共用此结果。
- 常见旧标准模板仅在用户保存时转为表单设置，保留静态兼容参数、连接扩展、上下文、能力和费用。未知路径、额外包络、独立流式模板、复杂推理预算继续保留自定义模式。
- 协议往返保留兼容参数；自定义模式切换协议不重建模板。复杂自定义改为标准需要在界面明确执行重建，本次编辑中可切回原接口配置，公共设置继续保留。
- 自定义流式/工具额度与非流式额度分别展示，防止流式 8K、非流式 64K 时只显示较大值。
- 图片表单保持原有工作方式；视频新增现有 Seedance 2.0/2.5 接口选择及默认画幅、分辨率、时长。默认值进入实际请求及新建视频节点，已选节点/分镜值优先。

## 代码位置

- 共享受管文本设置与保守迁移：`packages/shared/src/models/text-api-settings.ts`。
- 统一请求适配：`backend/src/infrastructure/providers/providers.ts`；模型保存校验：`backend/src/modules/models/validation.ts`、`routes.ts`。
- 文本表单：`web/src/features/models/TextModelApiSettings.tsx`；上下文/高级预留：`TextModelContextSettings.tsx`；表单集成：`ModelSettings.tsx`。
- 视频表单：`web/src/features/models/VideoModelConfig.tsx`；共享默认与校验：`packages/shared/src/models/video-model-settings.ts`；画布默认：`ProjectCanvas.tsx`、`canvas-model-parameters.ts`。

## 自动验证

后端 160 项不同测试通过：`text-api-settings`、`providers`、`text-tools`、`text-image-input`、`text-video-input`、`text-output-limit-diagnostics`、`text-provider-body-error`、`model-defaults`、`provider-settings`、`text-context`、`text-script-review-policy`。涵盖两协议 × 三条真实请求构造路径、结构化输出、原生工具调用与后续历史、清空参数无残留、输出预算优先、复杂模板保留、POST/PATCH/目录导入保存及视频默认请求。

前端核心 34 项通过：`text-model-api-settings`（11）、`text-model-context-settings`（5）、`model-settings-name`（14）、`model-default-settings`（4）。视频表单和画布模型参数另 18 项通过。独立复核实际运行新增文本与视频回归 12 项，结果通过，与上述计数重复，不重复计入。

最终扩展验收运行 `video-model-config`、`canvas-model-parameters`、`canvas-video-reference-integration`、`image-model-settings`、`model-selection` 五文件，134/134 通过，包含前述视频/参数 18 项。与后端160和前端核心34合计 **328 项不同测试通过**。画布集成测试仍输出既有 React `act` / `flushSync` 提示，无失败。

共享构建、后端类型检查、Web 类型检查及生产构建、架构/UI 组件检查、`git diff --check` 通过。Web 构建保留既有较大 bundle 提示。模拟请求未调用真实模型；涉及本地监听的 provider 测试使用必要的沙箱外本地监听权限重跑，断言全部通过。

独立审查发现两处兼容问题并确认修复：独立流式模板额度摘要错误；模式备份恢复覆盖期间编辑的公共设置。对应回归均通过，无剩余阻断问题。

## 浏览器验收

使用 Ego Lite 独立 TaskSpace 30、前端 `127.0.0.1:18880`、后端 `127.0.0.1:18080`，数据目录为 `/tmp/video-studio-provider-forms-preview`。只创建无密钥的 `fixture.invalid` 测试提供商，不启用生成 worker。

1. 不打开高级 JSON，新增文本模型，填写最大输出 `64K`、上下文 `1M`；选择 Chat、兼容 `max_tokens`，往返切换 Responses / Chat。
2. 保存后 GET `/api/models` 返回 `protocol: chat_completions`、`text_api: { mode: standard, max_output_tokens: 64000, chat_output_field: max_tokens }`、`context_window_tokens: 1000000`。
3. 重新编辑恢复 `64K`、`1M`、兼容字段，摘要显示 `max_tokens = 64,000 tokens`，高级 JSON 保持折叠。
4. 不编辑 JSON 新增视频模型，选择 Seedance 2.5，再选择 `9:16`、默认 `720p`、时长 `12` 秒。保存返回上述默认值和 `seedance_2_5` 配置。
5. 已关闭本轮测试 TaskSpace 并停止测试服务。

截图：`docs/superpowers/acceptance/2026-11-09-model-provider-forms/text-options.png`。

未改写真实数据库、真实 Gemini 的协议或额度，未读取 API 密钥，未发起真实模型请求，未提交或部署。网关实际接受的参数与模型输出极限仍须以渠道证据确认；表单发送参数本身不证明网关支持。
