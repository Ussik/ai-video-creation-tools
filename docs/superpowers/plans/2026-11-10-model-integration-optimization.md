# 模型接入与任务恢复优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已审计的 24 类模型入口、41 项机制落实为一致的请求策略、可恢复成果和可解释的执行过程。

**Architecture:** 扩展现有请求计划、协议适配、执行作用域、用量账本及步骤检查点。协议层准确报告事实，任务层管理归属与进度，业务层定义完整单元和最终校验。长成果、短原子请求、付费媒体任务分别采用合适的恢复方式。

**Tech Stack:** TypeScript、Node.js >=22、Fastify、Zod、SQLite、React、Mantine，使用现有 node:test/tsx 测试工具。

**Spec:** [完整源码审计](../../research/2026-11-10-model-integration-agent-source-audit.md)，其中 S01—S26 为固定外部源码及官方依据。

本轮状态：仅完成实施设计；以下任务和测试均未实施，不能当成验收通过。实施分为请求适配、任务运行、业务接入、展示验证四个工作包，以下任务是各工作包内可独立审查的变更。执行方式遵循用户后续指令。

## Global Constraints

- 保留业务输入和完整交付范围；固定额度不静默降低，未知渠道能力不假装已验证。
- 长剧本不新增默认累计 token、轮数或总运行时长硬截止；单次请求额度、传输保护和无进展终止分别管理。
- 只采用验证通过的完整单元；源/合同变化时不拼接旧版本；最终完成仍执行整体业务校验。
- 不自动换模型/渠道；不执行半截参数；已授权的创作决定在内部恢复中保持。
- 正式提交、模型派发和外部付费副作用分别控制；未知提交不直接重发，已有供应商 ID 优先查询。
- 当前工作树存在大量其他修改；实施时按任务审查差异并保留已有工作，提交/推送遵循用户指令。
- 不引入新的 Agent SDK、消息中间件或向量数据库作为本次改造前置条件；UI 使用现有 Mantine 组件。
- 目录缓存、前缀缓存、opaque 回放、并行及模型迁移按渠道能力与实测结果启用，保留人工配置及明确操作语义。

## Review Focus

- 第 N 场已保存后进程重启，必须仅恢复未完成单元；由任务 5/6/8 的故障测试证明。
- 工具已执行或付费 POST 可能已接收后失联，恢复不得重放副作用；由任务 3/4/10 证明。
- 取消、源修改、模型切换与晚到响应竞态，不得覆盖新状态或人工编辑；由任务 4/8/9/10 证明。
- 新旧分镜 API 与三种文本协议不能漏接通用策略，audio_plan 不能在应用链丢失；由任务 1/8/10 证明。
- 局部读取/摘要/缓存命中不能冒充原文检查覆盖或新模型执行；由任务 7/9/10 证明。

## 文件职责与依赖

| 工作包 | 现有主要位置 | 新增的有限职责 |
| --- | --- | --- |
| 请求适配 | backend/src/infrastructure/providers/text-context.ts、text-request-plan.ts、text-errors.ts、providers.ts、text-anthropic.ts；packages/shared/src/models/text-capabilities.ts、text-api-settings.ts | backend/src/modules/generation/model-task-policy.ts 定义显式用途及请求上下文；协议差异仍由现有适配器承担 |
| 任务运行 | model-execution.ts、text-request-usage.ts、script-generation-steps.ts、script-generation-checkpoints.ts、director-tasks.ts、job-queue.ts | 通用步骤实现在 generation/ 下复用；script/ 保留兼容导出；新增轻量对象准入及完整单元执行适配，避免第二套生成引擎 |
| 业务接入 | modules/script、storyboard、visuals、canvas、assets、skills、jobs、speech 及 app.ts 注册路由 | 每个业务提供单元 ID、依赖、来源身份、校验、合并和提交方法；不把这些规则搬进协议适配器 |
| 展示验证 | packages/shared/src/api/contracts.ts、web/src/features 下现有业务组件、backend/test、web/test | 共用进度契约及 Mantine 展示组件；协议事件夹具与故障场景跨入口复用 |

依赖：任务 1 为共同基础；2、3、4 可在各自改动范围内推进；5 依赖 1/3/4；6、8、9 依赖 5；7 依赖稳定的单元和来源身份；10 随入口接入补测试，最后完成整体验收。共用文件的修改由一个实现者整合，避免多个工作包同时改 providers.ts/app.ts。

## Task 1: 显式请求策略、单一计划与记账

**Coverage:** A01、A05、A08、G01、G02。

**Files:** Create backend/src/modules/generation/model-task-policy.ts；Modify backend/src/modules/generation/model-output.ts、backend/src/modules/generation/model-execution.ts、backend/src/infrastructure/providers/text-context.ts、text-request-plan.ts、text-request-usage.ts、providers.ts、text-anthropic.ts、app.ts；Test backend/test/model-task-policy.test.ts、text-request-plan.test.ts、text-request-usage.test.ts。

**Interfaces:** 新增 ModelRequestContext，包含 policy、task_id、step_id、attempt_id；policy 显式提供 purpose、outputTokens、minimumOutputTokens、readOnly、恢复种类。StructuredGenerator 增加可选第三参数 context，generateStructuredOutput options 和 TextStreamRequest 透传同一上下文；TextRequestPlanOptions 继续使用现有同名额度字段。保留 OutputContract.request_policy 的特定审读语义，不将运行参数放进输出 Schema。

- [ ] Step 1 — 增加故障测试：相同 policy 对两个不同 contract 名称产生相同实际额度与重试行为；controlled_storyboard、visual_profiles、shot_plan、complete_script 显式使用长成果策略。
- [ ] Step 2 — 运行新增测试确认旧实现会暴露名称依赖：node --import tsx --test backend/test/model-task-policy.test.ts。
- [ ] Step 3 — 实现显式策略透传；初始策略复用当前长生成 65536、审读 32768、通用 8192 的目标值，按真实能力和最低完整单元需求 fit。它们是 auto 目标，固定值优先；保留上游默认模式。已知 shared 的 auto 模式增加可解释的计数/framing 余量，精确计数与本地估算分开。
- [ ] Step 4 — 每次真实派发前记录 request/attempt 与最终计划，所有入口挂现有 withTextRequestUsage。断流未知用量不记零，transport 查询与 generation 派发分开；运行上述相关测试，固定 65536 的请求 body 必须仍为 65536。
- [ ] Step 5 — 审查所有 StructuredGenerator 闭包是否透传 context；单独检查 processJob → generate → configuredNetwork 的文本非流式及原生 Messages 分支；以 24 类入口矩阵证明接入，不以新增 registry 文件代替入口覆盖。

## Task 2: 能力、推理模式及结构化兼容

**Coverage:** A02、A03、A06、A07、C07。

**Files:** Modify packages/shared/src/models/text-capabilities.ts、text-api-settings.ts；backend/src/infrastructure/providers/model-catalog-capabilities.ts、text-output-capability.ts、text-anthropic.ts、providers.ts；web/src/features/models/TextModelApiSettings.tsx、HarnessTextModelOptions.tsx；Test backend/test/model-functional-capabilities.test.ts、text-api-settings.test.ts、text-anthropic.test.ts。

**Interfaces:** 在现有 TextCapabilities/ResolvedTextCapabilities/TextCapabilityScope 上扩展可选功能声明及来源；TextReasoningSettings 区分固定预算、adaptive 与 effort。resolveTextApiSettings 仍唯一负责标准表单到实际协议字段的转换；generateCompatibleStructuredText 沿用现有安全协商入口。

- [ ] Step 1 — 增加测试：fixed thinking 请求不含 adaptive；改变渠道/协议/remote_id/有效设置后观察能力失效；明确不支持格式可降级一次，而 401/429/invalid schema/网络错误不可降级。
- [ ] Step 2 — 运行 node --import tsx --test backend/test/model-functional-capabilities.test.ts backend/test/text-api-settings.test.ts backend/test/text-anthropic.test.ts，记录旧行为失败点。
- [ ] Step 3 — 扩展容量之外的 tools、structured output、推理模式等能力；来源分为目录、人工覆盖和运行观察，未知态保留；将结构化协商覆盖到适用的分镜/visual/refine 等入口，支持 Messages 的原生格式能力。
- [ ] Step 4 — 目录读取加入版本、刷新合并、过期提示及可用时的 ETag；刷新只更新编辑草稿。opaque reasoning 仅在渠道明确支持时请求、保真回放，不强发 include/store，不展示私有推理。
- [ ] Step 5 — 运行相关后端及模型表单测试；检查保存、取消编辑和手工覆盖行为。可选能力无法证实时维持未知并记录禁用原因。

## Task 3: 结束原因、断流与恢复分流

**Coverage:** A04、B01、B02、B03、B04、B05、B06。

**Files:** Modify backend/src/infrastructure/providers/text-errors.ts、providers.ts、text-anthropic.ts、gemini-image-analysis.ts；backend/src/modules/generation/read-only-retry.ts；packages/shared/src/script/script-stream-policy.ts；Test backend/test/text-attempt-recovery.test.ts、text-provider-body-error.test.ts、text-output-limit-diagnostics.test.ts、image-analysis-settings.test.ts。

**Interfaces:** TextProviderError 增加可选的 failure_kind、raw_reason、delivery、output_started；继续保留 TextOutputLimitError.partialText 和独立 TextToolOutputLimitError。delivery 表示 not_sent、rejected、accepted、unknown，不把 HTTP 500 自动视为未执行。新增请求阶段诊断，沿用 createStreamScope 和 TextRequestMetrics。

- [ ] Step 1 — 通过协议夹具复现：无输出断流、有完整单元后断流、输出耗尽、context overflow、refusal、pause_turn、未知结束、巨型未闭合 SSE 事件；断言恢复分流和执行次数。
- [ ] Step 2 — 运行 node --import tsx --test backend/test/text-attempt-recovery.test.ts backend/test/text-output-limit-diagnostics.test.ts，确认此前混合状态的测试失败。
- [ ] Step 3 — 三协议及原生 Gemini 统一归一化停止事实并保留 raw reason；真实输入超限只交给有减量能力的业务恢复，输入/状态未变化则不重发；有完整成果的断流保留成果后接续，短原子请求按策略重试。
- [ ] Step 4 — 保留抖动、Retry-After 和取消；过长等待转成可见等待/可继续状态，不提前违背厂商建议重试。区分响应头、首事件、静默与步骤超时；错误页和异常单帧有限读取，合法长文通过完整单元持久保存，不设统一 8K 总长限制。
- [ ] Step 5 — 运行全部相关适配器测试；残参执行次数为 0、未知付费 POST 重发次数为 0；原生图片反推有实际端点/模型/用量来源，不套用生图容量。

## Task 4: 取消、执行归属、并发及付费媒体生命周期

**Coverage:** E03、F01、F02、F04。

**Files:** Modify app.ts、backend/src/infrastructure/providers/providers.ts、text-tools.ts、text-background.ts、speech-provider.ts；backend/src/modules/jobs/job-queue.ts、job-generation-recovery.ts；各业务 route 及前端 AbortController 调用点；Create backend/src/modules/generation/model-admission.ts；Test backend/test/model-cancellation.test.ts、model-admission.test.ts、job-generation-recovery.test.ts。

**Interfaces:** structuredTextOutput/requestJson 补可选 signal，统一经 modelStepSignal 合并；TextTool 增加只供本地执行层使用的 access/resource/parallelSafe 元数据；withModelAdmission(key, signal, work) 负责同资源准入，现有 jobs 继续持有媒体任务与并发配置。

- [ ] Step 1 — 测试排队、退避、计数、response reader、技能准备阶段取消；请求型功能必须停止后端派发，后台任务订阅断开必须只退订；相同资源写不能并发提交。
- [ ] Step 2 — 运行 node --import tsx --test backend/test/model-cancellation.test.ts backend/test/model-admission.test.ts，记录各遗漏调用点。
- [ ] Step 3 — 补齐片段分镜、visual、画布准备、拒绝后优化、handoff、旧分镜与集中分类/分析路由的取消；取消后不派新单元，必要的状态和用量结算完成后释放归属。
- [ ] Step 4 — 工具执行准入与模型 parallelCalls 分开；独立读取有界并行，同对象写仍走写屏障；429 后避免同步重试。视觉设定板生成与独立参考图生成的两条注入路径分别冻结来源并验收；通用 jobs 文本生成单独定义停止/重试/记账，不套用仅为媒体保存的 attempt 防重。媒体/TTS 保留提交、accepted ID、查询、下载、存储状态和未知结果；结果查询不能被新生成阻塞。
- [ ] Step 5 — 验证创建后断网、accepted ID 保存后重启、下载失败、本地停止及重复继续；检查后台文本既有防重和媒体防重均保留，HTTP abort 不显示为厂商已取消计费。

## Task 5: 复用完整成果检查点与迁移契约

**Coverage:** D08、E04、F03。

**Files:** Modify backend/src/modules/script/script-generation-steps.ts、script-generation-checkpoints.ts、director-tasks.ts；Create backend/src/modules/generation/generation-steps.ts、generation-unit-execution.ts、generation-unit-store.ts；Modify backend/src/infrastructure/database/db.ts 仅追加隔离命名空间/必要存储迁移；Test backend/test/generation-unit-resume.test.ts、script-generation-resume.test.ts、script-task-migration.test.ts。

**Interfaces:** createGenerationSteps 的 run/retain/forget 行为保持，现有 script 文件兼容导出。新增 executeGenerationUnits<T>，由业务传入 task identity、unit IDs/dependencies、生成、单元校验、最终校验及持久 save；GenerationUnitState 使用版本、源/合同身份、执行配置身份、完整单元值和状态。新业务使用独立任务命名空间，不共用一个项目唯一活动草稿槽。

- [ ] Step 1 — 测试 A/B 完成、C 失败后重启，A/B 派发次数仍为 1；重复正文换 ID、A→B→A 和仅时间戳变化不算进展；损坏断点无法冒充成功。
- [ ] Step 2 — 运行 node --import tsx --test backend/test/generation-unit-resume.test.ts backend/test/script-generation-resume.test.ts；使用临时 SQLite，禁止访问真实业务库。
- [ ] Step 3 — 仅提取现有通用步骤机制，不重写剧本合同。每个完整单元先验证再持久保存，单元保存不表示整个业务完成；失败保留原稿、候选和进度。每个任务只由一个执行者持有运行归属。
- [ ] Step 4 — 进展判据由业务定义；一次缩小批次/切换工作策略可作为恢复进展，同状态同策略无成果则停止。用户主动切模型时仅迁移同源同合同的完整成果，新模型重新预检；response ID、签名块、半截调用不迁移。
- [ ] Step 5 — 验证切换失败保留原任务、源/合同变化拒绝复用、提交成功但回复丢失可识别已有结果；模型迁移只能由用户明确操作触发。

## Task 6: 剧本、审读修复及原稿分析接入

**Coverage:** D01、D04、D05、E01。

**Files:** Modify backend/src/modules/script/script-stage-continuation.ts、script-stage-artifact-repair.ts、script-stage-scene-repair.ts、script-stage-block-repair.ts、script-review-pagination.ts、script-draft-repair-tools.ts、script-draft-repair-generation.ts、script-source-quality.ts、script-source-story-parts.ts、script-document-tools.ts；app.ts 中保留的单次 script API；Test backend/test/script-proactive-units.test.ts、script-repair-pagination.test.ts、script-source-output-resume.test.ts、script-tool-output-recovery.test.ts。

**Interfaces:** 继续使用 generateStageDraftWithContinuation、generatePagedReviewItems、createGenerationSteps 和现有语义块/问题/补丁 Schema；首次分批策略读取任务 1 的有效请求计划，单元执行使用任务 5 的存储和进展判断。

- [ ] Step 1 — 测试长分集正文首轮可保存完整场，短任务仍单次返回；decisions/edits 各自再次超限仍能只补剩余项；原稿质量/时间线后页失败不丢前页。
- [ ] Step 2 — 运行上述 4 个测试文件，确认首次整份返回和未分页子步骤的失败路径。
- [ ] Step 3 — 按成果范围和有效额度主动选择一次完成或人物/集/场语义块；原生候选修补主路径（get_repair_context/search_repair_context/submit_repair_patch）与兼容生成路径都把决定按 issue_id、编辑按完整操作保存；原生输出截断不等于已经进入兼容 decisions/edits 恢复，需单独实现小批完整提交契约；质量问题、时间线/伏笔分别分页，原文检查覆盖单独记账。
- [ ] Step 4 — 产物/场次元数据修复复用 block repair 的字段差异方式，后端从已接收正文组装，避免为修字段再次生成长正文；保留单次修正限制和最终校验。仅对支持小批契约的截断工具反馈“未执行，请返回较小的完整调用”；不续接参数。保留范围、引文、非重叠、分场同步及最终独立复核；单次保留 API 接同一执行基础而不另造恢复逻辑。
- [ ] Step 5 — 验证未完成全部补丁不写正式稿，已验证决定不重选、来源变化不混页；原生修补及兼容修补分别验证截断恢复；工具副作用计数和全章节覆盖均满足原有合同。

## Task 7: 原文工作集、工具结果和缓存

**Coverage:** C01、C02、C03、C04、C05、C06、E02。

**Files:** Modify backend/src/modules/script/script-chat-source-context.ts、script-resource-tools.ts、script-document-tools.ts、script-stage-continuation.ts；backend/src/infrastructure/providers/text-tool-history.ts、text-tools.ts、text-request-plan.ts；backend/src/modules/skills/model-skill-selection.ts；Create backend/src/modules/generation/model-source-workset.ts；Test backend/test/model-source-workset.test.ts、text-native-history-compaction.test.ts、model-cache-identity.test.ts。

**Interfaces:** SourceWorkset 提供 immutable source/version、global constraints、selected ranges、read receipts、completed unit manifest 和按需读取句柄；reuseKey 必须由调用方基于完整输入身份传入。大结果通过现有资源/分页读取取回，不能只发 hash 期待模型知道原文。

- [ ] Step 1 — 测试小窗口读取长原稿、未读段补读、最新巨大工具结果外置、源变化失效；验证缓存不能替代全文覆盖证据，重复读取不算进展。
- [ ] Step 2 — 运行上述测试，保留现有只读聊天范围限制的回归测试。
- [ ] Step 3 — 为创作新增明确工作集适配，复用目录/范围读取/覆盖回执；接续只带全局规则、完成单元清单、相邻正文和必要证据；所有原文无损可取回，最终跨章核对保留。
- [ ] Step 4 — Messages 按完整旧交换管理历史，签名/opaque 和工具配对不改；精确编辑依据保留，无法证明安全则继续跳过压缩。稳定前缀/渠道缓存按能力启用；计数、分析结果和厂商缓存各有独立身份与状态。
- [ ] Step 5 — 验证输入确实减量后才允许 overflow 恢复；技能 reuseKey 实际接通；缓存收益以实际 cache token、耗时和费用衡量，来源/权限/Schema 变化必须失效。

## Task 8: 分镜、视觉、画布与长提示词接入

**Coverage:** D02、D03、D06、D07。

**Files:** Modify backend/src/modules/storyboard/storyboard-planning.ts、clip-storyboard.ts；backend/src/modules/visuals/visual-profiles.ts；backend/src/modules/canvas/script-canvas-preparation.ts；backend/src/modules/skills/skill-routes.ts、backend/src/modules/skills/prompt-refinement-semantics.ts；app.ts 的 shot_plan；web/src/features/script/ScriptEditor.tsx；Test backend/test/storyboard-unit-resume.test.ts、visual-unit-resume.test.ts、script-canvas-preparation.test.ts、prompt-refinement-resume.test.ts；web/test/storyboard-audio-plan-flow.test.tsx。

**Interfaces:** 新旧场次分镜共用按场计划/校验策略，保持各自 API 和确认创建语义；visual 单元图为共享对象→基础变体→镜头用途；画布准备使用 design_id 分组。提示词候选生成和独立语义复核各为一步；短提示词仍原子生成，大正文可使用唯一锚点 patch。

- [ ] Step 1 — 增加第 N 场失败只恢复剩余场、视觉基础变体失败不重建共享人物、某设计组失败保留其余组、候选已完成只恢复复核的测试。
- [ ] Step 2 — 增加 audio_plan 从模型→预览→编辑→创建 payload→持久读取的非空对白/环境声测试，确认当前映射丢失会失败。
- [ ] Step 3 — 补齐音频字段与来源失效规则；冻结来源身份后按完整场或镜头生成并保存，跨场衔接最后检查；片段较小时仍一次完成，超长时才按镜头拆分。
- [ ] Step 4 — visual 按依赖执行，画布按独立设计组保存及有界并发；精炼保留同一候选继续审查，patch 必须唯一匹配且不改固定区块。所有业务保留已有预览、显式应用、事务与幂等创建。
- [ ] Step 5 — 运行该任务全部相关测试；校验场次覆盖/总时长/对白、视觉身份/依赖/设计隔离、引用预算、源版本和晚到响应不覆盖人工编辑。

## Task 9: 图视频分析、短任务与缓存语义

**Coverage:** A04、C06、D04、F01、G02 的业务落点。

**Files:** Modify backend/src/modules/canvas/image-prompt-analysis.ts、video-prompt-analysis.ts、video-audio-plan.ts、backend/src/modules/canvas/canvas-node-proposals.ts；backend/src/modules/assets/video-review.ts；backend/src/modules/jobs/prompt-optimization.ts；app.ts 中 continuity_report/theme_visuals/reply_classification/asset_prompt；相应 web 组件；Test backend/test/media-analysis-resume.test.ts、short-model-task-policy.test.ts、video-audio-plan.test.ts。

**Interfaces:** 长视频按时间段/真实镜头单元、审片按证据范围、文字连续性按相邻镜头对接任务 5；短分类、单图理解、节点建议、技能和 handoff 沿用原子结果策略。分析缓存身份包含来源、范围/采样、模型配置、技能/合同版本；已确认业务计划与分析缓存分别复用。

- [ ] Step 1 — 测试跨段同一镜头不重复/不虚构切镜，源视频/范围/fps 变化不混批；问题达到返回上限时不能伪称全部检查完。
- [ ] Step 2 — 测试 handoff 显式新模型重新分析不返回旧分析缓存；已确认业务计划仍按业务版本复用；回复分类逐条成功可保存，ID/阶段与旧结果防覆盖校验保留。
- [ ] Step 3 — 将长视频/审片/文字连续性接入完整单元执行，汇总时检查覆盖、去重、跨段衔接和证据；单图结果过长时可以按契约细分，但不默认给所有单图增加循环。
- [ ] Step 4 — 给短入口接通显式策略、signal、用量与身份缓存；自动技能选择、可选参考选择和分镜/video_prompt 两套技能准备分别验证透传；题材确定性快路不发模型请求，短任务不机械后台化。声音未分析、抽帧证据范围和未知事实继续明确。
- [ ] Step 5 — 运行该任务测试，确认任何文本分析重试/继续/缓存失效均不创建新的付费图片、视频或 TTS 作业。

## Task 10: 进度界面、故障矩阵与全入口验收

**Coverage:** G03、G04，并验收全部 A—G 项。

**Files:** Modify packages/shared/src/api/contracts.ts；web/src/features/script、storyboard、visuals、canvas、jobs 下对应入口；Create web/src/features/jobs/ModelTaskProgress.tsx；backend/test/fixtures/model-events 下新增协议事件夹具；Test backend/test/model-entrypoint-recovery.test.ts、web/test/model-task-progress.test.tsx。

**Interfaces:** ModelTaskProgress 使用 task_id、state、completed/total、current_label、can_resume、can_cancel、source_stale；技术详情另展示 request/attempt、实际额度、能力与计数来源、停止原因及实际/估算/未知用量。公开状态只描述可证实业务进度，UI 不展示内部工具 JSON 作为操作流程。

- [ ] Step 1 — 以 24 类入口及审计文档的 12 处网络出口清单逐项登记策略、取消归属、恢复方式、持久结果、用量、最终校验；短任务标原子结果，媒体标独立付费状态，不要求所有入口长得一样。
- [ ] Step 2 — 测试运行/恢复/停止/失败/待确认/来源过期；刷新重新订阅原任务，继续仅处理未完成内容；重生必须有独立明确语义。保留现有审片历史、stale 和 handoff 常驻状态。
- [ ] Step 3 — 视觉设定板及独立参考图的多候选、版本变化和重启恢复均列入矩阵；三协议 × 流式/非流式及原生分析夹具覆盖截断、断流、尾帧、取消、残参、429/鉴权、提交后失联和重启；断言业务成果完整及外部副作用次数，而非只测 helper。
- [ ] Step 4 — 各任务目标测试通过后运行 npm run check、npm run test:backend、npm run test:web、npm run build；发现失败先区分本任务回归与已存在工作区问题，报告真实覆盖。未获授权不发收费生成；离线通过与真实渠道验证分别记录。
- [ ] Step 5 — 人工验收长剧本、新旧分镜、视觉、长视频、短分析和媒体恢复的必要业务路径；使用渲染页面检查状态与取消，关闭临时验证服务；将 41 项逐一更新为实现/验证/能力限制/实测无收益并附证据。

## 41 项完整覆盖索引

| 审计组 | 对应任务 |
| --- | --- |
| A01 / A02 / A03 / A04 / A05 / A06 / A07 / A08 | 1 / 2 / 2 / 3+9 / 1 / 2 / 2 / 1 |
| B01 / B02 / B03 / B04 / B05 / B06 | 3 / 3+7 / 3+4 / 3+4 / 3 / 3+5 |
| C01 / C02 / C03 / C04 / C05 / C06 / C07 | 7 / 7 / 7 / 7 / 7 / 7+9 / 2 |
| D01 / D02 / D03 / D04 / D05 / D06 / D07 / D08 | 6 / 8 / 8 / 6+9 / 6 / 8 / 8 / 5 |
| E01 / E02 / E03 / E04 | 6 / 7 / 4 / 5+6 |
| F01 / F02 / F03 / F04 | 4+9 / 4 / 5 / 4 |
| G01 / G02 / G03 / G04 | 1+3 / 1+9 / 10 / 10 |

## 自检记录

- 每项 A—G 均有实施及验收归属；可选增强也保留能力/收益评估结果，不能悄悄移出范围。
- 使用现有 TextRequestPlanOptions、TextProviderError、GenerationSteps、withTextRequestUsage、后台 ID 和 jobs；新增类型与文件仅承担明确缺口。
- 来源/合同和执行配置身份分开，最终完整性校验始终留在业务层；模型/渠道迁移不带旧签名或远端响应 ID。
- 文档中的新接口及测试为计划，不代表已经存在；实现时先验证接口贯通，再扩大入口覆盖，不在同一份巨大改动里混入无关重构。
- 当前仅做文档静态核查；工程测试、实际界面和真实渠道验证均须在对应实施任务中完成并记录。
