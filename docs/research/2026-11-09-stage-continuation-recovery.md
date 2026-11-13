# 阶段生成的响应异常与单元冲突恢复

日期：2026-11-09。范围：两张报错截图对应的阶段生成流程；先前的审读分页恢复另见 [审读验收记录](2026-11-09-gemini-review-output-recovery.md)。

## 实际故障与原因

只读检查本地任务记录发现，失败发生在钩子预设生成阶段。第一次任务先多次返回 `max_output_tokens`，输出用量约 8,188 / 8,212 tokens，之后返回 `bad_response_body`。接续模块把“不可重试的提供商错误”同时解释成“清除检查点”，导致当前目标已保存的完整单元被清空。

后续任务保留了 30 个完整钩子单元，再次接续时模型使用同一单元 ID 改写正文，触发 `stage_continuation_conflict`。原检查点未记录可供下一轮处理的具体冲突，明确继续后仍容易立即撞回相同冲突。“0 份完整文档”描述当前钩子目标尚未合成完成，不表示此前其他生成步骤的成果全部不存在。

## 修复行为

- 一般提供商错误、断线、鉴权失败与取消保留已闭合且通过校验的内容，停止本轮；明确继续后复用文档与单元，生成真正的缺项。`bad_response_body` 不触发长度恢复或工具重放，其诊断保留错误码、请求 ID、HTTP 状态与可用用量，避免直接展示可能夹带正文的上游错误消息。
- 同 ID 改写保留原稿，拒稿不进入正文。冲突页内其他合法完整单元可以保存，该页的完成标志不生效。冲突诊断持久保存；新纠正请求携带完整原文、创作要求、已保留内容和拒稿预览，要求逐项核对待处理冲突。原目标确已写完时允许无新单元完成，不虚构额外内容。
- 拒稿的正文与场次指纹防止精确改 ID 重交，历史拒稿在核对后仍参与检查；不做语义相似判断。每次响应的相同冲突只计一次。重复冲突在相同合法内容下有限停止，真实新增成果允许继续，用户取消优先。
- 内容过滤只回退本次响应新增的内容与诊断，先前干净响应的成果保留；首响应被过滤且没有先前成果时不保留可采用断点。旧 v1 检查点和仅标题变化的重复单元保持兼容，最终覆盖、来源与场次顺序校验继续生效。

## 变更位置

- `backend/src/modules/script/script-stage-continuation.ts`
- `backend/src/infrastructure/providers/providers.ts`
- `backend/src/infrastructure/providers/text-errors.ts`
- `backend/test/script-stage-continuation-recovery.test.ts`
- `backend/test/script-stage-provider-recovery.test.ts`
- `backend/test/text-provider-body-error.test.ts`

## 验证

纯内存检查点与模拟 Responses SSE 覆盖真实 provider 到阶段接续的链路，确认 `bad_response_body` 后保存完整单元、仅补缺项、完整原文仍在下一请求中、不采用残缺字符串、不自动注入输出额度、不修改模型设置。独立复核发现并推动修复拒稿改 ID 重交、内容过滤误删历史成果、同响应冲突重复计数三个边界。

验收共覆盖 210 项不同测试，全部通过：

- 提供商错误、长度诊断、工具不重放、只读重试与工具恢复：72 项，通过记录 `/private/tmp/stage-continuation-recovery-providers.log`。
- 阶段接续、新增响应异常链路、标题兼容、人物接续、任务执行、持久步骤/继续、流式单元及既有审读恢复：138 项。12 文件套件首跑 137/138；唯一失败为旧标题用例仍要求首次冲突立即停止、丢弃本页后续合法单元且诊断不含拒稿。仅将该用例校正为本次契约，并定向重跑所在文件 6/6 通过；生产代码未再修改。记录 `/private/tmp/stage-continuation-recovery-final.log` 与 `/private/tmp/stage-continuation-recovery-title-final.log`。
- `npx tsc -p backend/tsconfig.json --noEmit`、`npm run check`（架构和 UI 组件规范）与 `git diff --check` 通过。

独立复核在修复后使用纯内存小脚本重验三项缺陷，确认单次冲突只计一次、换 ID 拒稿不会进入正文、过滤只回退当前响应；最终未发现阻塞项。上述数字不重复累计工作代理的先行回归或定向重跑。

## 外部边界

本次不调用真实模型、不写用户数据库、不修改模型设置、不部署。模拟通过不证明真实生成质量或转发渠道已支持 64K 输出。官方 `gemini-3.8-flash` 的最大输出为 65,536 tokens；当前请求模板没有显式 `max_output_tokens`，`output_reserve_tokens: 128000` 仅用于本地容量估算。约 8K 的实际截断仍需转发渠道的模型映射、参数透传与实际请求证据，不能仅由模型名推断；公开资料与证据限制见 [模型调研](2026-11-09-gemini-3-8-flash-model-research.md)。
