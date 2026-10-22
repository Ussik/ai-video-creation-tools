# 文本模型输出上限与流式接续

> 实现核对：2026-10-22，代码基线 `9ba5a25`。先说明当前项目行为；2026-10-16 的外部型号与能力研究保留在文末，未在本次联网复核，不能作为当前供应商额度或配置依据。Token 数量不等于中文字数。

## 当前请求参数

模型最大输出、请求显式上限、供应商默认额度与剩余上下文是不同约束。当前文本模型支持 Responses 与 Chat Completions 协议；模型设置由供应商配置决定，不按模型名称注入固定的输出预算，也不把一家的默认值用于其他兼容接口。

| 本项目文本协议 | 容量估算和指标读取的显式输出上限 |
| --- | --- |
| Responses | 请求模板的 `max_output_tokens` |
| Chat Completions | 请求模板的 `max_completion_tokens`，其次 `max_tokens` |

新建模型的默认模板不设置上述上限；省略时沿用实际供应商或网关的行为。`output_reserve_tokens` 仅用于容量和用量预算，不能提高实际输出额度。配置 `context_window_tokens` 后，最终输入估算与实际输出上限或预留一起做[容量预检](text-model-context-capacity.md)。未配置窗口时容量保持未知，不能承诺 100,000 字符剧本一定放得下。

## 有界接续与保存

阶段生成先提交完整任务。上游明确报告 Responses `incomplete_details.reason=max_output_tokens` 或 Chat Completions `finish_reason=length` 时启用语义接续；已有完整单元但外壳不完整或缺少栏目时，也可针对缺失内容继续。普通网络中断按恢复流程处理，不把它推断为输出上限。

完整且通过字段校验的文档、语义块或场次可以保存到检查点；残缺 JSON 和未闭合正文不能当成完整草稿，也不能作为函数调用执行。下一次仍携带完整有效稿与创作要求，沿用完成结果，仅生成剩余内容。全部完成后重新执行阶段业务校验、整体独立复核，最后由用户确认保存。

每次自动处理默认最多 16 轮阶段/接续循环（含首轮，不等于最多 16 次 HTTP 请求）；每个模型步骤的格式修正与只读网络重试另受最多 3 次尝试约束。连续两轮没有新增完整单元即停止；接续共享当前阶段 30 分钟累计预算，不因下一轮而重新计时。断连前已保留完整单元时停止重发整份阶段请求，由用户明确继续后读取这些结果，并获得新的有限处理窗口。接收过程只有一份滚动中间状态，完整阶段保留后清理该状态。

接续按当前目标定义完整单元：人物小传按人物或完整设定小节，人物关系按人物对或一个完整关系变化阶段，分集大纲按一集，分集正文按一场。每个单元独立闭合，未完成的目标返回 `complete:false`，不把整份长文塞进首个单元。首次因输出上限结束且没有新增完整单元时，下一轮缩小到一个最小完整单元；收到新单元后立即保存并恢复批量接续。旧版停滞任务的断点也会采用这个策略，继续保留此前文稿。非分集接续的返回契约只允许空场次数组。再次停止时，进度会明确显示本轮已停止。

接续文档标题在首个完整单元后固定，条目或场次名称写入正文小节。重复类型、错阶段内容及已保留正文的真实冲突会拒绝结果；不能过滤错误单元后把其余部分发布为成功。

技术详情记录实际请求显式输出上限、输入 / 输出 token，以及供应商提供的推理 token 用量。省略上限时不把用量反推成真实模型硬上限；缺少推理用量时也不猜测其数值。候选修订的四轮复核限制、累计请求与 token 预算是其他层级的限制，见[用量控制](script-analysis-cost-control.md)和[任务恢复](script-task-recovery.md)。

实现位置：请求参数与上游结束状态解析为 `backend/src/infrastructure/providers/providers.ts`、`text-errors.ts`；语义接续及滚动检查点为 `backend/src/modules/script/script-stage-continuation.ts`、`script-streamed-units.ts`；默认请求模板为 `web/src/features/models/ModelSettings.tsx`。现有回归使用模拟响应，本次核对未请求真实模型或测量实际输出极限。

## 历史外部研究记录（2026-10-16，待重新核验）

下表保留上一版文档的研究记录，型号、参数、数值和链接均未在 2026-10-22 重新核验。记录不代表当前官方承诺、第三方兼容网关、账户或某次请求的可用额度；配置前应以实际服务商当前文档及请求结果确认。原生 Messages、Gemini 参数也不表示本项目已经实现对应原生文本协议。

| 原记录中的模型 / 接口 | 原记录最大输出（未复核） | 原记录参数与默认行为（未复核） |
| --- | --- | --- |
| OpenAI GPT-6.1 Sol | 128,000 tokens | Responses 使用可选的 `max_output_tokens`；官方将正文与推理 token 都计入此预算。省略参数不等于已知的固定默认值。 |
| Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | 128K tokens | Messages 使用 `max_tokens`，该参数必填；thinking token 也占用额度。 |
| Gemini 3.8 Flash | 65,536 tokens | 原生接口使用 `maxOutputTokens`，不能用其他厂商参数名推断其行为。 |
| Gemini 4 Argon | 同步请求默认最高 65,536；专门的 long decode 可达 1,048,576 | 使用统一输入输出窗口；long decode 属于不同能力，不能只把普通请求参数调大。 |
| DeepSeek V4.1 Flash / V4 Pro | 384K，即 393,216 tokens | `max_tokens` 省略时，非思考模式默认 8K，思考模式默认 64K，`reasoning_effort=max` 时默认 128K。 |

原记录引用链接（保留供复查，非本次已核验来源）：

- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI Responses 创建参数](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Claude 模型对照](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Messages 参数](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)
- [DeepSeek 模型能力](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek Chat Completions 参数与默认值](https://api-docs.deepseek.com/api/create-chat-completion)
