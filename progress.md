# Progress

> 历史进度：下文保留 2026-09-28 至 2026-10-04 的原始过程和当时的验证结果；“尚未支持”、运行端口、工具会话编号及旧测试数字不代表当前状态。2026-10-22 的实现和已知失败统一见 [当前状态](docs/current-status.md)，后续阅读入口见 [文档索引](docs/README.md)。

- 2026-10-01: 剧本生成改为由文本模型根据剧情信息量、动作复杂度、对白长度和情绪停顿自主判断总时长。导演面板和沉浸式剧本编辑器移除固定总时长输入；每场时长仍由模型生成并可在编辑器中手动调整。后端保留可选 `target_duration` 兼容旧 API 调用，但新界面不再传入隐式目标。前后端构建通过。

- 2026-10-01: 参考 成熟项目 实际画布剧本卡片（640×350）：画布剧本节点改为标题居中、项目更新时间居中、空内容显示“暂无剧本内容”，右上角固定“编辑”按钮；移除“待创作/已保存、场数、秒数、开始创作”等左对齐内容。旧的 390×216 默认节点会在载入时升级，手动调整过的尺寸保留。前端构建通过。

- 2026-10-01: 将剧本创作流程调整为项目级剧本卡片、画布内入口、右侧多轮导演对话面板和沉浸式编辑器。导演对话使用已配置的文本模型，并携带项目、现有剧本和本轮讨论上下文；对话保存在浏览器本地，不会擅自改写项目。结构化剧本先预览，创作者确认后写入项目并保留已关联镜头的场次。旧剧本节点保留兼容但不再作为正式剧本数据。前后端构建通过；导演对话接口和画布迁移测试通过。与成熟项目仍有差距：当前采用单轮接口调用，没有其工具步骤编排、流式进度和服务端会话持久化；不模拟这些能力。

- 2026-10-01: 修复进入画布时的 422：画布节点已保存的图片参数 `clarity`、`quality`、`background` 未被后端严格 schema 接受，自动保存因此失败。后端补充三个提供商无关字段并加入画布回归测试；前后端构建通过。

- 2026-10-01: 将剧本从画布中的复制型“剧本节点”入口收拢为项目级剧本创作流程：画布顶部、菜单、空状态和右键入口均打开正式剧本编辑器，旧节点数据保留以兼容历史画布。剧本页新增可选的题材、题材融合、目标受众、时代背景、人物方向、核心看点、画风和叙事结构设定，设定随剧本保存，并与当前配置的文本模型共同生成可编辑提示词和草稿；剧本保存同时原子更新项目创意概述。后端脚本生成设定迁移、提示词预览/生成契约和测试已完成；前后端构建通过。未提交任何真实模型生成任务。

- 2026-10-01: 调整画布“图生图”入口：点击节点快捷操作不再立即复制出第二个生成节点，而是保持当前节点为目标，打开图片上传入口；上传图片后通过现有参考连接流程挂到当前节点，提示词继续在同一个创作区编辑并提交。图片参考仍走可编辑的素材节点和画布连线，支持移除和重新定位；同时识别图片模型配置中的 `image_references` 模板。前端构建通过。
- 2026-10-01: 调整画布“图生图”入口：点击节点快捷操作不再立即复制出第二个生成节点，而是保持当前节点为目标，打开图片上传入口；上传图片后通过现有参考连接流程挂到当前节点，提示词继续在同一个创作区编辑并提交。图片参考仍走可编辑的素材节点和画布连线，支持移除和重新定位。前端构建通过。

- 2026-10-01: 修复画布图片生成节点选择模型后创作区消失、模型未写入的问题。根因是 Mantine Select 的 portal 下拉实际使用 `.mantine-Select-dropdown`，文档级画布 pointerdown 监听未将其视为画布内控件，选项 onChange 执行前先清除了节点选中状态。已补充 `.mantine-Select-dropdown`、`[role="listbox"]` 和下拉 `data-canvas-overlay` 标记。Ego Lite 复现并验证：选择 `gpt-image-2.5` 后创作区保留，模型名称写入，开始生成按钮可用，提示词进入确认面板；未提交生成任务。前端构建通过。

- 2026-09-30: Replaced native browser confirmation and prompt dialogs with a shared Mantine graphite dialog (`AppDialog`). Canvas node removal and server-version discard now use styled danger confirmations; project creation/switch/delete, shot deletion, project rename, and script regeneration/planning confirmations use the same component. Rename supports Enter/Escape and validates empty names. Frontend production build passes.

- 2026-09-30: Compared 成熟项目 and the local existing canvas in Ego Lite (TaskSpace 34). Removed duplicate in-node generation forms and inert chips; made titles/empty previews draggable, preserved modifier multiselect, and stopped text selection from stealing editor focus. Added fixed-size composer viewport fitting, connected-reference controls, curved edges and a neutral bottom-left minimap. Verified cursor-position blank-canvas double-click, no add menu on node double-click, Cmd multiselect, dropdown dismissal, selection, pan following, and constant 720px composer width during zoom (68.6% to 137.3%). Fixed provenance edges being incorrectly forwarded as references when continuing from an older generated result. Latest frontend build passes; 24 targeted geometry/rich-text tests passed before the final reference filter correction. Existing services were not restarted and no paid generations were submitted. UI creation of an isolated QA project was rejected by automatic approval review as persistent data creation without explicit authorization; permission question remains pending, so creation, content autosave and new reference-link writes have not been browser-tested. TaskSpace 34 is preserved for continuation.

- 2026-09-30: Inspected 成熟项目的 text/video composition and mode/parameter popovers in Ego Lite. Rebuilt composition backplates from actual node bounds, aligned labels, removed double resize borders, enlarged prompt areas, replaced all 11 native canvas selects, and unified the existing application dropdown theme. Added configurable mode/parameter popovers with persisted candidate counts, model-bound duration and adaptive reference ratios; preserved portal focus. Frontend/backend builds and 10 canvas persistence/migration checks pass. Reference browser task finished; no local browser acceptance or service restarts performed.

- 2026-09-28: Inspected workspace and runtime; selected local-first architecture.
- 2026-09-28: User added Ark as primary provider. Reopened product research and verified Seedance 2.5 API task flow and parameter constraints.
- 2026-09-28: Verified Ark text, image, video and Files API shapes from official docs.
- 2026-09-28: Rechecked 成熟项目 and Xiaoyunque. Corrected Ark Files-vs-Seedance asset ID assumption. Research phase complete.
- 2026-09-28: User preferred Node. Switched backend implementation to TypeScript, Fastify, Zod and SQLite.
- 2026-09-28: Removed generated Python virtual environment and changed provider architecture to configurable HTTP templates with Ark as an editable preset.
- 2026-09-28: Node backend and React frontend built. Generic provider, async resume, render, and API workflow tests passed. Browser QA and final documentation underway.
- 2026-09-28: Backend test suite passed 4/4. Frontend and backend production builds passed. Browser QA covered desktop and 390px mobile views, provider/model configuration, demo generation, upload, candidate selection and MP4 download. QA data removed; local servers left running on ports 5173 and 8000.
- 2026-09-29: Compared the current canvas against Liblib's creation flow. Started a focused retrofit for creator-first menus, canvas productivity shortcuts, and script-to-generator grouping while preserving the existing workbench.
- 2026-09-30: Completed the first creator canvas retrofit: added Liblib-style script/shot/generator-group entry points, automatic shot group labels during import, manual group naming, group reorganization, prompt editing before failed-job retry, multi-candidate submission (1–4), undo/redo, and node duplication. Web/backend builds and canvas persistence/migration tests pass.
- 2026-09-30: Enlarged canvas nodes and minimum resize bounds for readable editing, added cursor-position context menus for blank canvas, nodes, and edges, and refreshed the canvas surface, cards, controls, and panels with a darker layered visual system. Web/backend builds and canvas tests pass.
- 2026-09-30: Added a 成熟项目风格 workflow/storyboard switch using the same graph data, a collapsible canvas/assets navigator with search, type filters, locate and node actions, and a bottom creator menu for script nodes, assets and generation history. Added editable script nodes (`settings.role: script`) with in-canvas outline, character, scene and duration editing that saves to the project script while preserving the full script editor. Removed the finishing workspace from the primary navigation and kept its timeline/export tools reachable as secondary preview/export actions. Web/backend builds pass; canvas persistence tests pass including script-node role retention.
- 2026-09-30: Refined the canvas idle state to match 成熟项目的 clean node presentation: unselected nodes show only title, dimensions and media/text preview; selecting a node reveals its prompt, model, generation actions and contextual editor. Image/video nodes use an inline floating prompt/model editor, while full properties remain available from the settings entry. Added video first/last-frame extraction for these actions, multi-select deletion, project-switch preview cleanup, and canvas-capacity handling for bulk asset insertion. Frontend build passes; ports 8000 and 5173 are closed.
- 2026-10-02: 开始收拢独立分场剧本编辑器。目标是保留 scenes/shots 数据和兼容保存逻辑，移除主流程中的重复表单，改用剧本导演与画布故事板承载创作和局部编辑。
- 2026-10-02: 完成收拢：移除 App 对独立 ScriptEditor 的渲染和导航状态；画布剧本卡片、画布菜单、无镜头状态和导演面板入口统一打开剧本导演；导演面板去掉“在编辑器中整理/编辑剧本”重复入口；移除内部 script 页面路由，保留后端 scenes 数据和画布分镜生成能力。前端构建通过。
- 2026-10-02: 在剧本导演中补充轻量“故事板制作”交接：展示未加入画布的场次数量，按场调用现有 `convert-to-shots` 接口创建初始镜头，刷新项目后回到画布继续生成；不恢复旧的场次表单。前端构建通过。
- 2026-10-02: 清理旧独立剧本页在 `workspace.css` 中的布局规则，统一内部入口命名为“剧本创作”；最终构建通过。
- 2026-10-02: 调整确认弹窗布局：警告图标与标题/提示内容放入同一行，图标位于提示开头，避免单独占据顶部空间；前端构建通过。
- 2026-10-02: 修复剧本创作侧栏初始状态底部大片空白：恢复侧栏纵向 flex 布局，让对话列表占用弹性空间、输入区固定在底部；前端构建通过。
- 2026-10-02: 修复展开“创作设定”后输入区被底部裁切且无法滚动：剧本侧栏改为自身纵向滚动，输入区在内容超出时保持可见并可随侧栏上下查看；前端构建通过。
- 2026-10-02: 统一画布与资产侧栏的 成熟项目 石墨灰配色：降低工作流切换、工具栏、筛选按钮、节点选中态和导演快捷回复的蓝色饱和度，改用低对比灰阶与蓝灰状态色，保留选中和焦点的可识别性；未重启现有端口，前端构建通过。
- 2026-10-02: 将画布左下角节点列表按钮同步为石墨灰样式，移除蓝色背景，悬停和展开状态与底部工具栏保持一致；前端构建通过。
- 2026-10-02: 将项目页“开始创作”空白卡片的默认和悬停底色改为中性石墨灰，移除蓝绿色大面积填充并保留清晰边框；前端构建通过。
- 2026-10-02: 画布左上角项目名称改为内联编辑：点击文字进入输入，回车或失焦保存，Esc 取消；复用项目更新接口并刷新项目列表、画布和剧本导演上下文；前端构建通过。
- 2026-10-02: 模型选择下拉统一只显示模型名称，移除文本模型和旧分镜工作流中的提供商后缀；提供商仍保留在模型设置和任务确认信息中；前端构建通过。
- 2026-10-02: 重做剧本导演对话中的助手头像和快捷回复：头像改为低对比圆形标记，快捷回复改为轻量灰阶操作按钮，减少蓝绿色块状视觉干扰；前端构建通过。
## 2026-10-02

- 将剧本导演对话中模型返回的 A/B/C/D（同时兼容数字编号）选项识别为结构化选择卡。
- 选项按独立行排列，使用统一编号、选中状态、问题分页提示以及“忽略 / 继续”操作，继续会把选中的完整内容发送回对话；“我有别的想法”等兜底选项保持低对比显示。
- 选择卡采用低饱和石墨灰样式，与当前画布和剧本面板保持一致。
- `web` 构建通过：`npm run build`。
- 移除剧本导演每条助手回复左侧重复的星光头像，保持正文和选择卡的阅读对齐。
- 将选项识别从任意字母/数字列表正则改为明确的 `kind: choices` JSON 回复协议；后端校验并规范化有效选项，同步与流式接口使用一致处理，普通散文列表保留为普通回复。新增导演接口测试覆盖结构化选项和普通文本回退。前后端构建及针对性测试通过；全量后端测试中涉及本地监听的 12 项被执行环境以 `listen EPERM` 拒绝。
- 修复混合回复导致选择卡未显示：模型先给自然语言说明、后附 `kind: choices` JSON 时，后端现在会提取并校验结构，将说明合并为卡片引言；流式输出检测到结构化选择后暂不把原始 JSON 显示为正文。导演消息区自动跟随新回复和流式文本，创作者向上查看旧消息时暂停跟随，重新发送时恢复。针对性后端测试与前后端构建通过。

- 2026-10-04: 对照 成熟项目 的“询问与回答 → 创作文本已保存 → 项目剧本文档”流程完善剧本生成闭环。剧本草稿新增可选的故事简述、背景设定、人物关系、场景设计、道具设计、全剧分段、钩子、伏笔、反转、创作禁区和分集文档；生成提示词会携带项目已有剧本、设定和产物，避免继续创作时丢失上下文。导演预览支持编辑完整产物和场次地点/动作/对白/时长，保存改用 `PUT /projects/:id/script/commit` 单事务提交剧本、场次和产物，并在对话中明确显示“创作文本已保存到项目”。资产任务在未保存草稿阶段也能读取当前生成的人物/道具资料。新增原子提交回归测试；前后端构建通过。全量后端测试仍有部分临时 HTTP 服务因执行环境 `listen EPERM` 无法启动。
