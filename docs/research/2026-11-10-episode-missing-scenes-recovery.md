# 完整分集正文缺少分场时的自动恢复

## 事故证据

对应截图“生成结果中的分场内容与当前创作阶段不一致，未通过校验”。真实任务为 `27a4cd46-547d-4af1-8f7f-50c71b8e2258`，项目为 `5387d88a2e3d43aebb7be053f3a5af2d`，本地时间 2026-11-10 00:53:22 开始、00:54:32 失败。

只读检查证实，模型请求成功，没有输出截断；请求已发送 `max_output_tokens:65536`。上游记录为输入 270282 tokens、输出 5254 tokens，响应 5224 字符。实际请求 workflow 包含 `stage:episode`、`scope:episode`、`episode_number:1`、`intent:stage_design` 和 `artifact_types:[episode_script]`，不存在本次意图配置丢失。

响应含完整 `episode_script`，正文 2646 字符，但 `scenes:[]`。真实断点保留了该正文，状态为 `round:1`、`initialEnded:false`、`initialComplete:false`、`target:null`、`mode:document`。原错误为 Zod 的 `custom` issue，路径是 `scenes`，文案是“仅分集正文阶段需要分场剧本”。

后续任务 `0b21b9cf-c823-4b9e-9ad5-2ebe59381856` 已于 00:56–00:57 成功生成第1集。本次修复没有自动重做该集，也没有改写真实任务、原稿、正文或断点。

## 根因和修复

分集的实际生成 Schema 允许空或缺省分场，最终业务校验却要求分场非空。完整正文先被保存，后置校验随后抛错；初次校验失败只识别“缺文档”，把“仅缺分场”归为不可恢复错误，阻断了已有的分场接续流程。

现在分集 JSON 与函数调用共用的 Schema 均要求 `scenes` 必填、至少一场；通用历史恢复 Schema 继续兼容旧数据。收到完整正文但缺分场时，保留已收原文，自动进入 `scenes` 模式。每个接续单元只能包含空正文和一个合法场次，禁止借补场改写正文。其他文档错误、非法场次、来源 ID 或业务错误继续拒绝；最终仍执行完整 Schema、业务校验及独立草稿审读。

运行时和前端展示分别区分“本集正文缺分场”和“全剧资料多出分场”。前端只翻译精确的校验字段与文案，不修改历史记录或普通正文。

此前测试覆盖输出截断后的场次接续，以及空场次应拒绝的单独校验，漏掉了“请求成功、完整正文、空场次”的首次自动恢复组合。本次补上该路径、断点和业务入口回归。

## 验证

- 10 组相关后端单测 **227/227**，包括缺失/空分场、旧 `round:1` 断点、空接续不能完成、非法场次、接续夹带非空正文拒绝、中断后仅补剩余场次。日志：`/private/tmp/studio-episode-scenes-unit-regression.tap`。
- 新增 `script-episode-scene-continuation-integration.test.ts`，**12/12**。使用完整应用、隔离 SQLite 和模拟 Responses，通过真实 `director/chat` 与 `director/chat/stream` 入口覆盖工具/JSON 草稿、旧/显式合同、缺失/空分场；每次仅一次正文生成加一次分场接续，独立审读一次。补场失败后的重试仍只补分场。确认前正式文档、场次、原稿和修订记录均不变。
- 真实导出断点正文的离线状态机回放通过：从成功但无分场的响应开始会调用 `workflow_draft` 后调用 `script_stage_blocks`；从旧断点开始仅调用后者。两次正文 SHA256 均保持 `97beb09cae5e9bf392072c5f25bbef8804f22992746bfb9c2373c0fd0abece55`。回放使用模拟场次、内存检查点和独立测试身份，仅证明结构恢复及正文保留，不证明实际创作质量。
- 前端诊断和实际展示组件测试 **20/20**；须在 `web` 工作目录运行，以加载正确的 JSX 编译配置。
- 后端 TypeScript、架构检查、UI 组件检查和相关差异格式检查通过。本地后端 `/api/health` 返回正常。
- 全量前端 `tsc -b` 仍被本轮未修改的 `web/src/features/canvas/ProjectCanvas.tsx:4167/4176/4178` 三处类型错误阻断：可选 `canvasId` 被传给要求字符串的 `CanvasGenerationSubmissionScope`。不能将全量前端构建记为通过。

没有调用真实收费模型。独立复核未发现本轮阻断问题；至少一场只保证结构非空，正文和场次的语义覆盖继续由独立审读核对。
