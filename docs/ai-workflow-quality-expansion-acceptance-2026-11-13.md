# 全部 AI 接口可靠性增强与验收（2026-11-13）

本轮从 `e1fe35e` 继续，工作分支为 `codex/langfuse-observability`。增强已实现并完成自动验证及四个代表性真实样本验证；其中 Claude 分镜仍未通过质量复查。不能将执行完成、结构有效或 Langfuse 记录完整解释为内容质量通过，也不能用这四个样本推算总体成功率。

## 实现与覆盖边界

- 复用现有模型适配、任务、检查点、幂等标识和付费请求派发屏障，保留所选模型、提供商及推理配置；没有新增平行的业务持久层或自动付费重发机制。
- 复杂流程使用实际 LangGraph：分镜大纲审核与逐镜扩写、脚本文档依赖、原稿分析与复核、视觉整理、提示词生成与独立复核、长视频逐镜反推。简单理解、连续性、画布及媒体接口接入共享阶段、结构和结果诊断，具体边界见[覆盖矩阵](./research/2026-11-13-non-storyboard-workflow-coverage.md)。未新增独立语义审核的入口明确记为 `inconclusive`，保留原人工确认流程。
- 累计预算覆盖真实派发、token 与活跃时间，按实际文本和单元规模冻结额度；恢复不清零，只有明确继续且额度耗尽时才允许有限续额，最多三份额度。修复检查点读取前的并发准入，防止旧执行覆盖新用量。
- 分镜先审核大纲，再扩写；局部修复只替换逐字证据授权的字段，保留身份、顺序、声音及未授权时长。全流程保留一次自动内容修复上限及重复问题停止规则。按实际扩写提示词依赖判断检查点复用，修正跨场相邻镜变化后的旧缓存复用。
- 图片、视频、语音保留真实能力适配及原任务恢复；付费创建不自动重发，轮询只重试可恢复错误，鉴权/JSON/契约错误及时停止。下载和损坏媒体有独立原因；远端取消能力未实现时明确仅支持本地停止。
- Langfuse 分开记录传输交付、结构校验与 `passed / needs_work / inconclusive` 质量结论，记录细阶段和修复效果。LangGraph 隔离继承的 LangSmith 回调及环境开关，保留本机 Langfuse；不导出正文、提示词、模型输出或凭据。

## 自动验证与独立审查

| 验证 | 结果 |
| --- | ---: |
| 完整后端回归 | 3390 / 3390 |
| 完整前端回归 | 1704 / 1704 |
| 启动、部署等 tooling 回归 | 9 / 9 |
| 最终统一 `npm run build` | 通过，包含架构检查、UI 组件检查、共享包、后端和前端构建 |

完整回归初次暴露的大纲审核 fixture、已选技能和参考预算上下文问题均已修复。最后大纲复核上下文与原稿失败诊断调整有定向回归和类型检查，最终统一构建在这些调整后执行通过。没有并行清理共享构建产物。

独立审查覆盖累计预算、显式续额、取消后的派发、迟到结果归属、检查点覆盖、字段授权和跨场缓存；发现的并发及缓存边界已修正。对下述 Claude 样本另做只读检查，未发现授权补丁漏执行或旧缓存覆盖的证据。

本机测试日志保存在 `/tmp/ai-workflow-expansion-backend-final.log`、`/tmp/ai-workflow-expansion-web-full.log`、`/tmp/ai-workflow-tooling-tests.log`、`/tmp/ai-workflow-expansion-build-final.log`。这些临时日志不随 Git 提交。

## 固定来源真实验收

仅使用 `127.0.0.1:8002` 的隔离数据库与项目，来源为同一 12 秒信封检查场景。保留既有 `claude-sonnet-5-5` / Anthropic Messages 和 `gpt-6.1-sol` / Responses 配置，没有为通过验收切换模型或放宽规则。分镜两组均要求两镜；非分镜样本使用 GPT 配置。

| 样本 | 最终业务结果 | 耗时 | 真实派发 | 观测 input / output / reasoning tokens | 重放或保存 |
| --- | --- | ---: | ---: | ---: | --- |
| GPT 分镜 | 首次流程 passed，无内容修复 | 118.906 秒 | 5 | 53671 / 4492 / 154 | 保存两镜成功，commit 重放无重复创建 |
| Claude 分镜 | 一次内容修复后仍 needs_work | 851.695 秒 | 13 | 102087 / 34478 / 0 | HTTP 409 `candidate_review_required`，未保存未通过候选 |
| 原稿分析 | 首次 ready、quality passed | 24.08 秒 | 3 | 17730 / 833 / 38 | 同 operation 重放新增请求 0 |
| 提示词整理 | 首次 quality passed | 24.53 秒 | 2 | 11588 / 1003 / 0 | 同 operation 重放新增请求 0 |

每组只执行本轮有界流程，没有为使报告全绿而追加付费修复。两项非分镜首次即通过，因此真实样本不覆盖它们的失败修复分支。样本也不验证全部模型、长剧本质量、高并发、所有媒体生成链路或浏览器交互。

Claude 初次导演复核发现镜头交接的手部动作阶段冲突，仅授权修改前镜的 `directing.cut` 和 `end_state`。实际补丁严格执行这些授权，保留其他字段。复查发现同镜 `video_prompt` 仍描述拇指与封口相距 2–3 厘米，与已修改的轻触状态冲突。模型首次审核的修复字段范围不完整，自动流程在一次修复后以 `needs_work` 结束，未继续循环；保存门禁正确拦截。此样本不能称为质量已解决，也不能仅据相同问题类型断言触发了相同指纹的停止诊断。

Claude 有四次字段契约失败、一次 JSON 失败以及一次 accepted 后断流历史，后续格式修正和质量结果均单独保留。最终账本所有 attempt 已 settled，`uncertain_requests=0`、estimated input/output 为 0；但断流子请求只报告 input=9687、output=0，最终输出及计费仍无法从观测确认。表中是已报告/已观测 token，不能解释为完整账单或断流没有费用。推理 tokens 单列，不重复累加到 output/total；没有可靠价格映射，不推算金额。

以上真实调用使用本轮验收服务的构建；之后补充的大纲技能/参考预算/目标模型上下文及原稿失败诊断调整仅通过自动验证和最终构建，没有再发起付费整轮验证。因此不将最后这些补丁解释为已获新的真实模型质量证据。此前[分镜真实验收](./langgraph-storyboard-live-acceptance-2026-11-13.md)是独立历史样本，保留原报告，不替代或覆盖本轮结果。

## Langfuse 实际回读

四条 trace 共 57 个 observations，逐 attempt 用量与本地账本、结构/质量事件集合核对一致，无缺失或重复。本次核对的是以下新 trace，不改写历史记录。

| 样本 | Trace ID | Observations | 最终质量 |
| --- | --- | ---: | --- |
| GPT 分镜 | `6ef5e9e30bc2bdb205fc912c2cbc3e69` | 13 | passed |
| Claude 分镜 | `10fafa25c0cc4aaef63475d69a52fcb0` | 30 | needs_work，repair_effect=unchanged |
| 原稿分析 | `1b5da75dbdb8a92f72108f4196b33044` | 8 | passed |
| 提示词整理 | `393ddd77779af073a6689120e085320d` | 6 | passed |

四条 root 均为 `succeeded`、`incomplete_children=0`；Claude 失败的传输 child 与成功完成的 root 同时保留，root 的质量仍为 `needs_work`。中文细阶段、结构与质量事件实际到达 Langfuse，未用传输完成冒充质量通过。

全部 observation 的 input/output 为 null、原始 model/modelParameters 为空，业务标识仅为不可逆引用，trace public=false；未发现正文、原始业务 ID、供应商 endpoint 或凭据导出。关联由阶段、时间和逐 attempt 用量交叉验证，没有读取服务器 HMAC salt，也不声称直接重算引用。观测一致性不消除上述断流调用的计费未知。

## 清理与交付

所有模型调用终态后已停止本轮临时服务 PID 71489，8002 不再监听。正式 8000/8888 服务仍为 PID 44349/49505，本机 Langfuse 3035 保留；未更改正式业务数据库或模型配置。

本地详细证据位于 `/tmp/ai-live-acceptance-20261113/`：`expansion-*-summary.json`、`expansion-*-first-terminal.json`、`expansion-*-ledger-before-save.json`、`expansion-*-gate.json`、`workflow-enhancement-nonstoryboard-*.json`、`workflow-enhancement-langfuse-verification.json` 和 `workflow-enhancement-storyboard-langfuse-verification.json`。原始候选、临时数据库及本机凭据不提交；本报告保留可复核的汇总结果与实际边界。

本轮提交推送 `codex/langfuse-observability`，不自动合并 main。后续质量增强的具体目标是提高审核修复范围的完整性及减少格式修正成本；仍需代表性样本验证，不能通过无限重试或自动扩宽未经证据授权的字段来取得通过结果。
