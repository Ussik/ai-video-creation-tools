# 共享模型调用与精确编辑增强

交付范围：直接 main；剧本仅为验收样本。优先解决完整回答丢失、反复付费、定位失败后整包重写和无进展循环。所有历史未提交改动保留，不提交、不推送、不换模型、不清历史。

## 本轮证据与原因

实际样本 `8009ed74-c4e8-4a8e-8722-b11591dbf1ae` 的四次响应都已完整结束，随后本地业务校验失败；不能归为本轮 unknown。旧代码只持久化校验通过的 child，失败参数与复数 diagnostics 在任务错误路径丢失，因此不能找回完整原响应或逐字证明当时 find 的误差。此次机制防止以后同类丢失，不会凭空修复旧历史。

LangGraph 负责步骤与恢复编排；定位协议、完整输出落盘、局部纠正、证据门禁和耗用持久化仍须在业务代码中明确实现。接入框架本身不能保证这些契约，也不能修复模型的语义判断。

## 实现与采用边界

| 要求 | 实现 | 边界 |
| --- | --- | --- |
| 完整返回先保存 | `model-output` 完整 raw 先存；`original_raw` 留真实原字节；纠正原文和 intent 独立保存；默认 generation steps 私有 response 记录；native 完整 turn 在解析前保存 | 私有留存不是正式采用；旧 canonical 不冒充找回原始 raw；完整回复只更新私有记录，按旧值校验后合并，不覆盖新任务的兄弟进度 |
| 不重复购买回答 | 精确 prompt/schema/父步骤输入绑定；重启本地复验 raw/correction；旧成功 child 精确旧 hash 复验复用 | 配置或资料改变是不同身份；无法证明等价的旧私有协议阻断迁移 |
| 冻结位置 | 版本绑定 paragraph/ref 注册表；重复原段不同 ID；真实 offsets 由程序保管 | 不模糊匹配，不信任模型 offsets，拒绝跨来源、过期、未读和 Unicode 断裂 |
| 仅纠正失败项 | domain planner 固定 edit_N/field_N/change_N；保留合法兄弟；冲突连通组固定原区间并集后合并 | 只为可证明定位的错误规划；未知全局错误不猜目标；不增加第三次隐式纠正 |
| 原生工具提案 | 稳定 operation_id、有效/失败提案、冲突组、纠正耗用和 request intent 私有保留 | 最终整包结构、已读、版本、冲突、业务门禁与原子采用保留 |
| unknown 暂停 | 未知请求/纠正 intent 重启仍阻断；不会借 fallback/split 换入口再发 | 仅可信 not_sent/rejected 可释放；已明确终止的初始失败保留原有有界恢复，纠正耗用不因此刷新 |
| 首轮可信证据 | 新审读仅选 source_key/source_ref/first_unit/last_unit；程序回填原文 | 仅证明证据位置，语义结论仍需独立审查；新协议不接受模型复制 quote |
| 事项真实进展 | 固定 issue 身份比较唯一真实证据；区分事项消失、证据变化与范围缩小 | 无关附注和审读措辞变化不能维持 continue；证据变化不等于问题已解决 |
| 上下文效率 | 首轮候选按完整编号 units 单次发送；局部纠正只含必要冻结块和要求；再审仅对程序可证明的重复 envelope 去重 | 作者自由文本要求可能跨文档；未证明依赖的 scoped 背景继续完整保留，不声称已实现自动依赖裁剪 |
| 最终质量 | 所有局部结果仍组装全包并检查；独立语义审查、最终全局核对和正式保存协议保留 | 离线测试证明机械契约，不能证明真实模型创作质量或所有模型成功率一致 |

## 入口覆盖

| 入口 | 状态 | 实际调用链与证据 | 处理及限制 |
| --- | --- | --- | --- |
| 普通文档读取与局部提案 | 已具备 / 本次增强 | script-document-tools.ts:466,1053,1065,1068,1211,1251 → buildDocumentReadPage → documentParagraphs / mergeRevisionRead；propose_document_patch → resolvePassageEdits → applyResolvedEdits | 已有版本绑定段落ID、精确唯一匹配、已读区间、过期和重叠拒绝。本次段落ID单独修改直接用冻结start/end；find不得切开代理对，replace不得含未配对代理字符。overlap diagnostic新增输入原始conflict_indices，方便仅纠正冲突组。 |
| 普通待确认草稿读取/继续修改 | 已具备 / 本次增强 | script-document-tools.ts:64-79；read附compact anchors，update用同一draftDocumentLocatorVersion公式 | 已有草稿read/version与作用域保护。本次以draft.version+doc.id+content绑定locator_version，只加id/start/end不重复text；整稿read与base_version协议保持。工具测试覆盖重复段落、crossdoc、stale、Unicode及不持久化只读metadata，已纳入最终组合回归。 |
| 场次与资源修改 | 已具备 / 不适用原因 | script-document-tools.ts:46-55,1255-1272,1300-1316,1331-1339 → scene_id/base_version/strict changes；resource → editResourceValues | 固定实体ID、字段白名单、版本读取和原子草稿；结构化字段修改无需段落协议。保留省略字段语义，不用带默认值的partial清空字段。 |
| 阶段artifact格式修复 | 已具备 / 不适用原因 | script-stage-continuation.ts:711 → repairStageArtifacts；script-stage-artifact-repair.ts:32,35,49-84 | artifact:index固定ID，精确覆盖，类型与removed_fields校验；模型只回元数据，正文程序原样组装；一次修复。没有正文编辑权限，段落协议不适用。 |
| 阶段block元数据修复 | 已具备 / 不适用原因 | script-stage-continuation.ts:565 → repairStageBlocks；script-stage-block-repair.ts:65,70,83-138 | block:index固定ID与顺序，禁止复用已收ID，原正文/场次保留，空结构逐项确认；单次尝试。只改ID/title/结构元数据，不允许正文回写。 |
| 阶段错位scenes格式修复 | 已具备 / 不适用原因 | script-stage-continuation.ts:627 → repairStageScenes；script-stage-scene-repair.ts:11-30 | 非episode阶段只确认discard_scenes:true及精确scene_count；原文档保留。不返回正文，属于结构确认。 |
| 分镜精确字段修复 | 已具备 / 本次增强 | storyboard-planning.ts:548/700 → completeStoryboardRepairScope → 571/715 repairStoryboardTargets(exactScope:true)；storyboard-targeted-repair.ts:61-187 | 已有scene_id+shot_index+field+精确证据+程序field_N。本次将合并后整镜头/场面校验放入wrapper；可归属字段失败用一次fixedLocalRepair只改失败key，合法同级值冻结，局部prompt不再携带完整原长prompt；最后再次合并校验。无字段路径或映射不明不猜权限，保留原一次完整补丁纠正。 |
| 短片旧版整镜头定向修复 | 已具备 / 不适用原因 | clip-storyboard.ts:206 → repairStoryboardTargets(exactScope=false)；storyboard-targeted-repair.ts:20-53 | 已有精确镜头覆盖、身份/时长/audio_plan锁定；业务validate原本就在wrapper内。授权的是完整镜头，无需段落定位。本次未声称此分支采用新局部key回调。 |
| 分镜修复权限scope审查 | 已具备 / 不适用原因 | storyboard-repair-scope-review.ts:19,36,54-63,101-110 → validateStoryboardRepairEvidence | scope_field_N固定字段、checked_fields完整唯一、问题归属及精确证据，不能获得未授权时长/场面权限。只产出权限/证据。仍是已有一次受限完整纠正，未新接局部回调。 |
| 提示词参考图身份编译 | 已具备 / 本次增强 | skill-routes.ts:298/426/470/521 → compileRefinementReferences → shared resolvePromptReferences；prompt-refinement-references.ts:12-26 | 已有资产身份与选中清单精确一致。本次先解析完整替换链，再用resolved.replacements最终身份校验，old→middle→replacement不再被一跳预检误拒。null、循环、未选中终点继续拒绝；不增加模型调用。 |
| 长提示词精确片段修改 | 已具备 / 本次增强 | skill-routes.ts:453 → generateExactPromptEdits → generatePagedReviewItems(validateItems) → applyExactPromptPatches；prompt-exact-edit.ts:14-97 | 已有source hash、paragraph hash、精确唯一find、不可变原稿坐标、重叠拒绝及逐页业务验证。本次find边界不能切开代理对；replace不能含未配对代理字符。完整emoji/空白保持。不跨domain引用script模块。 |
| 提示词语义证据定位 | 已具备 / 不适用原因 | prompt-refinement-semantics.ts → prompt-refinement-evidence.ts:9,15-24,59-85 | source/request/candidate分属source_key及unit ID，模型只选first_unit/last_unit，程序截取原文；完整ID覆盖、来源归属，unit不切代理对。只回填证据坐标不编辑正文。 |
| 剧本证据结论再审输入 | 本次增强 | script-draft-review-evidence.ts → reassessDraftReviewEvidence → 原始任务候选数组与完整units | 原来units完整候选与原始prompt候选重复。本次只对唯一逐字匹配的候选envelope做wire引用去重，所有单位正文、背景与元数据保留；未知/歧义格式不删除。原始cache/audit输入不改。再审及邻接缓存/恢复/布局测试已纳入最终组合回归。 |
| legacy repairLongScriptDraft | 未完成 / 非活跃入口 | script-long-repair.ts:14，backend/src仅export声明，无实际调用 | 初始quote定位indexOf无唯一性检查；后续编辑有coordinate evidence。未改不可达旧入口，不能当作此次真实失败根因。若重新启用须接frozen registry。 |
| legacy replacePassages | 不适用当前生产链 | script-document-tools.ts:169，仅声明；现存测试调用，活跃工具使用resolvePassageEdits | 未改旧helper；不能声称自动覆盖新的Unicode规则。重新启用前应统一resolver。 |

## 存储与恢复的并发边界

默认 response 记录及显式修订提案/原生操作账本使用精确私有记录合并。事务读取同任务最新快照，比较上次读取的旧值，拒绝旧执行覆盖新 raw 或纠正耗用；普通业务保存保留最新私有记录。任务身份已切换时，迟到结果归回原身份历史，不重新激活旧任务。

source 分析的嵌套检查点保留原有 owner：每次失败/暂停续接创建新 analysis.id，旧 persist 校验当前 id/source_version；proposal 先检查 abort。完整上游回答另由原 source recovery ledger 留存。不能把独立库调用自行复用旧 state 的测试假设说成生产入口已允许并发同 owner。

## 历史、配置与实际运行

- 七个成功候选 child / 60 条 edits 必须保持原 hash 和内容，原稿不变。没有正式 artifacts/scenes 写入。
- 本轮实现与回归不发真实付费模型请求。unknown 人工恢复额度已用完，不能以本次补丁为恢复授权。
- 固定现有模型配置，不替用户选择或切换模型。不删除 Langfuse、浏览器、候选、检查点或历史未知请求。
- `script-source-analysis.resetSourceRepairs` 原有显式恢复会重置 story/map 的纠正状态；已有 source 请求 ledger 仍管理其恢复权限。不能声称用户显式授权永不重置额度。
- 已有必要交付/可选建议区分与 task acceptance 范围继续使用，不将它们写成本轮新功能。

## 验证记录

- 最终组合镜像：76 个测试文件，1,092 项通过，0 失败、取消或跳过，约 31 秒。
- 镜像后端 `tsc --noEmit` 通过；根 `npm run check` 的架构和 UI 检查通过。
- main 已应用相同源码；实际主工作区的 6 个存储/恢复/API 测试文件共 74 项全部通过，后端类型、根架构/UI及 `git diff --check` 均通过。8000 与 8888 的 `/api/health` 均返回 `{ok:true}`。未提交或推送。
- 独立只读审查未发现冻结定位、固定局部纠正或旧协议迁移的新增阻断。显式提案及原生账本的并发保存漏洞已修复并纳入组合测试。
- 真实业务库以只读事务核对：当前无本地在途；历史 unknown 原样保留，不代表上游已终止。原稿、固定模型配置和修订 payload 哈希保持，七份成功 child / 60 条 edits 保留，正式 artifacts/scenes 仍为 0。

本轮没有真实付费模型请求。测试只用合成生成器及临时数据库，真实业务库只读。未完成第一集正文的真实付费端到端验收，不能以离线通过宣称模型语义质量或跨模型成功率已证明。
