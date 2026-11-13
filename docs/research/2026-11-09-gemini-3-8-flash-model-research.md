# Gemini 3.8 Flash 型号与输出限制调研

核查日期：2026-11-09。只读核查 Google 官方文档、灵算公开资料及此前对应任务日志；未调用生成接口或修改模型配置。

## 核心结论

`gemini-3.8-flash` 是 Google 正式稳定型号。官方最大输出为 **65,536 tokens**，输入上限为 **1,048,576 tokens**。此前项目多次约 8K 输出后收到 `max_output_tokens`，低于该型号官方最大能力，不能把这个运行现象视为型号原生只有 8K。

本地请求模板没有显式输出上限，`output_reserve_tokens=128000` 只是程序容量估算。请求实际经过第三方 Responses 兼容网关；未取得其模型映射与参数转译证据，因此约 8K 的实际限制可能与渠道默认、转译、部署上限或模型映射有关，具体来源未定。

## 已确认的官方能力

| 项目 | 官方文档内容 |
| --- | --- |
| 稳定模型 ID | `gemini-3.8-flash` |
| 型号页最新更新 | 2026 年 9 月 |
| 输入上限 | 1,048,576 tokens |
| 输出上限 | 65,536 tokens；该数值是最大能力，不是已核实的省略参数默认值 |
| 输入类型 | 文本、图片、视频、音频、PDF |
| 输出类型 | 文本；该型号不直接生成图片或音频 |
| 思考级别 | `low`、`medium`、`high`；默认 `medium`；`minimal` 不支持并报错 |
| 结构化与工具 | 支持结构化输出、函数调用、代码执行、搜索与 URL 上下文等 |
| 官方定位 | 长流程软件工程、自主代理与复杂企业工作流，兼顾 Flash 速度与成本 |

型号及能力来源：[官方型号页](https://aistudio.google.com/docs/models/gemini-3.8-flash)、[3.8 新功能与迁移说明](https://aistudio.google.com/docs/whats-new-gemini-3.8)。上述定位不构成中文长剧本创作质量的独立实测。

## 思考与接口边界

官方说明总输出预算包含思考 token；若硬上限在思考阶段耗尽，可以出现正文为空或不完整，思考 token 仍计费。降低思考级别与提高允许输出量是两种不同调节。[思考文档](https://aistudio.google.com/docs/thinking#token-limits)

该思考文档中关于“同步默认 64K / long decode 最高 1M”的特定段落明确针对 Gemini 4，不能套用为 3.8 的默认值或超过 65,536 的能力承诺。

Google 官方 OpenAI 兼容文档展示的是 `chat/completions`，包括 3.8 使用 `reasoning_effort="low"` 的示例，且说明 Gemini 3 的思考不能简单关闭。这不能证明灵算的 Responses 接口也透传同样参数。[官方 OpenAI 兼容文档](https://aistudio.google.com/docs/openai)

## 价格

以下为 Google 官方 Standard 价格，单位美元／百万 tokens，不代表灵算扣费。

| 时间 | 输入 | 输出（含思考） |
| --- | --- | --- |
| 截至 2026-12-31 的优惠价 | $0.75 | $3.75 |
| 自 2027-01-01 起的标准价 | $1.50 | $7.50 |

来源：[官方定价](https://aistudio.google.com/docs/pricing#gemini-3.8-flash)。实际使用还取决于缓存、调用层级及其他服务费用。

## 灵算公开资料核查

- [公开首页](https://edge.lingsuan.org/)可访问，文档链接指向[飞书文档中心](https://my.feishu.cn/wiki/I5b1wYQiti3NY9kCp8scjWLpnu8)，匿名访问落到登录页。
- [模型价格目录](https://edge.lingsuan.org/api/v1/pricing/models)匿名返回 401；[模型广场](https://edge.lingsuan.org/api/v1/model-plaza)返回未启用。
- 公开客户端有模型别名映射的界面实现，但未暴露实际站点映射值，不能据同名 remote ID 证明底层模型身份。
- 未找到公开的 `gemini-3.8-flash` 输出默认值、固定 8K 说明或 Responses 参数映射。客户端中一处 8192 是请求头字段长度校验，与生成预算无关。

## 对当前剧本项目的建议

先确认渠道的实际模型身份、单次允许输出及 Responses 参数转译；确认支持后显式验证 `max_output_tokens=32768` 或 `65536`，检查真实发送参数、最终状态及用量。不能仅改本地估算预留，不能承诺参数一定被网关接受或生效。

可分别试验写作用 `low`、复杂一致性审读用 `medium`，观察质量、正文量与耗时；这是待实测建议，`low` 不等于关闭思考，也不保证整份剧本完整。无论额度提高多少，仍须保留完整单元接续、合法断点和最终覆盖校验。
