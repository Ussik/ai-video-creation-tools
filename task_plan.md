# AI Video Studio MVP

> 历史计划：主要记录 2026-09-28 至 2026-10-04 的开发阶段；下文的 “Current task”、待办和验证仅适用于当时。2026-10-22 已按代码基线 `9ba5a25` 另行整理 [当前状态](docs/current-status.md) 与 [文档索引](docs/README.md)，本文件保留原始计划，不作为当前待办清单。

## Goal
Build a local-first personal AI video tool with projects, shot planning, configurable text/image/video providers, generation history and selection, and simple video export.

## Phases
- [x] Inspect repository and runtime
- [x] Recheck Ark text/image/video docs and product requirements
- [x] Build backend data model, provider adapters, jobs, media, and render API
- [x] Build frontend creation workflow and settings
- [x] Install dependencies and verify API, export, and responsive UI
- [x] Document setup and known limits
- [x] Liblib-style canvas information architecture and creator menu
- [x] Liblib-style workflow/storyboard views with canvas navigator and asset rail
- [x] Editable script nodes with project script synchronization
- [x] Canvas productivity: undo/redo, duplicate, batch candidate actions
- [x] Script → shot → generator group workflow
- [x] 成熟项目风格剧本工作区（支持可配置创作设置）
- [ ] Timeline transitions and finishing polish
- [ ] 收拢独立分场剧本编辑器，改为导演对话 + 故事板局部编辑

## Current task: close the director-chat to project-script loop

Goal: 对照成熟项目，把多轮剧本对话确认后的结构化创作文本安全落到项目剧本、画布剧本节点和后续资产任务。

Phases:
- [x] 用 Ego Lite 对照成熟项目的结构化问答、阶段进度、创作文本保存和项目文档节点
- [x] 扩展剧本草稿为完整项目文档产物，并把已有项目设定带入生成上下文
- [x] 增加剧本、场次、产物的一次性事务提交接口
- [x] 前端预览编辑、确认写入、产物展示和资产任务读取接入完整草稿
- [x] 增加原子提交回归测试并通过前后端构建
- [ ] 在允许监听端口的环境中完成本地 Ego Lite 端到端点击验收

## Decisions
- Empty repository. Use a TypeScript-only application: React/Vite frontend and Node/Fastify/Zod backend. Ark exposes HTTP APIs, so its Python SDK is optional; sharing TypeScript types and one runtime is more practical for this personal tool.
- Provider connections and model protocols/templates are user-configurable. Ark is only an editable seed configuration. Compatible text, image and asynchronous video APIs can be added without changing server code.
- Local images can be represented as data URI references. Some video APIs require a public URL or provider-specific asset URI for references; local video files are usable in the timeline/export, but AI video editing from a local file needs object storage or a provider upload flow.
- No system FFmpeg or Redis. Use a bundled FFmpeg dependency and a SQLite-backed single-process worker for this single-user MVP.
- Never send an API key to the frontend after creation; provider calls run on the backend.

## Errors Encountered
- `ffmpeg` and `redis-server` were not installed. The implementation will not depend on either system binary.

## Current scope
- Keep the existing project, script, assets, jobs, model settings, review, timeline and export routes working.
- Prioritize creator-first interaction and workflow structure; provider calls remain configurable and no demo models are added.

## Current task: remove standalone scene-form workflow

Goal: 保留 scenes/shots 数据与生成能力，移除用户主流程中的大块“分场剧本”表单，避免与成熟项目风格的导演对话和画布故事板重复。

Phases:
- [x] Locate all ScriptEditor entry points and dependent persistence/API code
- [x] Replace primary entry with director/storyboard flow while preserving compatibility
- [x] Remove obsolete standalone scene-form presentation and stale navigation labels
- [x] Build and run targeted frontend checks

Decision: 先隐藏/移除界面入口和重复表单，不删除后端 scenes 数据结构；已有项目仍可读取、保存和生成镜头。
