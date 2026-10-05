# Findings

- Workspace was empty and was not a Git repository at the start.
- Node 22.22.2 and Python 3.9.6 are present.
- System `ffmpeg` and `redis-server` are unavailable.
- Scope from the prior discussion: project/shot workflow, configurable text/image/video model access, candidate selection, simple timeline/export.
- Ark product overview uses official `arkruntime` Python SDK and `https://ark.cn-beijing.volces.com/api/v3`; it also shows OpenAI SDK compatibility for Responses API.
- Seedance 2.5 model ID shown in docs: `doubao-seedance-2-5-260628`. Video creation is `POST /contents/generations/tasks`, followed by task polling and immediate result download.
- Seedance 2.5 supports text, first/last frame, image/video/audio references, edit, extend, and draft-to-final. Output is 4-30 seconds or adaptive; 480p, 720p, 1080p; several aspect ratios. Edit requires adaptive ratio and duration -1; first/last frame requires adaptive ratio.
- Ark says video task records last 7 days and result URLs last 24 hours. A local app must retain task IDs and download completed media promptly.
- Node/TypeScript was selected after reviewing Ark's HTTP APIs and the user's preference for one language across frontend and backend. System FFmpeg and Redis remain unnecessary for this local first version.
- Ark text docs: `POST /chat/completions` or `POST /responses`; Responses is recommended for new work. First version only needs single-turn script/shot assistance.
- Ark Seedream 5.0 pro/flash IDs shown: `doubao-seedream-5-0-pro-260628`, `doubao-seedream-5-0-flash-260915`. Image endpoint is `POST /images/generations`; input image can be URL or data URI; output data URLs expire after 24 hours.
- Ark Files API: `POST /files` multipart (`purpose=user_data`, `file`) uploads local media and returns a file ID, but Seedance video reference `content.video_url.url` specifically accepts a public URL or an `asset://` ID from Ark's preset asset library. A Files API `file-...` ID is not documented as interchangeable. Local video references therefore require a public media URL or later object-storage integration.
- Ark video task API: `POST /contents/generations/tasks` returns an `id`; poll GET on the same path with ID. Success returns `content.video_url`, status `succeeded`; failures return `error`. Seedance 2.5 has draft mode, but final-from-draft has strict parameter rules and 7-day draft ID validity.
- Rechecked 成熟项目: project/asset organization, canvas workflow and storyboard, director assistant, image/video nodes, generation history, character styling, and postprocessing affordances. Rechecked Xiaoyunque: Agent entry, model-mode-duration-ratio-resolution picker, script/drama entry, draft model, and multitrack editing observed previously.
- Current Liblib-style gaps: the bottom dock lacks script/shot/asset-group actions; generator nodes have no duplicate/version branch/undo-redo; scripts import as individual shot nodes but not as a generator group; candidates submit one at a time; failed tasks cannot edit and retry their prompt in place; results require separate selection and timeline steps.

- 2026-10-02: 用户指出当前独立“分场剧本”页面（场次列表 + 地点/时间/时长/动作/对白/旁白表单）与成熟项目的导演对话、故事板交互重复。初步建议：保留 scenes 数据供镜头规划和生成使用，移除该表单作为主入口，改由导演对话生成、故事板卡片展示，必要时在卡片详情中局部编辑。
- 2026-10-04: Ego Lite 对照成熟项目确认剧本对话的落地模型是结构化问答、阶段进度、创作文本保存和可引用项目文档，而不是把聊天消息直接当作剧本。成熟项目的文档至少覆盖故事大纲、故事简述、背景设定、全剧分段、钩子、伏笔、反转和创作禁区，并可在画布剧本节点中切换查看。当前项目已补齐同类 artifacts、生成上下文、完整预览编辑和 `/script/commit` 原子保存；之后资产任务可以引用已确认的剧本产物和场次。
