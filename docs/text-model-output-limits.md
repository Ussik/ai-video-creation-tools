# 文本模型输出上限与流式接续

核对日期：2026-10-16。以下为各厂商官方文档公开的模型能力，不代表第三方兼容网关、账户或某次请求会自动开放同等额度。Token 数量不等于中文字数。

| 模型 / 接口 | 官方最大输出 | 请求参数与默认行为 |
| --- | --- | --- |
| OpenAI GPT-6.1 Sol | 128,000 tokens | Responses 使用可选的 `max_output_tokens`；官方将正文与推理 token 都计入此预算。省略参数不等于已知的固定默认值。 |
| Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | 128K tokens | Messages 使用 `max_tokens`，该参数必填；thinking token 也占用额度。 |
| Gemini 3.8 Flash | 65,536 tokens | 原生接口使用 `maxOutputTokens`，不能用其他厂商参数名推断其行为。 |
| Gemini 4 Argon | 同步请求默认最高 65,536；专门的 long decode 可达 1,048,576 | 使用统一输入输出窗口；long decode 属于不同能力，不能只把普通请求参数调大。 |
| DeepSeek V4.1 Flash / V4 Pro | 384K，即 393,216 tokens | `max_tokens` 省略时，非思考模式默认 8K，思考模式默认 64K，`reasoning_effort=max` 时默认 128K。 |

## 实现原则

模型最大输出、请求显式上限、供应商默认额度与剩余上下文是不同约束。当前模型设置继续由供应商配置决定，不按模型名称注入固定的输出预算，也不把一家的默认值用于其他兼容接口。

阶段生成先提交完整任务。只有上游明确报告 `max_output_tokens` 或 `finish_reason=length` 才启用接续。完整且通过结构校验的文档、语义块或场次可以保存到检查点；残缺 JSON 和未闭合正文不能当成完整草稿，也不能作为函数调用执行。下一次仍携带完整有效稿与创作要求，沿用完成结果，仅生成剩余内容。全部完成后仍需整体独立复核和用户确认保存。

每次自动处理最多 16 轮，连续两轮没有新增完整单元即停止；接续共享当前阶段 30 分钟累计预算，不因下一轮而重新计时。断连前已保留完整单元时停止重发整份阶段请求，由用户明确继续后读取这些结果，并获得新的有限处理窗口。接收过程只有一份滚动中间状态，完整阶段保留后清理该状态。

接续按当前目标定义完整单元：人物小传按人物或完整设定小节，人物关系按人物对或一个完整关系变化阶段，分集大纲按一集，分集正文按一场。每个单元独立闭合，未完成的目标返回 `complete:false`，不把整份长文塞进首个单元。首次因输出上限结束且没有新增完整单元时，下一轮缩小到一个最小完整单元；收到新单元后立即保存并恢复批量接续。旧版停滞任务的断点也会采用这个策略，继续保留此前文稿。非分集接续的返回契约只允许空场次数组。再次停止时，进度会明确显示本轮已停止。

技术详情记录实际请求显式输出上限、输入 / 输出 token，以及供应商提供的推理 token 用量。省略上限时不把用量反推成真实模型硬上限；缺少推理用量时也不猜测其数值。

## 官方来源

- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI Responses 创建参数](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Claude 模型对照](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Messages 参数](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)
- [DeepSeek 模型能力](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek Chat Completions 参数与默认值](https://api-docs.deepseek.com/api/create-chat-completion)
