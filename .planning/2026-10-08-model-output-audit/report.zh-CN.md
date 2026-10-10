# 当前项目的模型交互机制审计

本报告基于当前工作区代码，覆盖剧本对话与编辑器、视觉设定、分镜、画布文本/图片/视频节点、Skill 提示词整理、连续性检查、候选审核、成片编辑，以及技能中心、模型设置和生成任务。此次只分析实现与设计边界，没有调用真实模型、改动用户项目或修改业务代码。上一轮超时调整已保留：连接无数据 3 分钟、单次文本请求 20 分钟、整轮对话 30 分钟。

## 一、三种机制的分工

| 机制 | 负责的事 | 在本项目中的例子 |
| --- | --- | --- |
| 提示词 | 定义专业角色、创作目标、事实约束、风格与评判标准 | 故事冲突、人物动机、对白、构图、动作、运镜、一致性 |
| 结构化输出 | 让固定任务返回可处理的数据形状 | 视觉档案数组、分镜方案、连续性问题列表、选项提取结果 |
| Function Calling | 让模型选择程序能力，读取新资料、发起交互或提交操作 | 读取人物设定、询问创作者、创建草稿、提出局部修改 |
| 程序/API | 执行事实与约束检查，存储、布局、提交任务和管理生命周期 | 阶段顺序、版本、比例参数、参考图 ID、任务队列、导出 |

提示词用于所有需要模型判断或创作的任务。结构化输出可以放置自由的 Markdown 正文；Function Calling 的参数也可以按 Schema 结构化。程序仍要检查文档是否存在、是否属于当前项目、版本是否匹配、当前动作是否允许，以及创作者是否明确要求执行。

“普通按钮调用了后端函数”与“模型发起 Function Calling”是两个层次。用户点击固定按钮时，程序通常已经知道目标和操作，可以直接调用 API；给同一动作增加模型选工具的回合，只有在需要模型主动查资料、规划多个步骤或接续对话时才有价值。

当前许多 JSON 任务采用“提示词要求 JSON → 从文本提取对象 → Zod 校验”。[structured-output.ts](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/structured-output.ts:9) 负责解析与本地校验。代码尚未统一注入每个任务的接口级 JSON Schema；用户配置的请求模板可能包含自己的输出设置。因此，本报告所说“加强结构化输出”，包含按实际提供商能力接入接口级约束，并保留现有业务校验。

## 二、剧本创作与文档

| 当前功能 | 当前机制 | 专业建议 | 程序应负责的边界 |
| --- | --- | --- | --- |
| 自由讨论故事方向、风格、主线、结局 | 主对话为提示词＋工具会话，最终解释可为普通文本 | 用提示词进行创作讨论；需要选择时调用 ask_creator，准备进入文档阶段时调用 propose_next_step | 不因一次讨论或接受一个设定直接写入整份文档 |
| 选择题、填写问题、确认、问题组 | 已有 ask_creator；历史回复还有识别链路 | 提示词＋Function Calling＋结构化参数。由模型决定问题，函数明确提交交互并等待回答 | 阶段、问题类型、选项 ID、已回答/跳过状态由程序校验和保存 |
| 记录已确认设定和“跳过后模型决定” | record_story_decision，可同步 settings_patch | 保持 Function Calling，参数结构化；专业提示词指导模型作出具体决定 | 来源必须是创作者消息；未经接受的建议和项目默认值不能成为确认事实 |
| 当前创作进度和下一步入口 | get_creation_state、propose_next_step；已保存进度校验 | 提示词判断是否准备充分，Function Calling 提议下一步，程序决定是否有效 | 大纲→人物与关系→场景→道具→分集正文；保存后推进，明确跳转单独处理 |
| 搜索文档、读取长文、查找关联内容 | 已有 read/search/related 工具 | Function Calling 适合按需检索；结构化返回正文片段、来源、版本和分页信息 | 真实读取、范围、版本和引用来源由程序提供 |
| 已有文档专业评审 | 文档工具读取原文，模型输出解释 | 保持“读取工具＋专业提示词＋自然语言评判”。需要问题卡片或评审列表时再加结构化 findings | 评审与修订操作分开；不把建议直接保存成事实 |
| 分阶段创建大纲、人物、场景、道具和分集草稿 | create_document_draft，阶段与产物 Schema，本地草稿存储 | 提示词＋Function Calling＋结构化参数；正文仍可为 Markdown，分集附结构化场次 | 不覆盖已有文档，不越过目标阶段或集数，供预览后确认保存 |
| 补齐待定人物、修改设定、同步场次 | propose_document_patch，原文片段/版本和 scene_changes | 提示词判断内容，Function Calling 提交结构化局部修改；保留原文和修改理由 | 修改前读取目标版本，片段唯一定位，限定文档范围并保留场次/分镜 ID |
| 继续修改、编辑、放弃草稿与保存 | manage_document_draft、commit_document_draft；明确 UI 操作也直接调用 API | 对话操作使用函数；明确按钮与编辑器保存继续直接调用 API。保存语义判断可以返回结构化结果 | 已有草稿、当前版本、明确批准和原文未变化；批准事件不能由模型自行伪造 |
| 编辑器/专用入口一次生成完整剧本 | 固定 script/generate，提示词 JSON＋scriptDraft 校验 | 提示词＋结构化输出，返回 outline/characters/artifacts/scenes；编辑器的预览和保存继续由程序处理 | 不把完整生成响应直接当作已保存；保留已关联场次和后续人工编辑 |
| 独立生成一份指定文档 | artifacts/generate 返回正文，文档类型和默认标题由程序确定 | 固定单文档任务可使用提示词＋自由正文；若生成多个文档才需要明确的结构化列表。对话写入复用草稿工具 | 已知类型、对象 ID 和固定元数据由程序赋值；正文格式由阅读器处理 |
| 采纳已有回复作为分集正文、整理分场 | adopt_source 走旧版意图/工作流与 JSON 解析 | 固定整理任务用提示词＋结构化场次；需要接入对话草稿体系时可由草稿工具提交 | 明确原文与目标集；逐字保留正文，不把例子误作已完成分集，不重做其他集 |
| 旧对话的选项/填写/确认/正文识别 | replies/classify 第二次模型分析，JSON＋Zod | 固定识别任务适合结构化输出；保留历史兼容和有界补救，记录结果来源 | 不覆盖已确认的原生交互，不从旧正文复活过期生成按钮 |
| 自然语言意图、生成授权和保存批准核验 | 旧版 script-intent，以及 authorized/approved JSON 判断 | 提示词解释语义，结构化返回判断和目标；明确按钮已提供操作类型时直接使用该事件 | 草稿版本、项目范围、目标阶段、可执行动作和保存条件仍由程序判断 |
| 自定义题材匹配展示封面 | 精确目录名称直接映射；其他描述独立调用模型，返回分类与置信度 | 语义匹配使用提示词＋结构化输出，限定已有分类；精确匹配继续由程序处理，无需 Function Calling | 保留用户原始题材，不改变故事设置；低置信度或没有合适分类时不强行匹配 |

主要证据：[主对话工具](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/script-document-tools.ts:197)、[工具会话](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:925)、[旧版意图](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:988)、[完整生成](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:2543)、[历史回复识别](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:2180)、[题材封面匹配](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/script-theme-visuals.ts:14)。

## 三、人物、场景、道具与参考图

| 当前功能 | 当前机制 | 专业建议 | 程序应负责的边界 |
| --- | --- | --- | --- |
| 旧版角色/场景/道具专项对话 | focus_artifact 不为 all 时走普通文本请求；提示词也包含 choices 等 JSON 格式要求；上下文预先截取 | 多轮查资料和确认设定适合专业提示词＋限定范围的读取/提问函数；固定整理输出用结构化草稿 | 能读取的资料必须实际提供；目标角色/地点/道具明确，避免仅靠截断摘要进行修改 |
| 专项对话确认后生成中英文生图提示词 | 整段 reply 被直接 setAssetPrompt，并保存到 asset-tasks.prompt | 固定输出适合结构化 prompt_zh/prompt_en/notes，或只返回所选语言的实际提示词；对话可调用准备草稿函数 | 说明、问题、选项和实际提交文本区分明确；不将整段聊天响应当作最终生图输入 |
| 从选定场次整理视觉设定档案 | visual-profiles/analyze 返回 profiles[]，另有保存 API | 提示词＋结构化输出最适合现有固定按钮；对话中读取和调整档案时再增加函数 | 场次 ID、对象类型、已有对象/服装版本匹配、保存范围和草稿确认 |
| 信息图提示词和多视角要求 | prepareBoard 根据档案、版本、参考图和用户补充拼接提示词 | 程序模板＋专业提示词；需要模型进一步优化时复用整理提示词任务 | 档案版本、参考图顺序与用途、实际参数保持一致；提示词编辑同步预览 |
| 人物之间的参考依赖、场次/镜头引用和视觉绑定 | 当前为引用选择和明确绑定 API，含项目范围与版本校验 | 已知关系由程序处理。让模型从剧情推断需要哪些档案时，返回结构化 ID/用途/理由；对话中提出绑定变化可用函数 | 真实存在的对象 ID、所选候选、必需引用、绑定影响范围；模型不能虚构已有图片 |
| 候选图浏览、归档、确认为设定图 | 候选管理器与明确 API，没有自动视觉评判 | 保持明确操作；未来对话选择候选可新增读取/选择函数。未来模型视觉评判需要实际图像输入＋结构化结果 | 候选属于当前设定，采用具体图片而非“最新结果”，版本与关联影响明确 |

主要证据：[专项提示词](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:847)、[整段回复转生图提示词](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/ScriptDirectorPanel.tsx:1919)、[视觉档案分析](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/visual-profiles.ts:187)、[信息图准备](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/visual-profiles.ts:60)、[候选管理](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/VisualCandidateManager.tsx:11)。

## 四、分镜、画布和实际生成

| 当前功能 | 当前机制 | 专业建议 | 程序应负责的边界 |
| --- | --- | --- | --- |
| AI 拆分分镜 | plan-shots 固定请求，结构为 scenes[].shots[]，含 image_prompt/video_prompt 与开收镜状态；保存另外提交 | 专业提示词＋结构化输出；对话自主读取场次、规划镜头、局部修改时再提供分镜草稿函数 | 所选场次 ID、镜头数量、场次总时长、请求版本、预览与幂等确认创建 |
| 按场创建一个初始分镜、导入画布 | 确定性转换和节点导入 | 程序/API 足够。自然语言指令可作为未来工具入口，但转换与排布仍由程序执行 | 不重复导入、不覆盖已有节点，不改变源场次关联 |
| 分镜图片接到新/已有视频节点 | canvas-shot-workflow 根据图、镜头、模型和模式建立首帧关联并带入 video_prompt | 当前操作由程序处理。未来对话可调用“为这个镜头准备视频节点”函数 | 固定图片 ID、参考顺序、同一镜头关系、目标节点复用、独立视频动作/运镜提示词 |
| 画布通用文本生成节点 | 通用 generate 任务，输出文本素材 | 普通写作适合提示词＋自由文本。只有需要输出可拆解的数据时才选择特定 Schema | 节点结果与任务绑定、编辑和保存，不把普通文本自动识别为文档操作命令 |
| 信息图/分镜/通用图片生成 | 图片提示词＋真实 API 参数与参考媒体，提交任务 | 专业提示词描述画面；程序传递模型、比例/尺寸、数量、参考图。未来对话自主提交可新增生成函数 | 图片模式、参考图属于项目、真实比例参数、数量和幂等提交；不能用文字要求替代 API 参数 |
| 视频生成，包括首帧/首尾帧/参考/编辑/延长 | 视频提示词＋模式/时长/分辨率/参考媒体参数，异步任务 | 专业提示词描述动作、连续性和运镜；程序处理生成模式与参数。未来对话可提供经过核验的提交函数 | 参考图顺序、首尾帧、时长、声音开关、外部任务 ID、查询下载和失败恢复 |
| 用 Skill 整理图片/视频提示词 | 固定 refine-prompt 返回 {prompt}，前端可编辑后应用 | 提示词＋结构化输出适合固定按钮。只返回一段文本时自由文本也可；需要模型主动查档案/选择规则时才增加读取函数 | 界面选定的比例、时长、模式和参考顺序由程序保留；应用前检查输入是否已变化 |
| 自动参考连线、缺图定位、拖动、节点布局和提示词草稿合并 | 画布图结构和对应算法 | 当前应保持程序逻辑。未来自然语言操作通过限定目标的画布工具执行 | 节点/边 ID、画布版本、拖动与点击分离、防重叠、固定参考、局部编辑与合并 |

分镜规划属于创作数据；图片提示词和视频提示词属于两个不同用途的内容字段。结构化镜头数据应同时保留两者，图片→视频的程序衔接再带入对应字段和实际首帧。

主要证据：[分镜规划](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:2327)、[图片转视频](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/canvas-shot-workflow.ts:26)、[生成参数校验](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:1303)、[生成任务提交](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:2950)、[Skill 整理提示词](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/skill-routes.ts:62)、[自动连线](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/canvas-visual-profiles.ts:40)。

## 五、质量检查与成片编辑

| 当前功能 | 当前机制 | 专业建议 | 程序应负责的边界 |
| --- | --- | --- | --- |
| 镜头连续性检查 | 既有规则校验＋模型分析相邻镜头文字状态，返回 issues[] | 程序检查确定性错误，提示词进行语义评判，结构化输出风险报告。对话追查原因时可组合读取工具 | 相邻镜头 ID、制作范围、资料签名与结果版本；模型输出不能自动判为真实画面穿帮 |
| 候选并排查看、视频首中尾帧、接镜审核 | 当前主要是实际媒体展示与人工评审 | 保留明确审核流程。未来自动视觉检查需要支持视觉输入的模型＋实际帧/图像＋结构化证据；按需取帧可由工具提供 | 确实提供被评估的画面、对应时间点和素材版本；采用和退回由明确操作决定 |
| 入出点、片段时长、音量、转场、制作范围与 MP4 导出 | 时间线/API/渲染程序 | 数学、时间和渲染由程序完成；未来自然语言剪辑可用函数生成可审阅的剪辑方案 | 时间单位、素材时长、剪辑范围、已选素材、导出执行状态与修改范围 |

当前 continuity/analyze 是文字语义检查；画面和视频审核尚不是自动视觉理解。增加实际视觉评判属于新增模型能力，需要验证输入协议，不能通过调整文字提示词获得这项能力。

主要证据：[文字连续性](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/continuity-semantics.ts:23)、[连续性入口](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:1676)、[候选比较](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/CandidateCompare.tsx:64)、[接镜审核](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/CutReviewPanel.tsx:43)、[渲染实现](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/render.ts)。

## 六、Skill、模型配置和运行基础

| 当前功能 | 当前机制 | 专业建议 | 程序应负责的边界 |
| --- | --- | --- | --- |
| 已启用 Skill 和参考文件加载 | 同环节启用规则拼入提示词，参考 Markdown 按关键词选择 | Skill 是提示词专业规则/资料。数量多时可提供 list_available_skills/read_skill_rules 等函数，按需读取相关规则 | 能用的 Skill、启用环节、文件来源、长度和输出契约由应用控制；读取规则不代表执行技能脚本 |
| Skill 搜索、GitHub 发现、安装、更新、启停和环节配置 | skills.sh/GitHub API、数据库和显式界面操作 | 当前使用普通 API。只有增加“对话搜索/管理 Skill”时才考虑对应函数；推荐理由可由模型输出结构化结果 | 来源、版本、路径、安装范围和启用配置；安装或解析 Markdown 本身不需要模型 |
| 模型目录、提供商认证、请求模板、模型/比例等能力配置 | API 查询、字段映射、本地配置和校验 | 保持程序配置；协议能力通过明确配置或实际探测确认。未来配置助手可生成结构化草案和提供受限函数 | 不能根据模型名称断言 tools、Schema、视觉或某比例支持；选定参数和敏感认证由程序处理 |
| 执行过程、用时、心跳、超时、取消、任务失败与恢复 | 服务端实际事件和任务状态 | 保持程序记录。模型可生成解释，但真实状态来自程序事件 | rules_loaded、函数调用成功/失败、实际保存、任务完成等不由模型文字决定 |
| 创作顺序、保存版本、跨文档影响和作用范围 | 工作流进度、草稿、原文/场次版本、明确操作条件 | 程序控制执行范围；提示词与模型负责创作判断和提出方案，结构化提议方便核验 | Schema 正确不代表阶段正确、授权充分或内容一致，仍要检查业务事实 |
| Markdown/富文本、文档导航、弹窗、按钮、比例菜单与水球样式 | 编辑器、渲染器与 UI 代码 | 保持应用实现；模型正文可保留 Markdown。格式兼容和视觉样式问题按 UI/数据格式修复 | `#` 是否呈现标题、导航高亮、窗口尺寸和节点空白由组件/布局处理 |

主要证据：[Skill 加载](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/skills.ts:244)、[技能搜索](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/skills.ts:143)、[模型目录](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/model-catalog.ts:104)、[原生工具传输](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/providers.ts:292)、[文本比例参数](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/canvas-model-parameters.ts:82)、[执行记录](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/script-activity.ts)。

## 七、已发现的具体问题与优先级

### 优先修正现有协议和交互

1. **阶段工具生成与旧版输出提示冲突。** [server.ts](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/server.ts:945) 要求调用 create_document_draft，随后拼接的 [workflowInstructions](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/script-workflow.ts:75) 要求只返回普通 JSON。内容要求与返回协议应分离；工具模式只按工具参数契约提交，固定结构化任务按结果 Schema 返回。代码冲突已确认，其在具体提供商上的失败概率未实测。
2. **漏调用提问函数的普通回复可能失去补救入口。** [前端结果接收](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/ScriptDirectorPanel.tsx:1683) 将缺失交互默认标为 other，后续识别跳过已分类消息。此前本地纯逻辑验证：同一段选项文字，未分类时有 1 个识别候选，标为 other 后为 0。应明确本轮结束状态（普通解释/待回答交互/下一步提议/待确认草稿），需要交互但遗漏时进行有限修正或兼容识别，并保留原生/推断的来源区别。
3. **专项视觉对话直接消费整段 reply。** [handleAssetConfirm](/Users/caoyanzu/workspace/ai-video-creation-tools/web/src/ScriptDirectorPanel.tsx:1919) 要求先中文再英文，却将 reply 整体保存并提交生图。应定义实际提示词、语言版本与展示说明的明确契约；已有设定和参考依赖也应使用统一档案来源。

### 建立统一的结构化任务能力

4. **统一结构化输出适配。** 为视觉档案、分镜方案、连续性报告、分类、意图/授权核验、提示词整理和完整剧本提供任务级 Schema 请求；保留局部业务校验、可诊断错误和有限修正。不同提供商的输出协议按实际能力接入，不改写用户配置中的其他请求字段。
5. **按能力使用严格函数参数。** 当前 [工具传输](/Users/caoyanzu/workspace/ai-video-creation-tools/backend/src/providers.ts:310) 使用 tool_choice:auto、strict:false，参数执行时已有 Zod 校验。启用接口严格模式需先转换兼容 Schema，并验证实际支持；不能机械对所有模型切换 strict:true。阶段感知的工具集和执行条件可以减少无关动作。
6. **长正文与结构化元数据配合。** 保留完整可编辑正文和稳定对象 ID，结构化场次、镜头、引用、版本及修改列表。不要为了结构化而把所有专业文档都压成短字段；也不要要求前端从普通段落猜测人物身份、场次归属或动作指令。

### 再扩展跨环节对话工具

7. **视觉档案与分镜的对话操作。** 候选能力包括读取视觉档案/参考状态、提出视觉档案草稿/绑定变更、读取分镜上下文、提交分镜草稿/局部修改。工具调用复用现有范围、版本、预览与确认保存逻辑。固定按钮继续直接完成已知任务。
8. **按需选择 Skill 与资料。** 大量规则可以先给目录，再让模型读取适用规则；继续尊重用户启用环节，执行过程记录实际加载文件。该能力可以与现有文档检索组合。
9. **需要对话生图/视频时再开放提交能力。** 参数由工具结构化传入，程序核验明确生成要求和参考资产，返回实际 job_id。当前通用 generate API 每次创建一个任务；包装为模型工具时应增加请求幂等标识与状态查询，避免同一动作的重复调用创建重复任务。异步查询、下载与恢复仍交给任务系统。

## 八、三种典型搭配

**“补齐林晚的人物设定”**：模型通过函数读取目标原文与版本 → 提示词指导专业判断 → 函数提交结构化局部修改 → 程序生成可编辑草稿 → 明确确认后保存。正文可为 Markdown，其他角色保持原文。

**“把这几场拆成分镜”**：固定按钮提供选定场次 → 专业分镜提示词＋结构化镜头结果 → 程序检查 ID/数量并分配时长 → 预览编辑 → 确认创建。若是在持续对话中需要主动寻找场次和参考档案，则前面加入读取工具，后面加入提交草稿工具。

**“用这个分镜图制作视频”**：程序固定图片/镜头关联 → 专业动作与运镜提示词＋实际首帧、时长和模式参数 → 生成任务 → 程序管理进度和结果。如果用户希望在对话中提出该操作，可以增加准备/提交函数，继续复用同一条任务链路。

## 九、审计范围与验证限制

已搜索后端所有模型调用、工具会话、Skill 注入与结构化解析入口，并对照主要前端调用路径；同时检查画布参数/参考管理、图片到视频衔接、候选审核、时间线、Skill 搜索和模型目录实现。此处“结构化输出”专指模型结果/参数的契约，不将普通 API 返回 JSON 或厂商图片/视频响应 JSON 算作模型的 Schema 输出。

本报告没有进行真实模型测试、厂商能力探测或自动视觉质量测试。现有工具已经接入，以及代码中的契约冲突和漏识别条件，是源代码可确认的事实；尚未验证的提供商能力、实际生成比例和模型在冲突提示下的行为，保留为后续验证项。
