# 模型接入优化实施覆盖记录

日期：2026-11-10。基线：`main@26905a7`，实施分支：`codex/model-integration-optimization`。本表逐项对应[41项源码对照](2026-11-10-model-integration-agent-source-audit.md)，记录当前实际落地范围，不把研究建议全部计为已经完成。

本轮代码在隔离工作区实现，未批量搬入原工作区其他未提交修改，未提交 Git。验证使用离线提供商夹具与临时 SQLite，没有调用收费模型或使用真实业务数据库。模拟回归不能证明某第三方渠道的真实输出上限、兼容能力、费用或延迟收益。

状态：**实施**表示本轮增加或贯通了代码；**保留**表示沿用原机制；**门控**表示只有明确声明能力才启用；**基线差异**表示研究引用的新增路径不在本次 main 基线，不能据此推断对应业务整体不存在。实施、保留和范围限定可同时成立，以下明确列出边界。

## A. 模型配置与请求计划（8项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| A01 显式任务策略 | 实施 | [model-task-policy.ts](../../backend/src/modules/generation/model-task-policy.ts)定义用途、单次输出目标、最小额度、只读/付费与恢复方式；ALS贯穿普通结构化、工具、多模态与jobs。既有契约由显式兼容表映射，新调用可直接传policy；短分类仍为原子结果。策略目标不冒充模型实际容量。 |
| A02 渠道功能与兼容能力 | 实施、门控 | [text-capabilities.ts](../../packages/shared/src/models/text-capabilities.ts)、[provider-configuration.ts](../../backend/src/modules/models/provider-configuration.ts)区分目录发现、手工覆盖与渠道作用域；[HarnessTextModelOptions.tsx](../../web/src/features/models/HarnessTextModelOptions.tsx)提供标准配置控件。未知能力不默认为支持。 |
| A03 目录新鲜度/缓存/刷新合并 | 实施 | [model-catalog.ts](../../backend/src/infrastructure/providers/model-catalog.ts)与[model-catalog-capabilities.ts](../../backend/src/infrastructure/providers/model-catalog-capabilities.ts)按URL/映射/protocol/auth hash隔离目录，5分钟TTL、ETag/304与同scope并发去重；返回深拷贝和freshness供表单草稿使用，不自动写模型。取消与trace保留；各等待者独立取消，不中断仍有等待者的共享请求。 |
| A04 原生Gemini分析统一外围契约 | 实施 | [gemini-image-analysis.ts](../../backend/src/infrastructure/providers/gemini-image-analysis.ts)接入统一请求身份、停止原因、usage、partial与取消；分析使用实际文本模型remote_id，不借用生图模型额度。 |
| A05 最终请求计划与实际参数 | 实施 | [text-request-plan.ts](../../backend/src/infrastructure/providers/text-request-plan.ts)、[providers.ts](../../backend/src/infrastructure/providers/providers.ts)先形成实际请求计划；metrics记录最终wire model、output_parameter/output_limit及用途，固定配置不被静默改小。 |
| A06 思考fixed/adaptive/effort | 实施、门控 | [text-api-settings.ts](../../packages/shared/src/models/text-api-settings.ts)与[text-anthropic.ts](../../backend/src/infrastructure/providers/text-anthropic.ts)区分思考模式、budget_tokens与effort并做协议及渠道能力校验；旧reasoning_effort和省略mode不能绕过已声明能力，界面使用标准选项。需要渠道支持，不承诺任意网关均能执行。 |
| A07 结构化输出协商 | 实施、门控 | [providers.ts](../../backend/src/infrastructure/providers/providers.ts)、[text-anthropic.ts](../../backend/src/infrastructure/providers/text-anthropic.ts)扩展适用契约的结构化协商；仅明确能力不支持才降级，认证、网络、invalid schema不被当成协议不支持。最终仍按业务schema校验。 |
| A08 自动额度framing与估算余量 | 实施 | [text-context.ts](../../backend/src/infrastructure/providers/text-context.ts)、[text-request-plan.ts](../../backend/src/infrastructure/providers/text-request-plan.ts)对已知共享上下文auto请求保留framing余量并记录原因；fixed原值不静默改变，未知容量保留未知。 |

## B. 终止、重试与传输（6项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| B01 统一停止与错误分类 | 实施 | [text-errors.ts](../../backend/src/infrastructure/providers/text-errors.ts)及三协议、原生Gemini、非流式jobs区分output_limit、context_overflow、断连、refusal、残缺工具、取消等；保留rawReason、delivery、partialText与outputStarted。 |
| B02 确认输入超限后的有效缩减恢复 | 实施、范围限定 | [text-tools.ts](../../backend/src/infrastructure/providers/text-tools.ts)只在上游确认context_overflow且尚未输出时，对可压缩工具历史受控恢复一次；必须证明序列化输入严格变小，否则原错误停止。精确编辑会话、不透明签名历史和不可缩减输入不重发，不执行或重放工具。普通长输入靠显式工作集减量，无法安全减量的业务明确停止，不能承诺任意输入可自动压缩。 |
| B03 根据交付状态重试 | 实施、保留 | [read-only-retry.ts](../../backend/src/modules/generation/read-only-retry.ts)仅重试尚未交付内容的明确瞬态只读请求；已出正文、output_limit/context_overflow、残参、拒绝及取消均不重试整次。遵守Retry-After，过长等待留给显式继续。图片/视频/语音付费提交沿用未知提交不重发。 |
| B04 连接/首事件/静默/总超时 | 实施、范围限定 | [text-transport-boundary.ts](../../backend/src/infrastructure/providers/text-transport-boundary.ts)对三文本协议独立控制headers、首个有效事件和后续idle；SSE心跳不重置首事件计时。保留nonstream/jobs较长body等待及父取消。辅助计数/目录和付费媒体保留各自caller total，不能宣称每条外部路径都有相同阶段时钟。 |
| B05 帧/响应体/内存边界 | 实施 | [text-frame-boundary.ts](../../backend/src/infrastructure/providers/text-frame-boundary.ts)按所有小行累计控制单个未闭合SSE事件4MiB；[text-transport-boundary.ts](../../backend/src/infrastructure/providers/text-transport-boundary.ts)错误体64KB后停止读取并cancel，保留HTTP分类与Retry-After。合法累计超过4MiB的流式/非流式长文没有总字符硬限，媒体/语音原边界保留。 |
| B06 截断片段与可用业务单元 | 实施 | 提供商保留单次partial诊断，业务只从已闭合schema单元恢复；剧本流、分页、修补批次分别校验后保存。半截JSON和半截工具参数不执行，不以完成标志代替完整合同。 |

## C. 上下文与缓存（7项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| C01 长创作的来源工作集 | 实施、范围限定 | [script-stage-context-workset.ts](../../backend/src/modules/script/script-stage-context-workset.ts)接入实际阶段生成：app传可信原稿content/version，仅外置与其精确唯一匹配的程序原文payload；完整原始授权、对话和创作要求逐字保留，完整prompt/request仍参与identity。原文与所有旧成果按版本句柄精确范围读回；无可信来源或同内容标记有歧义时保留原输入。目录/回执不等于全文已读，最终全局审读仍用全文；不承诺任意长稿都能在任意小窗口下完成。 |
| C02 接续时增量上下文 | 实施、范围限定 | 阶段长源/长已收正文启用专用JSON exchange；接续发送当前目标、完整目录、游标和最近两个完整单元，旧文按需精确读取。result只能引用当前实际返回且仍在本轮输入中的范围，独立请求/重启重新读；截断read零执行，伪造/过期/重复/换序无新字节读取拒绝。短路径保留。真实app夹具证明派发prompt显著减小，全文审读失败后只续审读。固定授权或不可外置规则自身仍可能超过输入容量，不能静默裁剪。 |
| C03 大工具结果分页/外置 | 实施 | [script-document-tools.ts](../../backend/src/modules/script/script-document-tools.ts)将大结果外置为当前会话的版本句柄，通过read_model_resource按范围取完整内容；句柄本身不计作已读正文，不影响服务器实际执行与原有读取权限。 |
| C04 Messages原生历史安全压缩 | 实施、门控 | [text-tool-history.ts](../../backend/src/infrastructure/providers/text-tool-history.ts)仅移除完整纯tool_use/tool_result旧配对，保留最新交换。出现signed、redacted、thinking、reasoning等不透明历史时整段跳过；精确编辑会话保留原读凭据策略，不能将签名内容转写为摘要。 |
| C05 稳定前缀与供应商缓存 | 保留 | 沿用已有稳定前缀/缓存参数和usage区分，没有为所有协议新增统一prompt-cache参数或改写既有缓存语义。实际命中收益需要真实渠道测量。 |
| C06 计数/分析/提供商缓存分层 | 实施、保留 | 最终请求可选原生计数纳入真实tools/schema/images，计数有独立辅助trace；[model-skill-selection.ts](../../backend/src/modules/skills/model-skill-selection.ts)及业务调用补实际模型/渠道reuseKey。源分析保持源版本/合同身份；没有把计数缓存、分析结果复用和供应商prompt cache当成同一种缓存。 |
| C07 不透明推理回放 | 实施、门控 | 只有compatibility.encrypted_reasoning明确为true才发送store:false/include encrypted reasoning；Responses原始items回放保留，未知网关不强制发该参数，跨模型迁移排除这些items。 |

## D. 业务语义单元与断点（8项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| D01 剧本首轮主动语义单元 | 实施、保留 | [script-stage-continuation.ts](../../backend/src/modules/script/script-stage-continuation.ts)对明确偏好、长分集正文或调用方提供的低有效输出额度选择首轮blocks；短任务和依赖分组的大纲保留原路径。字段修正改为metadata delta，完整正文由程序原样保留。阶段合并仍做完整业务复核；仅长输入不会强制全部大纲变成blocks。 |
| D02 分镜按场/镜持久与接续 | 实施、基线差异 | [storyboard-planning.ts](../../backend/src/modules/storyboard/storyboard-planning.ts)长多场规划保存完整场单元；[app.ts](../../backend/src/app.ts)旧shot_plan有独立identity/断点入口，生成后重查source signature，成功清理断点。研究所引用的新增clip-storyboard模块不在main@26905a7，本轮未搬入；主干既有镜头/剪辑与语音业务保留。研究提出的新增audio_plan字段链路不在该基线，不能以不存在该字段声称既有音频系统缺失，也不能把未迁入的字段贯通算为已交付。 |
| D03 视觉定义/派生依赖/用途 | 实施 | [visual-profiles.ts](../../backend/src/modules/visuals/visual-profiles.ts)大范围先稳定共享对象目录与派生关系，再按拓扑生成完整档案并校验场/镜用途、依赖、重复与预算；最终提交前不写正式档案。 |
| D04 报告页与检查覆盖 | 实施 | [script-review-pagination.ts](../../backend/src/modules/script/script-review-pagination.ts)复用于剧本审读、源质量与故事长列表，完整项持久并校验全文/章节覆盖；密集短稿整份整合截断转持久任务。[video-review.ts](../../backend/src/modules/assets/video-review.ts)显式has_more接页；[video-prompt-analysis.ts](../../backend/src/modules/canvas/video-prompt-analysis.ts)长视频先真实切镜地图再逐镜。[app.ts](../../backend/src/app.ts)文字continuity按相邻镜头对分组持久，最终重验source signature并汇总保存，成功清理断点后显式重新检查仍会运行；仅文字检查，不冒充实际画面复核。 |
| D05 决定/修补分批 | 实施 | [script-draft-repair-batches.ts](../../backend/src/modules/script/script-draft-repair-batches.ts)、[script-draft-repair-tools.ts](../../backend/src/modules/script/script-draft-repair-tools.ts)新增submit_repair_batch，接受完整决定/精确编辑；[script-draft-repair-generation.ts](../../backend/src/modules/script/script-draft-repair-generation.ts)兼容decisions/edits重复截断后继续完整项分页。accepted决定不可改写，编辑对原快照定位、跨批不重叠，正式正文不逐批半保存。 |
| D06 长提示词局部编辑及候选/复核恢复 | 实施 | [skill-routes.ts](../../backend/src/modules/skills/skill-routes.ts)与[prompt-exact-edit.ts](../../backend/src/modules/skills/prompt-exact-edit.ts)对长正文使用精确find/replace、原文SHA256、可选段落ID/hash（含CRLF）、唯一匹配/不重叠/无效编辑拒绝、8→4→2→1分页和合法页续作；程序合并后仍复用引用/人物/逐字对白校验。candidate与独立语义review分step，审读失败只续审读；短提示词不增请求。[long-form-output.ts](../../backend/src/modules/generation/long-form-output.ts)补保留全文API的语义块/元信息/场次恢复。 |
| D07 画布准备按设计组持久 | 实施 | [script-canvas-preparation.ts](../../backend/src/modules/canvas/script-canvas-preparation.ts)按设计组顺序派发，复用完成组与其来源签名，checkpoint保留到commit；取消后不继续派发。没有改变设计域边界或将所有方案混入同一组。 |
| D08 统一完整成果断点 | 实施 | [generation-unit-execution.ts](../../backend/src/modules/generation/generation-unit-execution.ts)、[generation-unit-store.ts](../../backend/src/modules/generation/generation-unit-store.ts)按identity与unit ID持久，只保存验证通过的完整成果并在merge后总验；损坏JSON/结构409保留记录，lazy读取使用户显式restart能先clear。剧本保留单显示槽并增加精确历史身份隔离；成功预览/业务提交按各入口清理，画布prepare留到commit。不凭断点声称exactly-once。 |

## E. 工具循环（4项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| E01 截断工具定向重生成 | 实施、保留、范围限定 | 修补原生循环在截断后明确不执行残参，要求更小完整批次并按8→4→2→1缩小，停滞后保留ledger。普通导演工具循环继续安全停止，不无条件重放；并未对所有写工具启用自动拆分。 |
| E02 按任务加载工具与技能 | 保留、实施 | 原tool profile、技能目录白名单、按需正文与服务端权限保留；补模型/渠道缓存身份与稳定有序schema。隐藏工具不等于授权，也不允许模型重选用户固定规则。 |
| E03 仅独立读取有界并行 | 实施 | [model-tool-batch.ts](../../backend/src/modules/generation/model-tool-batch.ts)接导演循环：独立只读资源最多3个并行，同/交叠资源保持顺序；多资源被延后时保留相对资源顺序；首写是屏障，后续调用明确defer。以真实读写资源元信息与服务端权限约束，取消/错误等待已派发读取收束；读取返回普通失败结果也会将剩余读取、写入及后续调用逐一defer为read_prerequisite_failed，下一模型轮才能修正。每个调用仍有一个真实、有序结果，写入不因parallelCalls而并行。 |
| E04 真实业务进展与停滞 | 实施、保留 | 保留原读取/修改/失败进展检测；新增分页、blocks、batch与完整generation units都以新增有效成果判断进展，重复页/重复批缩小后停机。显式继续保留已完成成果，没有固定总任务token/两次接续上限。 |

## F. 生命周期、并发与付费（4项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| F01 取消与请求所有权 | 实施、保留、基线差异 | [creative-model-state.ts](../../backend/src/modules/skills/creative-model-state.ts)及分镜/视觉/画布/提示词入口连接请求取消→模型→等待→reader；server-owned导演断连只退订，明确停止才abort。原有付费任务保持厂商状态。研究引用的新增clip/handoff路径需按是否迁入另验，不能用现有通用signal声明未迁入路径也已贯通。 |
| F02 对象协调与渠道背压 | 实施、范围限定 | [model-admission.ts](../../backend/src/modules/generation/model-admission.ts)同key串行、独立key并行、排队可取消；[model-channel.ts](../../backend/src/infrastructure/providers/model-channel.ts)同base/protocol/auth hash单进程共享4个活动文本槽位，FIFO和429 Retry-After共享冷却，长等待返回retryAt而不暗中重发。接三文本协议/tools/jobs/background和Gemini TEXT分析，count/catalog、TTS与付费媒体保留原生命周期；不宣称跨进程分布式限流或精确预测厂商RPM/TPM。 |
| F03 用户主动换模型续成果 | 实施 | [script-checkpoint-model-migration.ts](../../backend/src/modules/script/script-checkpoint-model-migration.ts)、[app.ts](../../backend/src/app.ts)和[ScriptDirectorPanel.tsx](../../web/src/features/script/ScriptDirectorPanel.tsx)接显式“换模型继续”：仅可继续的未完成任务、源/合同/旧runtime精确可证、目标启用时迁移完整draft白名单；旧源/模型历史独立保存，排除stream/工具修补/response ID/签名推理。新模型失败精确保留原request/key且原模型可继续，损坏payload409、同模型选择明确拒绝。历史键序只经完整旧identity hash证明后一次重绑完整步骤输入。 |
| F04 图片/视频/语音阶段恢复 | 保留、实施外围 | 保留已有未知POST不重发、已有task ID只查、已有URL只下载和语音单次付费/完成帧校验。外围增加trace、取消等待与用量归属；不自动重提交，不把abort本地HTTP冒充厂商停止计费。 |

## G. 观测、界面与验证（4项）

| 编号 | 当前状态 | 落地证据与边界 |
| --- | --- | --- |
| G01 每适配器请求追踪 | 实施 | [model-request-observation.ts](../../backend/src/modules/generation/model-request-observation.ts)持久任务/attempt并过滤敏感字段；各文本协议、原生分析、计数、jobs及语音接入实际派发和最终metrics，后台Responses保留accepted身份与查询关联；辅助请求在body EOF/error/cancel时结算，并捕获原scope避免跨任务串账。kind/transport_kind保留以区分派发、查询与下载。默认不存完整原稿/密钥/Base64。 |
| G02 跨任务用量 | 实施、保留 | 请求scope累加各准备、重试、结构修正、接续的真实usage；unknown与估算分开，新增[ModelTaskProgress.tsx](../../web/src/features/jobs/ModelTaskProgress.tsx)展示实际请求与不确定用量。媒体保留自己的计量，原生图片分析不记为生图一次；输出cap不变成任务累计硬上限。 |
| G03 业务进度与恢复UI | 实施、产品边界 | 剧本执行/恢复和已保留草稿投影保留；[ModelTaskProgress.tsx](../../web/src/features/jobs/ModelTaskProgress.tsx)常驻展示跨入口真实attempt、用量、取消和单元进度。stage blocks、分页及通用units报告真实已完成数，剩余未知明确为null，不编造总量。业务继续仍在各原功能，账本不制造统一“继续”按钮；取消/中断与正式保存明确区分。 |
| G04 协议故障与业务结果链 | 实施、离线限定 | 新增跨协议policy/usage/trace、残参、断连、分页、source/model失效、队列取消、完整单元恢复与正式写入次数测试。下方分别记录定向与全量结果，不用定向通过替代全量通过。没有真实渠道调用，不声称所有第三方网关已经通过。 |

## 基线差异与不能混记的范围

原工作区研究包含了部分尚未进入main@26905a7的新增路径。该基线没有`backend/src/modules/storyboard/clip-storyboard.ts`与`backend/src/modules/canvas/video-audio-plan.ts`；本轮也未为了满足研究路径名整包搬入原工作区修改。与此同时，main中已经有speech与镜头/剪辑；web/src/features/script/script-canvas-handoff.ts是本地sessionStorage与画布导入，canvas-image-video-context.ts是本地提示词拼接，app中的image_video_handoff是设置schema。这些本地业务继续存在，但均不能据其名称当作AI交接模型入口；目标基线没有研究所指的新增后端AI交接模块。

新增audio_plan字段的生成→预览→创建→持久读取验收，只能在实际拥有该字段/入口的版本上完成。本轮基线的原有媒体/语音字段与语音路径应以自身合同验收，不能把另一个工作区的新字段需求算为本轮既有字段回归失败或已完成成果。

## 24 类入口的实际实施矩阵

这张表按研究入口族逐一核对本次main基线；共用基础只计作基础贯通，恢复方式仍由各业务合同决定。没有将两个基线外新增模块计为已实现。

| # | 入口族 | 本轮实现或保留方式 |
| --- | --- | --- |
| 1 | 短结构化、分类、授权、意图 | 任务策略/最终请求计划/取消/trace统一；保留原子小结果和权限校验，不加长文接续。 |
| 2 | 剧本阶段、人物、大纲、分集正文 | 主动完整blocks、元数据delta、持久断点、增量工作集；最终独立审读与业务总验保留。 |
| 3 | 来源导入、地图、质量与人物证据 | 完整来源身份保留；质量/故事长列表分页、密集短稿持久恢复，引用仍回到原文校验。 |
| 4 | 剧本审读、引文与问题归组 | 完整问题分页持久、覆盖与引文校验；失败只续未完成任务。 |
| 5 | 候选修复、决定与精确编辑 | 原生submit_repair_batch与兼容decisions/edits分页；8→4→2→1、决定不可改写、最终统一提交。 |
| 6 | 导演原生工具循环 | 大结果版本读取、独立只读最多3并行、失败/写屏障、安全历史压缩、真实减量后overflow恢复；残参不执行。 |
| 7 | 场次分镜及导演复核 | 长多场完整场单元持久，源/模型身份绑定；保留总时长、台词、场次校验与独立导演复核。 |
| 8 | 新增独立片段分镜 | 研究中的clip-storyboard模块不在main基线，未搬入；既有镜头/剪辑业务保留。 |
| 9 | 视觉档案、派生与用途 | 共享目录/依赖拓扑/完整档案分单元恢复，源变化与最终用途/预算校验保留。 |
| 10 | 精炼、拒绝后优化、素材提示词 | 长提示词精确分页补丁，candidate与review分step；短请求保留原子输出，模型/渠道缓存身份与取消贯通。 |
| 11 | 技能及参考选择 | 真实模型/渠道reuseKey、目录白名单和按需正文；用户固定规则及权限保留。 |
| 12 | 画布单节点建议 | 原子结果、请求策略/取消/trace，来源指纹和参数校验保留。 |
| 13 | 剧本到画布准备 | 设计组持久与来源身份，保留完成组至commit；取消不继续派发，正式创建保留原幂等/事务。 |
| 14 | 图片理解/反推与原生Gemini | 共用请求外围；原生分析用实际TEXT remote_id，usage/停止原因/取消/渠道背压贯通，仍保留图片证据约束。 |
| 15 | 视频反推/理解 | 长视频真实切镜地图→逐镜分析持久；不将抽帧或未知音频描述为完整视频证据。 |
| 16 | 成片/素材复核 | 完整报告页持久接续、has_more与来源版本总验；独立历史和正式保存语义保留。 |
| 17 | 新增后端AI音画交接 | 研究中的video-audio-plan模块不在main；本地handoff/提示词拼接保持本地行为，现有speech不因此算缺失。 |
| 18 | 通用文本jobs | 非流式三协议实际计划/能力/错误/用量/trace贯通；原子.txt结果保留，未知交付不冒充可精确恢复。 |
| 19 | 付费图片/视频jobs | 保留未知提交不重发、已有ID只查询、已有URL只下载；增加外围追踪与取消等待，不擅自停止厂商计费。 |
| 20 | 语音合成 | 保留单条持久任务/take、单次付费与完成帧校验；补实际请求及用量归属。 |
| 21 | 旧全文剧本/产物API | 完整文档→独立文档→完整语义段/场次恢复，完整配置身份与源变更检查；成功清理，显式restart。 |
| 22 | 旧shot_plan API | 多场逐场持久、完整模型身份、最终source signature复查；成功清理，原时长/台词/创建校验保留。 |
| 23 | 文字连续性检查 | 相邻镜头对分组≤4持久、完整模型身份、最终源复查与成功清理；去除200KB聚合总限，不冒充画面复核。 |
| 24 | 模型目录、表单、自定义接口 | 标准Mantine配置三协议、目录/能力/容量/输出/思考；TTL/ETag/合并刷新/草稿隔离；最终wire参数可追溯。 |

## 已确认验证

以下定向测试彼此有重叠，不相加作为用例总数；全量数字单独记录。所有模型请求由离线夹具响应，数据库均为临时SQLite。

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| 架构/UI约束检查 npm run check | 通过 | `/private/tmp/model-integration-check-final.tap` |
| 工具链测试 | 3/3通过 | `/private/tmp/model-integration-tooling-final.tap` |
| 后端全量 | 2422/2422通过，0失败/跳过 | `/private/tmp/model-integration-backend-final2.tap` |
| Web全量 | 1346/1346通过，0失败/跳过 | `/private/tmp/model-integration-web-final3.tap` |
| 完整生产构建 npm run build | 通过：架构/UI约束、共享包、后端、Web | `/private/tmp/model-integration-build-final.tap` |
| git diff --check | 通过 | 最终源码/测试/文档差异核查 |

关键定向证据：

- 剧本生成、审读、修补、来源质量/故事列表、元数据修正、主动blocks、显式迁移：24文件 **454/454**（`/private/tmp/script-optimization-final.log`）；密集短稿整份截断→持久任务→断连→仅续剩余项 **50/50**（`/private/tmp/script-short-source-final.log`）。
- 可信来源工作集、精确读取/残参拒绝、真实app派发缩小、全文全局审读、显式换模型、损坏store与restart：15文件 **203/203**（`/private/tmp/script-stage-final.log`）；迁移端点6文件 **26/26**（`/private/tmp/director-switch-final2.log`）。
- Provider/channel/API **266/266**（`/private/tmp/provider-channel-regression.tap`）；独立复核 **81/81**（`/private/tmp/provider-review-final.tap`），包含推理能力绕过、辅助响应体完整结算及后台取消读取。
- Feature长文恢复 **36/36**、长提示词精确编辑 **72/72**；工具读失败屏障及关联业务 **109/109**（`/private/tmp/feature-final-review-regression.tap`）。
- 根集成 **120/120**、配置/进度/活跃资源 **10/10**、旧分镜/连续性 **14/14**、Web任务记录/进度 **19/19** 定向通过。损坏数据不静默丢弃，源/模型身份不混用，正式写入合同保留。
- 最终全量发现并修正过时fixture：超时测试改为分别推进headers 2分钟与body/总期限5分钟，并证明有效事件不能延长工具会话总期限；相关四文件 **66/66**（`/private/tmp/provider-director-deadline-final.tap`）。旧断点/跨transport完整成果复用/legacy格式fixture三文件 **25/25**（`/private/tmp/model-integration-script-final-fixtures.tap`）。这些改动没有放宽生产校验。Web偶发断言另确认为首次画布居中触发视角PATCH，测试初始化已有视角并等待800ms后仍严格验证无模型生成/正式保存；整文件 **5/5**（`/private/tmp/app-canvas-refresh-final.tap`）。
- 最后定向TypeScript检查均通过；完整生产构建同时覆盖共享包、后端与Web编译。工程成功不代表第三方网关兼容验证。Vite仍提示主包体积超过500kB，本轮未把前端分包重构混入模型接入任务。

实际页面验证：已用临时服务与隔离SQLite渲染标准模型配置和任务详情。可见“已保留2个完整单元，剩余3个”、40%进度、真实450/1800 token及65,536单次请求输出额度；剩余未知按未知显示，不伪造总数。截图为`/private/tmp/studio-provider-configuration.png`、`/private/tmp/studio-model-task-detail.png`、`/private/tmp/studio-unit-progress-final.png`。这是离线页面验证，没有付费模型生成。

临时backend/Vite已停止，18089/18988无监听；两个临时预览SQLite目录已移除，未停止其他服务。

## 能力边界与基线外范围

- B02已在可安全压缩的工具会话形成“确认context overflow→证明请求变小→受控再派发”闭环；不可缩减输入停止。固定授权/不可外置规则自身可能超出输入容量，不能无变化重试。
- C01/C02可检索阶段工作集已完成，但最终独立全局审读仍需要完整原稿容量，不能承诺任意长稿/任意小窗口。
- E01只有明确可拆分合同的repair自动缩小；普通写工具保留残参不执行和安全停止，不把半截参数续接后执行。
- D02/F01研究引用而未进入main的新增clip/后端AI交接/audio_plan，在拥有相应模块的版本另行移植验收。原有镜头、剪辑与语音业务继续按自身合同工作。
- 渠道背压为本地单进程，不提供分布式RPM/TPM保证；真实厂商容量/兼容/费用/缓存收益及付费链路行为未实测。没有自动切换模型或渠道，也没有增加任务累计token/请求数/总运行时硬限。
