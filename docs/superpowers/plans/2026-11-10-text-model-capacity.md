# 文本模型容量与请求额度实施计划

**Goal:** 分开渠道能力与请求额度，以统一请求计划驱动发送、容量校验、用量预留和诊断。

**Architecture:** 在现有 settings 中增量保存带来源和渠道范围的能力及用户覆盖；共享纯解析器决定 shared/separate/unknown 预算，后端最终请求使用同一计划。保留 Harness 表单和旧配置语义，复用完整单元接续。

**Tech Stack:** TypeScript、React/Mantine、Fastify、SQLite、node:test。

**Spec:** [调研设计](../../research/2026-11-10-text-model-capacity-design.md)。用户已明确要求开始处理，继续执行到验证完成，不增加计划审批或提交步骤。

## 全局约束

- 保留所有既有未提交改动、真实模型额度及历史文稿，不主动调用收费生成。
- 旧上下文配置继续按共享预算兼容，固定输出不静默缩减，未知能力不推断。
- 新能力以渠道地址、协议和模型ID绑定；发现值与手工覆盖分开。
- 工具、结构化格式、历史和多媒体属于输入预算；推理不重复计入总输出。
- 配置未确认前只在草稿保存，目录刷新不覆盖手工额度和能力。

## 任务与归属

- [x] 核心契约与预算（text_budget_core）：shared/text-capabilities.ts、text-api-settings.ts、text-context-settings.ts；backend/text-context.ts、text-tools.ts；纯函数及兼容回归。
- [x] 配置界面（text_capacity_ui）：HarnessTextModelOptions、TextModelApiSettings、TextModelContextSettings、ModelSettings、样式与组件测试。能力与额度分区、模式和来源、目录更新仅写发现草稿。
- [x] 目录能力（text_capability_catalog）：model-catalog、catalog routes、目录与API测试。无能力不造值，按端点绑定元数据。
- [x] 请求接入和计数（root）：最终普通/流式/工具/Anthropic/后台请求使用同一计划；临界容量按显式支持接入计数；保存完整诊断与请求计划，兼容现有活动数据。
- [x] 业务回归与验收（root）：隔离库真实创作入口，原额度保留、模式参数、来源、shared/separate、计数失败、截断接续和确认前无正式写入；浏览器核对实际表单和保存取消。
- [x] 独立审查和文档（root+空闲代理）：复核端点绑定、能力未知、自动小额度、历史断点、配置刷新；补当前行为与验证限制。

## Review Focus

- 更换渠道、协议或模型ID后发现元数据必须失效，不能绕过真实限制。
- 旧固定65536和高级预留128000不相加，刷新/取消/恢复不可偷偷改真实配置。
- 自动能力未知不能省略输出参数冒充自动，上游默认不可绕过必填协议。
- provider计数不可跨渠道发送原稿，计数失败只能明确回退估算，取消不得吞掉。
- 语义接续、累计计费和单请求窗口分开；原文与任务覆盖要求保留。

## 验证命令

各负责者运行定向 node --import tsx --test、shared build 和类型检查。root 合并后运行有关目录、预算、适配器、创作入口和前端表单回归、工程 guard、类型/构建与差异格式检查。浏览器用隔离环境，结束后关闭临时服务。

## 已完成验证

- 2026-11-10：后端相关 23 个测试文件共 289 项通过；前端相关 6 个文件共 63 项通过。完整 `npm run build`、架构与 Mantine UI guard、TypeScript 和 `git diff --check` 通过。
- 独立只读审查推动修复：Schema 与历史媒体漏算、固定额度被中间体改变、旧预留误拦、上游默认状态、范围失效与保存校验、模板实际模型变化、自动最小额度触发计数边界、非对象模板静默替换。
- 隔离服务 18081/18881 和 Ego TaskSpace 36 完成实际布局、三模式展示、取消保留固定65536、独立能力及上游模式保存验收；浏览器空间已 finish，临时服务已关闭。8000/8888 原服务保留。
- 真实库仅只读复核：Gemini 仍为 Responses / fixed65536 / context1000000 / reserve128000，没有真实收费生成。
- 截图与验收见 [记录](../acceptance/2026-11-10-text-model-capacity/README.md)。真实服务能力、计数端点支持及极限输出尚未做付费实测，不宣称所有上游截断都可消除。
