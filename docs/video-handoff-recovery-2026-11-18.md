# 视频承接冲突恢复与媒体输入定位（2026-11-18）

工作目录：`/Users/caoyanzu/workspace/ai-video-creation-tools`，分支 `main`。保留原有未提交改动与业务数据；未提交、推送或调用真实付费模型。

## 问题与修正

1. 旧视频承接候选已经明确报告“灯管一次 / 两次 / 两次音效”的来源矛盾，重复点击只会复用同一失败结论。现在精确匹配旧身份后直接返回保留候选、逐字证据、字段位置、来源和版本，标记为待创作者确认，不伪装成传输故障。
2. 画布提供证据、一次/两次的局部替换预览及手动编辑动作/事件音效。必须预览并明确采用后，才走正常镜头 PATCH；来源版本过期返回 409，动作与音效在同一事务保存。台词、共同声场和其他镜头字段保留。继续承接时使用新来源签名，兼容旧自动视频节点；手动视频草稿、已固定图片和历史输出保留。自由画布没有关联镜头时返回来源图片编辑入口。
3. 对完整、严格契约有效且业务有效的回答，显式允许投影顶层额外元数据，保留原始回答、变化与哈希审计。不接受缺失字段、嵌套未知字段或冲突的 video_prompt/motion_prompt。格式纠正只携带候选和契约；语义纠正使用相关来源。相邻镜头上下文去掉重复全文，保留场景和交接状态。在既有分镜语义审核中加入动作/事件音效一致性，不增加审核循环。
4. 在实际渲染完的 provider JSON 上记录输入路径、content 索引、素材 ID、内容摘要、请求字节数。上游拒绝响应按这个映射定位；相同图片内容对应多个素材时明确显示歧义，不推断单一责任素材。任务信息显示被拒图片、请求编号和当前来源节点，并可返回画布检查/替换。确定 HTTP 拒绝不自动重发。
5. 参考图原始字节编码使用有界缓存，并合并并发读取，文件变化则失效。没有压缩、缩放、转码、改顺序或修改原文件。最终请求只序列化一次，映射摘要和发送共用同一份字节文本。
6. 同一 job 的创建、查询、下载通过稳定、脱敏的 trace ID 关联，重启后（同一 Langfuse 凭证下）仍可关联；每次执行生命周期有独立根 span，其子请求保留正确 parent。记录缓存、本地复用、真实模型请求次数、待确认及上游拒绝状态，追踪中不记录原图片、提示词或凭证。

## 验证

- 后端专项：57/57，通过 `video-audio-plan`、`handoff-output-efficiency`、`media-input-recovery`、`langfuse-tracing`。
- 前端：58/58，通过 `video-handoff-recovery`、`canvas-shot-workflow`、`canvas-prompt-compiler`。JSDOM 验证逐字证据、计数预览、明确采用、保存失败保留草稿、冲突不出现重新分析入口，以及被拒图片不会按参考列表顺序误定位。
- 提供商：46/46，`providers.test.ts` 使用 127.0.0.1 临时模拟服务；没有真实模型请求。
- 其余相关回归：92 项，91 通过，1 项原有失败：`model-output-checkpoint.test.ts` 中 `syntax failure retains complete correction bytes, precise location and used allowance`。在临时文件中移除本次投影/最小纠正上下文增强后，同样报 `Missing expected rejection`。保留现有代码和该失败测试，没有为本次任务改掉其预期。
- 全项目构建、架构检查及 UI 控件检查通过；`git diff --check` 通过。
- 真实旧记录的隔离回放：只读备份现有 DB 到私有临时目录，定位原 namespace `video-handoff:2cb02025631c44ade3cf99fc1cf0fbe807c476e8ace23e01774100841d5283f9`，使用真实来源上下文、模型身份及保留候选。旧候选复用、重复调用零生成、三个精确证据位置、正常镜头保存以及新签名视频承接均通过。所有外部 fetch 被阻断，实际外部请求数为零。

验证日志位于 `/private/tmp/handoff-regressions-final.log`、`/private/tmp/handoff-web-final.log`、`/private/tmp/handoff-provider-tests.log`、`/private/tmp/handoff-related-tests.log`、`/private/tmp/handoff-build.log`；真实回放的脱敏结果位于 `/private/tmp/handoff-real-replay-20261118/result.json`。私有原始回放资料不纳入仓库。

## 限制

没有真实付费端到端重跑，也没有从真实上游新响应验证拒绝定位。历史媒体任务没有保存最终请求体映射时，无法追溯精确 content 索引；界面明确提示，不用持久化参考顺序猜测。此版本只为新的配置式视频创建请求记录最终映射。

真实项目的一次/两次矛盾仍保留待创作者选择；隔离副本的测试选择没有写回生产项目。未清空 Langfuse、未直接修改生产检查点或预算。
