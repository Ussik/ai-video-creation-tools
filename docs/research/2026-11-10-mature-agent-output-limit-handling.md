# 成熟 Agent 如何处理模型输出过长

核查日期：2026-11-10。范围为 Codex、OpenCode、DeepSeek Harness 公开源码，以及 Claude Code 官方文档和更新记录；另以本机 Harness 已分发 JavaScript 交叉核对关键路径。公开仓库链接固定到本次核查提交，安装包静态分析不代表已验证运行时插件配置。

## 结论

没有产品能靠流式展示、上下文压缩或一个配置值消除模型单次输出硬上限。长任务主要通过多次模型请求、工具和文件逐步完成。真正触及输出上限后的策略并不统一：Claude Code 和 OpenCode 有自动接续；Codex 的明确 `max_output_tokens` incomplete 路径会终止；本机 Harness 核心保存部分结果后以 `max-tokens` 结束，扩展仍可排入下一步。

需要分别处理四种情况：模型输出额度用尽、输入上下文耗尽、工具返回过大、工具调用参数被截断。它们的恢复操作不同，不能统一归为网络重试或 JSON 解析失败。

## 产品对比

| 产品及证据范围 | 明确输出截断 | 输入上下文增长 | 工具输出或调用完整性 |
| --- | --- | --- | --- |
| Claude Code：官方更新记录及文档，核心未完整公开 | 官方明确记载自动恢复和继续生成；精确次数、完整算法不公开 | 自动摘要；重复压缩仍无进展会停止 | 大工具结果写文件后提供预览和路径；API 文档要求重新获取完整的残缺工具调用 |
| OpenCode：MIT 开源核心及回归测试 | 保留已产生内容，追加继续指令；连续三次 `length` 后停止，即首轮加最多两次自动接续 | 主动压缩和 overflow 压缩独立处理 | 残缺工具调用不执行，要求拆小后重新提供完整参数；大结果落盘 |
| Codex：公开 Rust 源码及回归测试 | Responses 的明确 `max_output_tokens` incomplete 是终止错误，没有统一自动续写 | 达阈值后压缩历史，再推进后续工作 | 工具结果进入历史时独立限额；Code Mode 可保留原始结果 |
| DeepSeek Harness：MIT 公开核心，与本机 0.2.2-rc.1 关键路径交叉核对 | 保留正文后返回 `max-tokens`，展示截断提示并引导用户继续；没有下一步消息时结束，扩展钩子可补充下一步 | 预先按压力压缩，确认 context overflow 后有限恢复 | 截断时丢弃工具调用；提供工具结果中部裁剪模块 |

## Codex：不能把普通工具循环当成截断续写

核查提交：[`c875667eb837663697d5ffa32d375043434e73b4`](https://github.com/openai/codex/tree/c875667eb837663697d5ffa32d375043434e73b4)。

- [Responses SSE 解析](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/codex-api/src/sse/responses.rs#L451)将非 `interrupted` 的 incomplete 转为 `ResponseIncomplete`；[错误重试判断](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/protocol/src/error.rs#L445)不为它提供重试延迟。
- [`incomplete_response_is_terminal` 测试](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/tests/suite/client.rs#L3892)模拟 `max_output_tokens`，即使允许两次流重试，仍只有一次业务请求，并记录用量。
- [后续轮次与压缩](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/session/turn.rs#L663)、[工具调用后的 follow-up](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/stream_events_utils.rs#L370)解释了长任务如何通过多个完整请求推进，不能据此推断任意长回复会自动续写。
- [工具结果处理](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/tools/context.rs#L228)与模型正文输出是不同限制。[官方配置参考](https://developers.openai.com/codex/config-reference/)也区分上下文窗口、自动压缩阈值和工具输出额度。

以上结论针对核查到的公开实现和明确结束原因，不扩展到所有 Codex 桌面端、托管服务或后端内部策略。

## Claude Code：官方确认自动恢复，但不能声称完整算法开源

核查公开仓库提交：[`6e1e44f6433bfa17d198e932bff53373aa229eea`](https://github.com/anthropics/claude-code/tree/6e1e44f6433bfa17d198e932bff53373aa229eea)。

- [v2.1.269 更新记录](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md#L3588)明确提到回复在 output-token limit 处被切断后自动恢复。
- [v2.1.271](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md#L3529)添加恢复提示；[v2.1.299](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md#L1398)修复非流式降级后截断静默结束；[v2.1.281](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md#L2812)修复无效工具参数与输出限制交替导致的无限重试。
- [官方环境变量](https://code.claude.com/docs/en/env-vars#variables)说明 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 受模型能力上限约束。固定思考预算也受输出额度约束，不能把所有额度理解为可见正文空间。
- [上下文管理](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)与[压缩无进展保护](https://code.claude.com/docs/en/troubleshooting#auto-compaction-stops-with-a-thrashing-error)处理后续请求的输入空间。[工具输出限制](https://code.claude.com/docs/en/tools-reference#output-limits)采用文件和有限预览。
- [Anthropic API 停止原因](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)把 `max_tokens`、`model_context_window_exceeded`、`pause_turn` 分开。官方继续生成示例保存已有 assistant 输出后请求继续；残缺 `tool_use` 要重新获取完整调用，不能执行半截参数。

公开仓库包含文档、更新记录、插件和示例；[许可证](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/LICENSE.md)为商业条款。这里的产品行为由官方记录确认，不代表拿到了核心完整源码或精确恢复算法。

## OpenCode：可直接研究的有界接续实现

核查提交：[`a010a427e63c1f6406cef313041768a2381d3f2b`](https://github.com/anomalyco/opencode/tree/a010a427e63c1f6406cef313041768a2381d3f2b)。

- [`length` 转 OutputLimit](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/step.ts#L295)。
- [恢复循环](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/llm.ts#L348)保留内容，追加继续消息。其[指令](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/llm.ts#L37)要求不重复、不回顾，并把剩余工作拆小。
- [保留 Partial 后继续的测试](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/test/session-runner.test.ts#L6208)和[连续三次截断后停止的测试](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/test/session-runner.test.ts#L6275)同时证明恢复与终止条件。
- [残缺工具调用处理](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/publish-llm-event.ts#L40)要求更小的调用和完整参数；[工具结果](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/tool-output.ts#L69)落盘后返回预览和路径。
- [输入 overflow 的压缩](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/llm.ts#L312)与输出接续分开；[请求预算](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/model-request.ts#L53)在发送前处理模型额度和输入占用。

“最多两次自动接续”是本次 OpenCode 实现的策略，不是所有产品或模型的统一标准。

## DeepSeek Harness：明确状态、持久化和工具完整性

官方 MIT 公开仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。核查提交：[`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)，提交日期 2026-11-04；核心包版本同为 `0.2.2-rc.1`。

- [agent.ts:566](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L566)先持久化 assistant 内容后返回 `max-tokens`；[结束前扩展钩子](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L395)可添加下一步，没有则结束。
- [assembler.ts:130](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/assembler.ts#L130)在输出截断时过滤全部工具调用，并同步 replay 元数据。
- [上下文超限恢复](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/index.ts#L213)只处理 `CONTEXT_WINDOW_EXCEEDED`，有次数和持久化进展要求；[裁剪后压缩](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/index.ts#L302)与输出接续不同。
- [截断提示 UI](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts#L41)及[对应设计记录](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/.agents/notes/archived/bug-fix/2026-08-12-max-tokens-turn-end-notice.zh.md)说明保留部分输出、展示提示、引导用户发送“继续”。
- [失败任务手动继续白名单](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/continuation.ts#L8)针对网络/服务失败，不包含 `max-tokens`。不能用该按钮的存在证明输出超限自动恢复。

公开源码中已核对的 agent-loop、assembler、overflow 恢复逻辑与本机分发代码一致；未验证整个安装包与仓库逐字一致。

安装包：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，版本 `0.2.2-rc.1`。SHA-256：`f21d83abfb33d463822a52c439cc9b15c8245dbce4ae4cf9424c90eae8eba94f`。以下路径相对于归档中的 `dsh/node_modules/`，行号针对本次分发代码。

| 模块与行号 | 核对结果 |
| --- | --- |
| `@earendil-works/pi-ai/dist/api/simple-options.js:1–27` | 从请求或模型取得输出额度，按 `contextWindow - estimatedInput - 4096` 限制；剩余不足时可低至 1 token。这个策略适用于该适配链，不能不加判断地照搬到所有协议和长篇业务。 |
| `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1478–1526` | 上下文溢出映射为独立错误；`length` 映射为 `max-tokens`。 |
| `@deepseek-ai/dsh-agent-loop/lib/index.js:939–958` | 将已有 assistant 内容、流及用量持久化后，`max-tokens` 直接返回，不进入工具执行。 |
| `@deepseek-ai/dsh-agent-loop/lib/index.js:740–799` | 结束前发 `agent/turn-stopping` 钩子；若 inbox 没有下一步消息则退出。不能据此断言任何插件组合都不会接续。 |
| `@deepseek-ai/dsh-llm/lib/index.js:1047–1096` | max-tokens 时丢弃工具调用，并一致修剪 replay 元数据；中断流只保留文本/推理块。 |
| `@deepseek-ai/dsh-compaction-basic/lib/index.js:124–145, 834–908` | 按窗口、输出预留和余量计算压力阈值；有主动压缩，也有 context overflow 后的有限恢复，要求产生持久化进展才重试。 |
| `@deepseek-ai/dsh-compaction-basic/lib/index.js:362–366` | 摘要自身若被输出上限截断，拒绝把它作为完整 checkpoint。 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:8–15` | 默认 8192 **字符**的工具结果裁剪阈值，保留首尾并加标记。这不是模型正文 8K token 上限。 |

本次选定原始成员的只读提取目录：`/private/tmp/harness-output-research-20261110/`。REA 父证据：`ev_250d30771681da3c3385328fdb23369695fb34441886dcb94586f67dd9aea8f3`、`ev_a2de901c1ec8ac9f4b6cf095ec4b70b1f8361ec3a956317dbd7893baed7a3475`。范围是选定核心模块，未读取凭据、用户会话或插件启用配置，未执行应用或真实模型调用。

## 对剧本生成与审读的设计含义

以下是根据上述实现得出的业务设计建议，不是声称外部产品已经实现了我们的剧本契约。

1. **完整任务由多个完整单元构成。**生成按人物、集、场次增量保存；审读按段落、维度或问题批次保存，最终再整体验证。每次工具调用或结构化响应保持在可完成的额度内。
2. **接续与网络重试分开。**明确输出截断后保留已有合格内容，生成剩余部分；重复、冲突、没有新增完整单元时缩小任务或停止。网络错误、输出耗尽和业务缺项使用各自恢复路径。
3. **完整性是执行边界。**残缺 JSON 或工具参数不执行、不发布；保留可验证的完整语义单元。正文完整但缺分场等业务缺项，可以针对缺失部分补齐后重新校验。
4. **上下文管理保留资料来源。**压缩历史和工具噪声，原稿持久保存并按需读取。压缩输入不会补回已经丢失的输出。
5. **恢复过程可见且能停止。**展示已保留内容、当前接续状态、真实停止原因和用量；设置取消、无进展、调用方额度等保护，避免无限重试和重复费用。

项目当前额度与接续说明分别见[容量配置](../text-model-context-capacity.md)和[输出限制](../text-model-output-limits.md)。这里没有新增运行时代码，也没有用真实收费生成验证网关的实际硬限制。
