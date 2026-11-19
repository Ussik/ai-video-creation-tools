# 修订后大纲复核断连与阶段展示修复（main，2026-11-18）

直接修改 `/Users/caoyanzu/workspace/ai-video-creation-tools` 的 main，接续当前流程优化。保留此前全部工作和业务数据，未提交或推送。

## 事件与证据边界

补充诊断对应截图 dbd73a8f、Langfuse trace `e973afd813f266f0cd0b46b901516da2`、任务 `16eb4c0b-18c3-4e35-94ae-65bb720f2f4d`。提供的追踪诊断显示：15:45:28 的 recheck 请求约 0.252 秒断连，没有 HTTP 响应、上游请求 ID 或可见文本，delivery unknown、output_started false、complete false。这与上一轮“证据范围越界”的完整回答业务校验失败是两种问题。

本轮用 SQLite `mode=ro` 核对真实任务：4 镜、35 秒 outline、report、repair 都存在；修订后的 recheck 检查点保留 input_hash 和 initial_started，没有 raw。失败快照 stage/error.stage 仍是 generating，原始错误为“文本模型生成失败：模型接口连接中断，未获得完整响应。”。未扩写。

未在本轮重新查询远端 Langfuse；精确请求耗时、token 与请求体指标采用补充诊断。请求体大是效率问题，现有证据不能证明它是断连根因。

## 修改

- 大纲复核、修补、修补后复核持久标记为 reviewing、repairing、rechecking，新任务的 task.stage/error.stage 对应实际阶段。进入扩写时恢复外层 generating/repairing，避免旧复核阶段覆盖后续扩写错误。
- 历史任务从同一大纲命名空间里的 report、repair 与待确认 recheck 检查点投影出正确阶段，不重写原始错误和检查点。无法回溯拆分的历史耗时不凭空分配。
- 真实记录中，来源大纲经过合法的正文引用规范化后与质量检查使用的大纲签名不同。未知交付的阻断可识别同一大纲命名空间内成组的历史检查点，不能因原始签名不同再买一轮复核；这仅授权保守阻断，不授权跨版本采用内容。
- 页面显示“修订后大纲复核未完成”，明确大纲、已完成报告和修订结果保留，响应尚未确认，不会自动重发。待确认任务不显示继续重试许可；直接调用恢复也被阻断。
- 报告和修补均保留时，尚未发送的后续阶段只继续 recheck。只有提供方可信的 not_sent 事实解除发送保护；无文本、无 HTTP 响应或快速断连均不能被视作 not_sent。
- 复核及 recheck 共享单份证据目录与大纲字段索引。修补的首次请求也使用该索引；完整来源事实仍保留。修补格式纠正只带原回答、字段目标与契约，不再重发来源、长规则及整个大纲。recheck 格式纠正同样保留修订字段证据并省略长来源/规则。没有新增审核或纠正循环。
- 修补输出新增私有 structured_output 检查点，保留格式失败原文与一次格式纠正回答、冻结纠正身份和发送保护；成功清理仍保留这些审计记录。
- `planningTaskFailure` 只在诊断/定位与恢复提示的展示边界补必要标点，避免原诊断末尾已有“。”后再次加“。”。上游错误和模型正文没有全局替换。

## 验证

- 回归先失败，复现未标记 rechecking、真实历史检查点误进入新复核、修补格式纠正重发长上下文和“响应。。”。红日志 `/private/tmp/outline-recheck-red.log`。
- 后端相关 126 项测试通过，含真实私有任务检查点副本回放、历史快照只读投影、报告/修补保留、未知交付不重发、可信 not_sent 只继续 recheck、修补/recheck 格式输入精简、扩写阶段复位与既有证据/关联/预算测试。日志 `/private/tmp/outline-recheck-backend-final.log`。最后阶段边界检查日志 `/private/tmp/outline-recheck-stage-final.log`。
- 前端任务展示、规划与制作窗口 110 项通过。日志 `/private/tmp/outline-recheck-web-final.log`。首次从根目录运行 TSX 组件测试未加载 web 的 JSX 配置；已从 web 工作目录按项目配置重跑通过，未修改组件来绕过测试运行配置。
- 完整 `npm run build` 通过，包含架构/UI 检查和 shared/backend/web 构建；日志 `/private/tmp/outline-recheck-build-final.log`。最后一处后端阶段边界调整另跑后端构建验证。`git diff --check` 通过。

私有真实夹具只存在 `/private/tmp/outline-recheck-task-fixture.json`，没有加入仓库。测试通过 `STORYBOARD_RECHECK_FIXTURE` 指定；未提供时合成回归仍运行，私有回放显式跳过。

所有模型结果由 mock 返回，业务测试使用临时数据库。真实数据库只读查询；没有更新真实任务、调用真实付费模型、清理追踪、重启服务、提交或推送。实际重新生成的成功率与真实网络连通性尚未验证。此前记录的全套测试既有失败未在本轮改动或宣称全部修复。
