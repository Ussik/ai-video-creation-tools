# 模型接入与成熟智能体源码完整对照

核查日期：2026-11-10。范围是当前工作区全部模型接入链路及其业务使用方式。本文整理可借鉴机制及适用边界，不是只选择若干高优先级任务，也不是实施完成报告。本轮只修改调研文档，没有修改运行时代码、访问业务数据库或调用收费模型。

“已具备”表示当前源码中存在相应机制；“覆盖不完整”表示某些路径已有、其他路径未接入；“可扩展”表示现有机制可进一步完善；“可选”表示收益需要测量或属于产品选择。不能把这些状态全部算成已经复现的缺陷。按 24 个入口族整理为 41 个对照项，最后给出验收与不宜照搬的边界。

## 核查范围与实际调用链

| 入口族 | 当前模型链路与处理方式 | 对照项 |
| --- | --- | --- |
| 普通结构化文本、短分类（含主题/回复）、授权和意图 | `generateStructuredOutput`／直接 `streamText`；最多一次格式修正；只有指定契约自动包只读网络重试 | A01、B01、B03、G01 |
| 剧本阶段生成、人物资料、分集大纲和分集正文 | 按成果子任务执行；单份成果首次整份返回；已有完整单元接续、断点、无进展保护及最终独立复核 | C01、C02、D01、D08、E04 |
| 原稿导入、地图、质量核对和人物证据提取 | 已有版本绑定、段落证据、分任务和缓存；全局质量与局部资料区分 | C01、C06、D04、D08 |
| 剧本审读、引文定位、问题归组 | 已有完整问题分页、缩小页面、持久进度和报告提交校验 | C02、D04、G03 |
| 候选稿修复、决定和精确补丁 | 新任务默认走原生修补工具循环；旧断点/明确工具能力不支持时走兼容生成及 decisions／edits 恢复；原生最终提交与各兼容阶段仍可能整批返回 | D05、D08 |
| 导演 Agent 原生工具循环 | 有工具 profile、读取覆盖、版本检查、写屏障、只读传输重试、历史压缩与业务停滞检测 | C03、C04、E01—E04 |
| 场次分镜规划及导演复核 | 多场一次完整 JSON，整体复核并最多一次整包修订；有取消和源变更检查 | A01、D02、D08、F01 |
| 独立片段分镜 | 最多 30 镜的一次完整 JSON；有最终总时长等校验；取消链未完整接通 | D02、D08、F01 |
| 视觉档案整理和镜头用途 | 可选最多 100 场；整批档案和各镜头用途一次返回；输入含完整资料 | A01、C01、D03、D08、F01 |
| 提示词精炼、图片拒绝后的提示词优化、素材提示词 | 完整正文或小对象一次返回；部分有语义修正、资料引用及版本核对 | A01、D06、F01 |
| 技能及参考资料选择 | 有目录白名单、按需读取、字符预算、轮次和无进展保护；输入身份缓存仅在传入 reuseKey 时启用 | C01、E02、E04 |
| 画布单节点建议 | 小范围完整 JSON；有取消、来源指纹和参数校验 | A01、D06、G01 |
| 剧本到画布准备 | 已按设计域分组、只分析待处理资料并用来源签名复用；组间通过 `Promise.all` 等待 | D07、F02 |
| 图片理解／反推 | 文本多模态走统一 `streamText`；原生 Gemini 图片反推走独立适配 | A04、C06、G01、G02 |
| 视频反推／理解 | 有本地视频时长、体积、格式和采样约束；一次返回完整分析 | C06、D04、D08 |
| 成片／素材视频复核 | 有时间范围、源版本和结果校验；完整成功后才存结果 | D04、D08、G03 |
| 音画衔接计划 | 有后端取消、相邻镜头版本核对；部分前端请求未传 signal | F01、G01 |
| 通用 jobs 队列的文本生成 | processJob → generate → configuredNetwork 的 text 分支；Messages/Responses/Chat/自定义模板均支持非流式返回并保存 .txt；独立于 streamText 主流程 | A01、A05、A07、B01、B03、B06、F01、G01、G02、G04 |
| 图片和视频生成 | `jobs → generate → configuredNetwork`；已有厂商任务 ID、结果链接、查询/下载恢复及未知提交防重 | B03、F04、G01 |
| 语音合成 | 按台词持久任务和 take；单次付费调用、有完成帧和大小校验；不自动重试 | B03、F04、G01、G02 |
| 保留的单次剧本/产物生成 API | `script/artifacts/generate` 直接返回全文、`script/generate` 一次返回 complete_script；未经过导演持久任务，不能视为已有相同接续能力 | A01、B06、D01、D08、F01 |
| 现有编辑器的单次场次分镜 API | `script/plan-shots` 一次返回 shot_plan；已有场次、时长及台词来源校验，未经过新版规划的全部生命周期 | A01、D02、D08、F01 |
| 镜头语义连续性检查 | `continuity/analyze` 对镜头对一次生成报告；有 200KB 输入限制、来源签名核对和结果保存 | C01、D04、F01、G01 |
| 模型目录、标准表单、自定义接口 | 已有三种文本协议、标准表单、能力来源/覆盖/作用域、实际请求预算 | A01—A05、C06 |

通用文本入口主要为 [creativeText](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2532) → [generateTextOutput](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2082) → [streamText](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:692)。工具入口为 [textToolSession](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-tools.ts:38) → `createTextToolTransport`。独立路径包括 [Gemini 图片反推](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/gemini-image-analysis.ts:62)、[图片/视频生成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:1330)、[语音合成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/speech-provider.ts:75)。共用 HTTP 不代表它们已经共用全部停止状态、恢复和记账机制。

另核对了集中注册在 `app.ts` 的入口，避免只查模块文件而遗漏：

| 入口或契约 | 当前证据及覆盖说明 |
| --- | --- |
| `resource_authorization`、`generation_authorization`、`draft_approval`、`script_intent` | [授权及意图](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:1254)；属于短决策，保留完整小结果、原有权限和语义校验。 |
| `theme_visuals`、`reply_classification` | [主题映射](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3527)、[回复分类](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3544)；两者有当前 Web 调用；主题已有确定性快路、前端防抖及身份缓存，回复已有按分类版本/原文/后续上下文/阶段的服务端缓存和事务保存。回复缓存虽存 model_id，查询身份不含模型，需区分复用语义分类与用新模型重新识别；不应为短分类引入长文接续。 |
| `asset_prompt` | [素材提示词](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3326)；共用 creativeText，但该路由未传取消信号。 |
| `continuity_report` | [连续性分析](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2910)；有当前 Web 调用；快照和提交前签名核对已具备，输出最多 200 条；大范围可按镜头对处理并最终校验，不能仅提高输入硬限。这是文字状态检查，不能声称已复核实际画面。 |
| `shot_plan` | [单次分镜 API](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3670)；当前 [ScriptEditor](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/features/script/ScriptEditor.tsx:636)仍调用；与 controlled_storyboard 分别审计，不能将新版的取消/独立导演复核直接算给此路由。已有前端源签名和创建阶段校验，后端生成后未重查源签名；预览/创建映射未保留生成返回的 audio_plan，须修正字段传递后才可称音频约束贯通。 |
| 全文产物与 `complete_script` | [单次产物 API](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3890)、[单次剧本 API](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3908)；仍注册的独立模型调用路径，未在当前 web 源码找到对应生成调用，按保留 API 标记，不以“无 UI 调用”推定可删除。 |

这些集中路由共用的 [structuredTextOutput](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2101) 不接受 signal；纯正文产物路由也未绑定断开取消。因此前端已支持 abort 并不代表后端停止模型调用。上述调用在 auto 模式下多数落通用 8192 目标，不能把它们误算为已纳入剧本生成专用策略。

## 逐网络出口的覆盖复核

补充核对了 backend/src 的最终网络调用、生成入口及依赖注入回调。普通 jobs 文本生成此前未作为独立入口族列出，本次补入：它经 [队列执行](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2468) 进入 [非流式文本分支](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:1382)，有请求容量预检，但不能继承主流程的全部 trace/取消/接续，也不能继承仅为 image/video 保存的 attempt 防重。

以下 12 处为当前源码中的模型相关最终网络请求位置，同一位置可能服务多个业务和协议分支。表中任务号指实施方案任务；“纳入”仅代表审查和计划覆盖，尚未实施或真实渠道验证。

| 网络出口 | 覆盖的实际分支 | 实施任务 |
| --- | --- | --- |
| [requestJson](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:234) | jobs 非流式文本（Responses/Chat/自定义模板）、图片 JSON/multipart、异步图片查询、视频创建/查询 | 1、3、4、10 |
| [工具传输](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:552) | Responses/Chat 工具会话，含流式/非流式分支 | 1、3、4、6、7、10 |
| [通用文本传输](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:767) | 普通文字、结构化及多模态输入，含 SSE/JSON、标准/自定义模板 | 1、2、3、4、10 |
| [结果下载](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:928) | 图片/视频结果下载与仅下载恢复；不属于重新生成 | 4、10 |
| [Messages](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-anthropic.ts:143) | 文字、工具循环和 jobs 的流式/非流式原生 Messages | 1、2、3、4、7、10 |
| [Gemini 原生反推](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/gemini-image-analysis.ts:86) | 图片模型另配置的 TEXT 分析端点 | 3、9、10 |
| [语音合成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/speech-provider.ts:86) | 单条配音与批量配音的逐条 TTS 请求 | 4、10 |
| [后台创建](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-background.ts:43) | 显式支持 background 的 Responses 创建 | 1、3、4、10 |
| [后台查询](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-background.ts:71) | accepted response ID 查询/重启恢复 | 1、3、4、10 |
| [后台取消](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-background.ts:98) | 厂商支持时主动取消已有后台响应 | 4、10 |
| [输入计数](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-request-plan.ts:58) | 同渠道 Responses input_tokens / Messages count_tokens | 1、4、7、10 |
| [模型目录](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/model-catalog.ts:122) | 模型列表与可确认能力元数据发现 | 2、10 |

业务子步骤也必须分别接入策略、信号和用量：自动技能选择与可选参考选择、分镜及 video_prompt 两套技能准备、初次生成与独立语义复核、证据定位与修复。视觉设定板生成和独立参考图生成虽然都进入 jobs，也分别验收来源冻结和付费任务身份。确定性检查/提示词预览及本地导出不因名称含 AI 就算一次模型请求。scriptWorkPlan、planDraftReviewTasks、selectSourceMaterial、prepareConfirmedScriptContext 当前不请求模型。generateLongStageDraft/repairLongScriptDraft 未找到生产调用，作为未接入兼容实现另标，不把它们算成活跃模型请求，也不据此删除。

## 业务子调用的实施归属

下表将同一功能中的准备、生成、复核和修订分别列入；复用同一网络出口不代表这些步骤可跳过接入。任务号对应实施方案。

| 子调用/契约 | 源码 | 实施任务与保留约束 |
| --- | --- | --- |
| workflow_draft / script_stage_blocks | [首次阶段生成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:567)、[语义单元](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:659) | 1/5/6/7；首次主动选单元、完整单元保存、接续上下文减量 |
| script_stage_artifact_repair / script_stage_scene_repair / script_stage_block_repair | [产物字段](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-artifact-repair.ts:52)、[场次字段](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-scene-repair.ts:21)、[块字段](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-block-repair.ts:105) | 1/3/5/6；前两者仍重发正文，应复用第三者字段差异方式；原文保留、一次修正与最终校验不变 |
| script_source_map / script_source_evidence_repair | [地图及引文坐标](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-analysis.ts:206) | 1/5/6/7；已有分页与证据约束保留，不把地图分页当全部原稿分析都可续接 |
| script_source_story / script_source_story_${kind} | [短原稿整份](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-story.ts:66)、[长原稿分任务](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-story-parts.ts:302) | 1/5/6/7；overview、characters、characters_merge、timeline、threads、uncertainties 各子任务截断恢复分别验收 |
| script_source_quality / script_source_quality_repair | [质量核对](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-quality.ts:31)、[逐问题修复](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-quality-repair.ts:159) | 1/5/6；核对结果需长列表恢复；修复已逐问题保存，继承现有预期值校验，不重建为整份修复 |
| script_chat_source_scope | [原稿范围决策](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-chat-source-context.ts:179) | 1/7；短决策和只读聊天范围限制，不套长文接续 |
| script_draft_completeness / script_draft_evidence_repair 及各自 _page | [完整性/证据核对](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-draft-review-evidence.ts:65) | 1/5/6；候选、范围和精确证据绑定，部分完成不表示报告完成 |
| script_finding_groups / script_document_review_page | [问题归组](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-finding-groups.ts:67)、[原生审读后的报告恢复](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-document-review-generation.ts:109) | 1/5/6；归组与只读报告恢复分别验收 |
| 原生候选修补 get_repair_context / search_repair_context / submit_repair_patch | [独立修补循环](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-draft-repair-tools.ts:100) | 1/3/4/5/6/7；这是正常修补主路径；最终仍一次提交全部决定/补丁，截断不会自动进入兼容 decisions/edits，应明确加入小批完整提交契约 |
| script_draft_repair / script_draft_repair_decisions / script_draft_repair_edits | [兼容生成与两阶段恢复](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-draft-repair-generation.ts:73) | 1/5/6；旧断点/明确工具不支持路径，不能将其恢复能力直接算给上面的原生工具路径 |
| 导演通用原生工具循环 | [document tools](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-document-tools.ts:1378) | 1/3/4/5/6/7；工具 profile、读覆盖、写屏障、版本和进展保护保留 |
| 自动技能选择 select_creation_skills | [选择循环](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/model-skill-selection.ts:179) | 1/4/7/9；只读小决策、残参不执行、目录与配置身份 |
| 可选参考 read_skill_reference / submit_skill_references | [参考循环](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/model-skill-selection.ts:80) | 1/4/7；实读回执、预算、目录白名单与无进展保护 |
| 无原生选择器的 creation_skill_selection / creation_skill_reference_selection | [备用结构化选择](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/model-skill-selection.ts:232) | 1/4/7；备用分支独立测试，不误计为每次额外必发请求 |
| 分镜前置 storyboard / video_prompt 两套技能准备 | [两套准备](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/storyboard-planning.ts:284) | 1/4/7/8；两套都接取消/用量/身份 |
| controlled_storyboard / storyboard_directing_review / makePlan 修订 | [生成与复核](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/storyboard-planning.ts:322) | 8；候选、复核、修订独立保存与定向恢复 |
| shot_plan / clip_storyboard | [旧分镜](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3685)、[片段](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/clip-storyboard.ts:97) | 1/4/8；共用单元策略但保留各自提交语义、audio_plan 完整链 |
| visual_profiles / 画布 prepare 按组复用分析 | [视觉分析](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/visuals/visual-profiles.ts:806)、[画布准备](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/script-canvas-preparation.ts:88) | 4/7/8；共享对象依赖和 design_id 隔离，画布 prepare 不是另一份模型契约 |
| refined_prompt / prompt_refinement_semantic_review | [精炼](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/skill-routes.ts:388)、[独立语义核对](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/prompt-refinement-semantics.ts:90) | 4/8；保留同一候选，只恢复未完成复核；多模态闭包最多使用实际提供图片 |
| image_prompt_optimization / asset_prompt | [拒绝后优化](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/prompt-optimization.ts:37)、[素材提示词](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3338) | 1/4/9；建议与显式应用独立，不自动重新付费生成 |
| 单图 streamText / analyzeGeminiImage | [两条适配](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/image-prompt-analysis.ts:66) | 3/9；实际模型/端点、停止原因及用量分别核对 |
| video_prompt_analysis / video_review | [反推](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/video-prompt-analysis.ts:123)、[审片](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/assets/video-review.ts:151) | 4/9；视频范围、实际证据、跨段镜头和最终覆盖校验 |
| video_handoff_plan / canvas_node_proposal | [音画交接](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/video-audio-plan.ts:110)、[节点提案](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/canvas-node-proposals.ts:170) | 1/4/9；前者分析缓存与确认计划分开，后者参数白名单与来源指纹保留 |
| theme_visuals / reply_classification / continuity_report | [主题](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3542)、[回复](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:3575)、[连续性](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2923) | 1/4/9；短分类与相邻镜头对分析采用各自策略 |
| visual 设定板 generateBoard / 独立参考 generateReference | [两条注入](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2600)、[独立参考入口](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/visuals/visual-reference-assets.ts:252) | 4/10；多候选/版本/接受后重启/重复继续分别验收，不只验普通生图入口 |
| 通用 jobs 文本生成 | [通用生成 API](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:4347)、[非流式适配](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:1382) | 1/3/4/10；取消、非流式模板、trace、用量及任务恢复独立核对 |

## 外部源码依据

以下编号用于对照表的“借鉴依据”。公开源码固定到核查提交，避免后续分支变化导致结论漂移。Claude Code 核心未完整公开，相关行为仅按官方文档及更新记录确认。外部实现证明技术机制，剧本覆盖、人物一致性、镜头时长和确认保存等规则仍需本项目实现。

| 编号 | 固定源码或官方依据 | 能确认的机制 |
| --- | --- | --- |
| S01 | [Codex incomplete 终止测试](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/tests/suite/client.rs#L3892) | 明确输出额度耗尽不等于可重试网络故障；测试断言只有一次请求 |
| S02 | [OpenCode 输出接续](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/llm.ts#L348) | 保留已有内容、要求剩余工作拆小，连续截断后停止 |
| S03 | [Harness 保存响应后结束](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L566) | 内容、流和用量持久化；`max-tokens` 独立结束状态 |
| S04 | [Harness overflow 恢复](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/index.ts#L213) | 输入超限才走压缩恢复，要求持久化进展并限制重试 |
| S05 | [OpenCode 工具参数完整性](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/publish-llm-event.ts#L40) | 残缺参数不执行，要求拆小并重发完整调用 |
| S06 | [OpenCode 工具结果外置](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/tool-output.ts#L69) | 完整结果持久保存，模型获得有限预览与读取路径 |
| S07 | [OpenCode 网络/一次性付费请求重试](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/model-retry.ts#L11) | 退避、抖动、Retry-After 上界；一次性请求另判断是否未执行 |
| S08 | [OpenCode 模型运行配置与兼容能力](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/model-resolver.ts#L245) | 模型能力、兼容字段和传输超时分别管理 |
| S09 | [OpenCode 目录缓存](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/models-dev.ts#L520) | 版本化缓存键、来源、摘要、TTL、ETag 和刷新互斥 |
| S10 | [OpenCode 请求上下文及缓存亲和](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/model-request.ts#L310) | 会话身份、请求整形、按能力传缓存配置 |
| S11 | [Codex 请求用量事件](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/otel/src/events/session_telemetry.rs#L647) | 请求/会话关联，输入、输出、推理和缓存 token 分别记录 |
| S12 | [OpenCode 会话执行协调](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/run-coordinator.ts#L6) | 相同 key 串行、不同 key 并发、interrupt 与清理完成分开 |
| S13 | [OpenCode 重启恢复约束](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/execution/restart.ts#L47) | 持久化执行归属、重启恢复；明确不能凭恢复协调保证外部副作用 exactly-once |
| S14 | [Codex 图片请求身份](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/codex-api/src/endpoint/images.rs#L17) | 图片请求成功和错误都尽量保留厂商请求编号 |
| S15 | [Claude Code 自动恢复记录](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md#L3588)、[官方上下文管理](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up) | 输出截断自动恢复、摘要与按需加载；不能据此推断未公开的精确算法 |
| S16 | [Harness 截断工具过滤](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/assembler.ts#L130)、[摘要完整性](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/summarizer.ts#L203) | 不执行截断工具调用，不采用被截断的摘要检查点 |
| S17 | [OpenCode 传输帧边界](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/ai/src/route/transport/websocket.ts#L213) | 对单个 WebSocket 消息限制大小；不是模型总输出 token 限制 |
| S18 | [Harness 保持摘要前缀](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/summarizer.ts#L25) | 复用稳定 system/tools/messages，尾部追加摘要要求 |
| S19 | [OpenCode 工具过滤](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/tool.ts#L254)、[Codex 后续工作驱动](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/stream_events_utils.rs#L370) | 按允许范围提供工具，完整工具结果驱动后续模型轮次 |
| S20 | [OpenCode 原生思考与结构化格式](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/ai/src/protocols/anthropic-messages.ts#L294) | enabled + budget_tokens、adaptive、disabled 与 output_config.format/effort 分别建模 |
| S21 | [OpenCode Responses opaque 回放](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/ai/src/protocols/openai-compatible-responses.ts#L12) | 特定适配声明 store:false 与 reasoning.encrypted_content；不能推广为所有网关能力 |
| S22 | [OpenCode 按输出阶段恢复](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/runner/step.ts#L205) | outputStarted 参与整次重试与保留已有输出后的恢复选择 |
| S23 | [OpenCode 唯一位置编辑](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/tool/plugin/edit.ts#L303) | 小范围替换需唯一匹配，无变化/歧义/冲突不提交 |
| S24 | [Codex 工具并行准入](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/tools/router.rs#L267)、[并行/排他调度](https://github.com/openai/codex/blob/c875667eb837663697d5ffa32d375043434e73b4/codex-rs/core/src/tools/parallel.rs#L292) | 工具执行能力及并行/排他锁与模型是否允许多调用分别处理 |
| S25 | [OpenCode 自动预算误差与余量](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/core/src/session/model-request.ts#L53) | 本地估算误差和 shared 窗口 framing 余量分别考虑；具体常量不宜照搬 |
| S26 | [OpenCode 功能能力](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/schema/src/model.ts#L77)、[兼容能力](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/schema/src/model-compatibility.ts#L25) | 模态、工具、temperature 与 token 字段、推理字段及结束原因等兼容设置分开 |

## A. 任务策略、模型能力与配置

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| A01 显式任务策略；覆盖不完整 | [用途映射](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-usage-parse.ts:32)、[自动额度](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-context.ts:104)、[重试前缀判断](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/generation/model-output.ts:208) | 参照 S08/S10，把用途、只读性、可恢复错误、输出目标、最小单元、检查点和取消所有者由调用方显式声明。`controlled_storyboard`、`visual_profiles` 以及仍在使用的 `shot_plan`、`complete_script` 等当前自动目标落到 8192；不能继续靠契约名字猜。固定 65536 不受此回退影响。 | 每个入口均能追溯任务策略；新增/重命名契约不意外改变输出、重试或权限；固定值保持精确；短分类仍用小请求。 |
| A02 渠道兼容能力；可扩展 | [能力契约](/Users/caoyanzu/workspace/ai-video-creation-tools/packages/shared/src/models/text-capabilities.ts:1)、[结构化协商](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-output-capability.ts:13) | 参照 S08/S26，分清目录声明、人工覆盖与实际观察到的结构化/工具/stream usage/推理支持。当前容量已分层、JSON Schema 也有安全降级；扩展到统一兼容能力记录，并保留来源和生效身份，不为探测另发收费生成。 | 不把 401、网络故障或 invalid schema 当“不支持”；改变渠道/协议/模型后观察值失效；不能从模型名字猜网关支持。 |
| A03 目录新鲜度与刷新；可选 | [目录发现](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/model-catalog-capabilities.ts:20)、[作用域](/Users/caoyanzu/workspace/ai-video-creation-tools/packages/shared/src/models/text-capabilities.ts:58)已有地址/协议/模型和获取时间 | 参照 S09，增加版本化读取缓存、ETag/刷新合并和过期提示。保留当前“刷新编辑草稿、保存才提交”和人工覆盖；目录年龄不应直接把配置判为非法，也不后台覆盖用户设置。 | 同时刷新不重复拉取；过期来源可见；取消编辑不写库；刷新失败保留原值；刷新不会改用户额度。 |
| A04 独立原生分析的统一外围契约；覆盖不完整 | [Gemini 图片反推](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/gemini-image-analysis.ts:38)用一般 Error 表达 MAX_TOKENS，[请求体](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/gemini-image-analysis.ts:74)独立发送 | 参照 S03/S08/S11，让原生适配复用停止原因、请求身份、取消、诊断和可用用量事件；原生生成参数与能力单独适配。不能把“图片生成模型”的容量配置直接当成其另一 remote_id 分析接口的能力。 | 原生 MAX_TOKENS 与网络断开区分；记录实际分析模型/端点；未知用量仍未知；不降级到付费生图；不擅自重试。 |
| A05 最终请求计划可追溯；已有基础、可扩展 | [统一计划](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-request-plan.ts:35)、[实际发送及指标](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:741) | 参照 S08/S10，为各协议/自定义模板/后台路径保留同一份有效计划摘要：端点身份、任务用途、实际输出字段与值、能力来源、推理设置和输入计数来源。放技术详情；避免再增加与实际发送不一致的旁路估算器。 | 展示值与线上 body 一致；自定义流式/非流式覆盖分别可查；推理是否占输出按已知渠道规则解释；不把 reserve 显示成实际发送值。 |
| A06 推理模式及预算按能力适配；覆盖不完整 | [标准推理映射](/Users/caoyanzu/workspace/ai-video-creation-tools/packages/shared/src/models/text-api-settings.ts:97)中 Messages 的非 off 档位均生成 adaptive + effort；已有输出是否含推理的容量区分 | 参照 S20，明确 fixed thinking budget、自适应思考、effort 的支持模式及边界，表单/适配器按已确认能力生成。仅在渠道语义明确时预留正文空间。当前特定 DeepSeek 官方恢复策略继续保持限定范围。 | 固定预算模型不收到 adaptive；budget_tokens 满足协议且与 max_tokens 合法；未知网关不假定 effort 支持；不为恢复擅自关闭推理或改固定额度。 |
| A07 结构化输出协商覆盖；覆盖不完整 | [安全协商](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-output-capability.ts:13)已有；[接入条件](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:711)仅 screenplay contract 自动进入；分镜/visual/refine 未统一接入 | 参照 S20/S26 的能力及协议分层，将已有谨慎协商复用到所有适用结构化入口；原生 Schema、JSON、prompt 的选择遵守显式设置和实际兼容性。外部源码证明分层，不证明其使用和本项目相同的自动协商算法。 | 仅明确不支持格式的 400/422 可安全回退一次；invalid schema、认证、限流及网络错误不降级；配置变更使观察缓存失效；格式修正与网络重试仍分开。 |
| A08 自动预算的估算/framing 余量；可扩展 | [auto 输出 fit](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-context.ts:142)可刚好用完 shared 剩余窗口；已有本地保守估算和临界同渠道计数 | 参照 S25，针对已确认 shared 渠道，在 auto 模式显式解释估算误差与模板/工具 framing 余量，优先使用可靠渠道计数。该项是边界可靠性增强，不是某次事故已证实根因。 | 已知边界保留适当空间；精确与估算来源分开；固定 65536 不静默减少；separate/unknown 不错误套 shared 算法；不裁原稿、不新增累计额度硬限。 |

## B. 停止原因、恢复和传输

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| B01 统一停止状态；覆盖不完整 | [文本错误](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-errors.ts:29)已区分输出截断；[Messages](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-anthropic.ts:176)的其他停止原因落一般异常 | 参照 S01/S03/S04，统一 output_limit、context_overflow、disconnected、refusal、invalid_tool、business_incomplete 等机器状态，保留原始协议 reason，再分别选择接续、输入重组、退避、定向补齐或终止。`pause_turn` 仅在相应服务端工具能力已支持时专门处理。 | 同一错误在三种协议与原生分析下语义一致；不把截断送去 JSON 格式重试；拒绝/权限错误不循环重试。 |
| B02 上游真实输入溢出恢复；覆盖不完整 | [HTTP 错误映射](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:224)保留 upstreamCode；已有本地容量预检，未见统一的 provider-confirmed overflow 恢复 | 参照 S04：明确识别输入溢出后先外置大工具结果或重组工作集，只有可证明的输入减量/持久状态进展才有限重试。原稿不静默裁剪；无法安全减量时保留任务并解释原因。 | 同样 body 不能无限重发；模型切换按新容量重算；压缩失败或无进展停止；全文覆盖证据保留。 |
| B03 按交付状态决定重试；已有基础、可扩展 | [只读重试](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/generation/read-only-retry.ts:15)、[媒体执行防重](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/job-generation-recovery.ts:55) | 参照 S07，把未发出、明确拒绝、已接收、结果不确定分开。只读模型请求与付费一次性生成分别制定策略。保留抖动和取消；当前无总时限任务仍可能按异常 Retry-After 等待任意长，需补明确的等待上界/可见状态，不能让其静默卡住；这不等于新增累计任务硬限。不能将外部 503/传输错误一律当成没有计费。 | 已执行工具不重放；未知生图/视频提交不重 POST；只有可信未执行证据才允许相应重试；重试用量逐次记账。 |
| B04 分阶段超时；已有基础、可扩展 | [流作用域](/Users/caoyanzu/workspace/ai-video-creation-tools/packages/shared/src/script/script-stream-policy.ts:27)、[任务执行策略](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/generation/model-execution.ts:37) | 参照 S08，将连接/响应头、首事件、无数据间隔、总步骤分开描述和配置；区分真实上游进展与本地心跳。长剧本保留当前无默认总时限的业务策略，不能借此重新加任意累计硬限。 | 慢首包与中途静默可诊断；有效长任务不被误杀；取消和超时原因不同；计时器/reader 清理完成。 |
| B05 帧、字节和内存边界；可选健壮性优化 | [通用 response.text](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:228)、[流累积](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:783)；Gemini 原生已有 1MB 响应保护，媒体下载已有流式大小保护 | 参照 S17 的传输边界原则，对异常无分隔符 SSE、巨型单事件和非文本错误页设置明确边界；长正文可增量写暂存对象。不能照搬 OpenCode 的 WebSocket 16MiB 成为整份剧本输出上限。 | 巨型坏帧可终止且不 OOM；正常长剧本可分单元保存；UTF-8/跨 chunk 解析不破坏；传输大小错误与 token 上限分开。 |
| B06 断流后的 attempt 与部分成果；覆盖不完整 | [网络断流](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:875)转为可重试错误，但错误未统一携带 partial 状态；[通用收集器](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2082)失败后无共同保留契约；剧本已捕获完整单元 | 参照 S03/S22，分别记录未开始、已输出未完成、完成、失败；长业务保存已验证的完整单元后补剩余工作，短任务仍可按策略整次重试。提供商支持 accepted ID 时优先查询；无 ID 不伪称可精确恢复。 | 0 字断流与已有完整单元的恢复不同；重连/重启不另起已完成生成；半截 JSON 不算合格成果；残缺工具参数不拼接执行；重复内容和晚到结果受约束。 |

## C. 上下文、资料读取与缓存

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| C01 长创作的按需原文工作集；覆盖不完整 | [局部资料仅限只读问答](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-chat-source-context.ts:96)、[视觉档案完整资料](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/visuals/visual-profiles.ts:799) | 参照 S06/S15，复用项目已有目录、范围读取、版本和覆盖记录，扩展到长创作/分镜/视觉分析。携带全局约束及当前单元必要证据，并安排最终跨文档核对；不能以摘要冒充通读。 | 资料范围可追溯；全局伏笔/人物身份不因局部化漏检；源变化使派生状态失效；小窗口能逐段处理长稿。 |
| C02 接续状态增量化；可扩展 | [阶段接续](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:414)、[审读分页](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-review-pagination.ts:74)每轮重复完整 prompt 和累计成果 | 参照 S03/S04/S10，已完成正文持久保存，后续发送稳定单元清单、必要相邻正文、覆盖状态和按需句柄。保留可追溯原文；不能只发哈希就假设模型了解内容。 | 请求不随全部历史正文无界增长；已完成正文不重写；重复与冲突检测不退化；缺失信息可补读。 |
| C03 大工具结果统一分页/外置；覆盖不完整 | [现有分页](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-document-read-page.ts:3)和资源分页已具备；[完整草稿读取](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-document-tools.ts:1217)仍可能整份返回 | 参照 S06，为大草稿、全文原稿及最新巨型工具结果补概览、句柄、范围/游标读取。服务器可使用现有数据库对象，无需把 Coding Agent 文件路径照搬给用户。 | 首次巨型结果也能受控；同版本无损还原；预览不算已读；精确编辑依据仍能取回。 |
| C04 Messages 原生安全压缩；覆盖不完整 | [text-tools](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-tools.ts:45)为保护签名 thinking 和嵌套工具对，跳过现有 OpenAI 历史压缩 | 参照 S04/S08/S16 及 [原生 signature/redacted 保真](https://github.com/anomalyco/opencode/blob/a010a427e63c1f6406cef313041768a2381d3f2b/packages/ai/src/protocols/anthropic-messages.ts#L862)，建立适配原生协议的压缩/替换规则，保留完整工具配对、签名块和不可丢失证据。当前跳过是合理保护，不能直接删除该分支套用通用 compactor。 | 历史合法且签名不改写；工具 ID 配对正确；被保留读写证据可校验；压缩确实释放输入空间。 |
| C05 稳定前缀与渠道缓存；可选性能优化 | [工具 profile](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-tool-profile.ts:1)已有稳定顺序；[结构化请求拼接](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/generation/model-output.ts:215)各自构造动态内容 | 参照 S10/S18，将稳定规则、工具/Schema、源目录放前，本次目标/纠错/新增状态放后；仅在渠道声明支持时使用对应 cache key/control。缓存命中不减少窗口占用，不承诺兼容网关必然缓存。 | 相同来源前缀字节稳定；源/权限/Schema 变化正确失效；以真实 cache tokens/费用/耗时评估收益，不只比较字符数。 |
| C06 计数与分析缓存分层；已有基础、可扩展 | [临界渠道计数](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-request-plan.ts:35)、[本地估算](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-context.ts:39)、[原稿缓存](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-analysis.ts:305) | 参照 S08/S09，将计数缓存、源资料理解缓存与供应商前缀缓存分开。计数绑定最终输入/媒体/工具/Schema和渠道能力；分析缓存继续绑定源版本、pipeline、模型配置和质量复核。技能缓存需实际传 reuseKey 才生效；回复分类需明确模型身份未入查询键的语义；音画衔接的“已确认业务方案复用”与“用新模型重新分析”须区分，后者不能假执行旧缓存。不能共用一个“缓存命中”概念。 | 未知视频/视觉成本不冒充精确；计数失败明确回退；改变工具/模型/输入使计数失效；质量过期不跳复核。 |
| C07 有能力依据的 opaque 推理回放；可选协议增强 | [原生历史保留](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:606)已保留 Responses items、Chat reasoning_content，[Messages](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-anthropic.ts:104)保留签名块；标准 Responses 默认未显式请求 encrypted reasoning | 参照 S21，对明确支持无状态 encrypted reasoning 的适配器，按渠道声明请求并原样回放 opaque 字段，绑定 provider/model/protocol；与 C04 的历史压缩分别处理。不能对任意兼容网关强加 include/store。 | 原始 opaque 字节往返且不混入可见正文；换渠道不携带错误回放；压缩不改签名；未知能力不启用；不要求展示私有推理。 |

## D. 长输出、结构化成果与检查点

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| D01 剧本首次主动选语义批次；覆盖不完整 | [首次整份生成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:567)；已有截断后按完整人物/集/场接续 | 参照 S02/S19，以有效输出预算和成果范围选择一次完成或语义批次。保留原有全局任务及最终校验，减少先截断一次的浪费。 | 小任务仍一次完成；长任务首轮能保存完整单元；范围/集数/细节不因分批缩水。 |
| D02 分镜按场/镜保存与接续；覆盖不完整 | [场次分镜](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/storyboard-planning.ts:322)、[片段分镜](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/clip-storyboard.ts:97)为整包 JSON | 参照 S02/S03，按完整场次或镜头生成和持久保存，问题修订定位到受影响单元；合并后检查总时长、镜头身份、空间/动作接续和对白来源。两条场次分镜 API 都应接入同一单元契约；单次 shot_plan 的 audio_plan 在前端预览/创建丢失也要校正，不能只校验模型返回后又丢弃。 | 中间一场失败只补该场及受影响邻接；已过场次复用；不会盲拼 JSON 或丢跨场连续性；预览、应用、存储及读取保留相同音频计划；源在后端生成期间变化也拒绝旧结果。 |
| D03 视觉档案拆定义和用途；覆盖不完整 | [视觉分析](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/visuals/visual-profiles.ts:806)整批返回 profiles 及 shot_usage | 参照 S02/S03，先稳定对象/版本清单，再按对象生成定义、按场/镜生成用途；处理 base_draft_key 依赖、重复对象与别名。不得将同一人物不同状态机械合并。 | 对象不重复；派生版本依赖合法；所有选中镜头用途齐全；未确认前不写正式档案。 |
| D04 报告分页推广与检查覆盖；已有基础、覆盖不完整 | [剧本审读分页](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-review-pagination.ts:70)已具备；[视频复核](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/assets/video-review.ts:151)、[视频反推](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/video-prompt-analysis.ts:123)、[源质量问题](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-quality.ts:31)、[故事长列表](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-source-story-parts.ts:302)仍各任务整份返回 | 参照 S02/S03，将完整问题分页与断点复用于长列表报告，视频分别处理真实镜头边界/逐镜提示词和审片问题报告；源质量问题与时间线/伏笔列表按完整单元保存。地图已有分页不等于所有分析子步骤可续接。镜头文字连续性按相邻镜头对保存并汇总；问题页大小/20 条 findings 上限不等于检查范围或问题穷尽，仍需全局报告。 | 后页失败保留前页；问题去重；时间段无漏空、分段边界不冒充真实切镜；源/范围/fps 变化不混批；全部章节覆盖、跨章因果和原文证据仍校验；无问题结论也有完整覆盖证据。 |
| D05 决定/补丁进一步分批；覆盖不完整 | [决定](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-draft-repair-generation.ts:98)、[补丁](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-draft-repair-generation.ts:114)各要求全部内容 | 参照 S05，原生修补主路径和兼容生成路径都以 issue_id 和完整编辑操作分批保存，失败只补剩余项；合并后校验决定覆盖、唯一引文、补丁不重叠、正文/分场同步。 | 二次超限仍可恢复；已确认决定不重新决定；半截补丁不执行；正式文档不会逐批半保存。 |
| D06 长提示词和局部编辑；可选 | [提示词精炼](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/skill-routes.ts:388)、[优化](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/prompt-optimization.ts:37)完整正文一次返回 | 参照 S23，短提示词保持简单；仅大正文/局部改写提供段落或精确编辑操作，保留原稿和有效候选，失败不要求全文重生成。保留精炼已有独立语义复核；完整候选已保存而复核中断时只续复核。不能为短分类和单节点添加无意义接续。 | 短任务请求数不增；长编辑保留无关正文；引文、台词、固定区块和语义约束有效；复核重试不重新改写候选；未通过候选不自动覆盖原稿。 |
| D07 画布准备按设计组持久进展；可扩展 | [画布准备](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/script-canvas-preparation.ts:1)已有分组/签名复用，组间结果等待全部成功 | 参照 S03/S12，将完整且校验合格的设计组结果持久保留；一个组失败不丢其余组。独立组有界并发，保留设计域边界和最后提交校验。 | 某组失败只重做失败/失效组；不会串用别的设计方案档案；源变化后只失效受影响成果。 |
| D08 可复用的成果断点契约；已有基础、覆盖不完整 | [剧本生成步骤](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-generation-steps.ts:33)、[版本及最终重验](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:132)已成熟，其他长入口多为请求内临时变量 | 参照 S03/S13/S16，抽取轻量的输入身份、单元 ID、校验、持久进度和失效约定，复用于分镜/视觉/报告。完成标志不替代合同；派生摘要和半截 JSON 不可作为完整检查点。 | 刷新/重启/取消后保留完整单元；合并后做全部业务校验；业务提交成功但回复丢失时可识别已有结果，不能凭任务恢复声称 exactly-once。 |

## E. 工具调用与 Agent 循环

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| E01 截断工具调用的定向重生成；可扩展 | [工具会话](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-tools.ts:56)已只重试待决模型请求，模型输出截断导致工具参数不完整时仍结束该调用 | 参照 S05/S16，对已知支持拆分的工具返回“未执行＋更小完整调用”的恢复状态；部分审读已有只读报告重建，应保留。不能续接半截参数，也不能重放此前已执行调用。 | 截断调用执行次数为零；后续完整小调用可成功；重复截断/无进展停止；写屏障不被绕过。 |
| E02 工具/技能目录按任务加载；已有、可扩展 | [工具 profile](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-tool-profile.ts:1)、[技能按需资料](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/skills/model-skill-selection.ts:80)已具备 | 参照 S19/S15，在确定子任务范围时进一步减少无关 Schema/资料，保持稳定顺序。工具隐藏不能替代服务器授权，模型不能重选用户固定规则。 | 工具可见范围和执行权限一致；可选参考实读后才可引用；常用任务 schema 开销可测，业务路径仍可达。 |
| E03 只对独立读取有界并行；可选性能优化 | [导演调用写屏障](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-document-tools.ts:1473)保留有状态写入顺序；部分分析组已有并发 | 参照 S12/S24，在工具声明读写/资源范围/parallel-safe 后，仅在明确只读、互不依赖且版本一致时并行；按相同文档/设计/会话串行化有依赖任务。只读并行也要考虑总 token/响应体和渠道并发，不能盲目打开所有 parallel_tool_calls。 | 多写操作仍顺序；读取不会将旧版本证据用于新稿；并发取消和错误不丢已完成回执；以实际延迟判断收益。 |
| E04 业务进展及停滞规则推广；已有、可扩展 | [业务进展检测](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-tool-progress.ts:154)、[语义接续停机](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-stage-continuation.ts:720)已区分重复阅读/修改/失败 | 参照 S02/S04/S15，将完整新单元、新读取范围、有效校验变化与重复诊断推广到其他循环；压缩和重试也应有进展标准。不能把新时间戳、口号、同正文新版本算进展。 | 有成果的长任务可持续；A→B→A 和反复失败能停止；显式继续保留旧成果；不照搬固定两次续写硬限。 |

## F. 生命周期、取消、并发及付费任务

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| F01 端到端取消与所有权；覆盖不完整 | [片段分镜路由](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/storyboard/clip-storyboard.ts:78)、[视觉整理](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/visuals/visual-profiles.ts:863)未接取消链；[拒绝后优化](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/prompt-optimization.ts:12)、[画布准备](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/canvas/script-canvas-preparation.ts:88)也有路由缺口；[音画衔接 UI](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/features/canvas/ProjectCanvas.tsx:1644)未传 signal、其后端已有；[通用 HTTP](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:228)仅 timeout；[导演订阅](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/director-tasks.ts:219)由服务器持有任务 | 参照 S12，区分“停止等待”“停止任务”“取消远端生成”。请求型功能接通 UI→路由→模型→重试等待→reader；服务器任务断连仅退订，明确停止才取消。不能把 abort HTTP 宣称为厂商已停止计费。 | UI 取消能抵达上游；断连不误杀后台任务；停止后不再派发；后台 Responses 继续按 accepted ID 查询/取消、未知 POST 不重发；已完成结果保留；清理结束可见且不误报远端取消。 |
| F02 并发协调与渠道背压；已有基础、覆盖不完整 | [jobs 并发](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/job-queue.ts:39)已受控；直接文本/分析不都经过该队列；独立组有 `Promise.all` 路径 | 参照 S12/S07，统一轻量调度接口：相同任务/对象 key 协调执行，独立只读工作有界并发，渠道限流后尊重退避。按需增加渠道配额，不能假设所有产品都有同款全局调度器或将所有请求串行。 | 相同对象不竞争写；独立组可并发且有上界；429 不形成重试风暴；队列等待可取消；不阻塞已有厂商任务的结果查询。 |
| F03 用户主动换模型后迁移成果；可选产品能力 | [checkpoint identity](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2274)、[原任务配置校验](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/director-tasks.ts:245)严格绑定原模型，是当前有意保护 | 参照 S04 的切模型压力检查，将业务成果身份与运行配置身份分层；用户主动换模型时，仅迁移同源同合同下已验证语义成果，新模型重算预算/协议/上下文。供应商 response ID、签名 thinking、半截调用不可迁移。 | 切换失败保留旧任务；不自动换模型；小窗口重新预检；源/合同变化不复用；来源与迁移可追溯。 |
| F04 图片/视频/语音的阶段恢复；已有基础、可扩展 | [图片视频防重](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/jobs/job-generation-recovery.ts:55)、[厂商 ID 与结果保存](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2465)、[语音单次付费](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/speech-provider.ts:75) | 参照 S07/S13/S14，统一提交/已接收/查询/下载/本地持久化的状态与请求 ID。保留现在未知 POST 不重发、已有 ID 只查询、已有链接只下载的规则；补请求归属、停查和安全关停，语音中断保留不确定状态。 | 厂商可能接收后不重复付费；下载失败不重新生成；模型配置变化不能误查；本地取消与远端取消分开；语音没有完整成功帧不能冒充可用音频。 |

## G. 观测、界面与验证

| 编号与状态 | 当前项目证据 | 可借鉴的优化与边界 | 验收点 |
| --- | --- | --- | --- |
| G01 所有适配器的请求追踪；覆盖不完整 | [请求指标](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/providers.ts:93)已有；[通用业务包装](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/app.ts:2082)未向每个非剧本入口持久保留相同 trace；原生分析/媒体另走路径 | 参照 S10/S11/S14，task/step/attempt/request ID 串起每次派发、重试、降级、接续、查询与下载；保留实际模型/端点身份、状态、首事件/总耗时及停止原因。默认诊断不附完整原稿、密钥或媒体 Base64。 | 一次失败能定位具体请求而非猜测；成功/失败均能关联供应商 ID；恢复沿用任务但新请求有新 attempt；导出诊断可复核实际额度。 |
| G02 任务用量全覆盖；已有基础、覆盖不完整 | [用量范围与记账](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-request-usage.ts:101)、[剧本账本](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/modules/script/script-execution-usage.ts:20)已具备；无 active scope 时不做任务聚合 | 参照 S11/S03，让分镜、视觉、反推等也建立任务 ledger，纳入选择/读取准备/重试/格式修正/接续；媒体记录各自有意义的计量。保留实际/估算/未知与 cache/read/write 的区别，不重新强加累计硬上限。 | 中间失败及后台恢复不漏计/重复计；未知不写零；单次 output cap 与累计用量分开；原生图片反推不被误记为生图一次。 |
| G03 跨入口进度和恢复界面；已有基础、覆盖不完整 | [剧本执行视图](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/features/script/director-activity.ts:121)已有部分完成/截断恢复；成片复核已有历史/取消/stale、音画衔接已有常驻 running/success/error；其他规划/分析多为单次 loading 和失败提示 | 参照 S03/S15，将已完成单元、待处理范围、正在恢复、已停止和可继续状态按业务词展示；技术详情收起供诊断。继续读取旧任务/草稿，不把“重新生成”包装成“继续”。 | 刷新后仍能找到进度；失败不暗示全部成果丢失；不显示内部工具 JSON 作为产品流程；取消/失败/待确认状态准确。 |
| G04 跨协议事件契约与故障回放；已有基础、可扩展 | 现有 [后台恢复测试](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/test/text-background.test.ts:11)、[缓存用量测试](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/test/text-cache-usage.test.ts:6)及大量业务回归已覆盖若干情况 | 参照 S01 的终止测试、S02 的部分内容接续测试，建立可复用协议事件夹具与业务契约矩阵，覆盖正常/截断/断连/尾帧/取消/残参/原生停止原因/未知提交和恢复，及模型结果→预览→提交→持久读取的字段契约。先离线验证；真实渠道验证另记录，不用模拟测试声称真实额度已确认。 | 三协议/流式非流式相同语义；帧分割、延迟尾帧、重启及提交后断连可复现；检查完整性和副作用次数，音频等成果字段不在应用链丢失；避免只测 helper 或实现镜像。 |

## 已具备且必须保留的机制

- 标准提供商表单、三种文本协议、能力与请求额度分开、共享/独立/未知容量、目录作用域和手工覆盖。
- 最终请求预检、可选临界输入计数、固定额度不静默降低、未知能力不假装已验证。
- 输出截断与网络错误分开，截断工具参数不执行，工具副作用不随模型网络重试重放。
- 剧本完整语义单元接续、滚动断点、审读分页、决定/编辑分阶段恢复、缺分场定向补齐。
- 源/草稿版本、读取范围、精确引文、补丁不重叠、讨论/审读权限及写屏障、用户确认保存。
- 业务无进展检测、取消、后台任务、明确停止后的清理和已有用量记账。
- 文本后台 Responses 已有 [creating/accepted 与 response ID](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/infrastructure/providers/text-background.ts:23)、未知 POST 防重复、查询/取消；仅在明确开启能力且提供恢复上下文时使用。
- 图片/视频请求身份、厂商任务 ID、可恢复结果链接、未知提交防重复、查询与下载分阶段恢复。
- 语音按台词任务与 take、完成帧校验、输入/响应体限制和不自动重试付费生成。

这些是本次复核的基线，不是需要重新建设的清单。新增分批、缓存、并发、迁移或恢复必须继承这些约束。

## 不适用或不能直接照搬

- 不能承诺所有成熟产品都自动续写：Codex 当前明确 output-limit incomplete 路径会终止，Harness 默认核心也不是无条件接续。
- 不能照抄固定“两次接续”、剩余空间低至 1 token 或某个 8K/16MiB/50KiB 数字作为本项目统一限制。它们分别可能是客户端策略、工具结果字符阈值或传输帧边界。
- 不将流式展示和历史压缩当成提高单次输出能力；不靠压缩唯一原稿或减少要求让任务看似完成。
- 不为每个短分类、短提示词和单节点生成都加分批、后台任务或复杂 Agent 循环。
- 不自动换模型/渠道，不执行半截参数，不在恢复中重新申请已授权的创作决定，不把内部恢复失败变成新的创作问题。
- 不从配置、缓存或一次模拟成功推断渠道支持；也不将文本重试套到可能已被计费的生图、视频或语音提交。
- 不为了追求架构统一重写所有入口。可以复用当前请求计划、用量 scope、步骤、分页和断点组件，并以显式任务策略补齐差异。

## 后续实现的统一验收要求

每一项的专用验收已列在表格。所有实现还应共同满足：保留业务输入和完整交付范围；只持久采用验证通过的完整单元；失败/取消/重启后不重做已经有效完成的工作；源/合同变化时不拼接旧版本；正式写入、模型派发和外部付费副作用分别证明其执行次数；完成全部单元后再做整体业务校验；所有成功、失败及恢复行为都可从任务详情解释。

本次证据来自静态调用链与固定源码对照，未运行新的业务测试、未发真实生成请求，不能证明上述性能优化一定降低实际费用或某个第三方网关的真实限制。已有外部输出限制专项研究见 [成熟 Agent 输出限制调研](/Users/caoyanzu/workspace/ai-video-creation-tools/docs/research/2026-11-10-mature-agent-output-limit-handling.md)。
