# 片段内容使用分镜 Skills

## 用户要求

不经过剧本创作流程，也能为一小段视频使用分镜 Skills 规划镜头。用户直接输入片段内容和总时长，选择文本模型；沿用现有分镜环节的模型自动选技能和手动主/辅助技能机制。预览可修改、独立保存，然后选镜进入制作。

## 界面和行为

- 分镜管理「规划分镜」增加来源选择：片段内容、剧本场次；没有剧本场次时直接进入片段规划。
- 片段规划填写内容、总时长（1–120 秒）、可选建议镜头数（1–30）、导演要求，使用现有 CreativeSkillSelector 的 storyboard 环节。
- 自动模式省略 skill_ids，手动空数组明确使用基础规则。实际规划加载所选 Skills 正文，返回实际使用名称、版本和分配理由。
- 每镜 1–30 秒、总时长与用户设置一致；包括标题、叙事、图片首帧提示词、视频动作运镜提示词、起止状态、接镜说明。
- 独立保存创建片段方案与无场次关联的镜头，不创建 script_scenes、剧本正文、参考设定、画布、节点或媒体任务，不替换已有剧本方案。
- 片段方案记录自己的原始内容和时长；管理中显示为片段来源。显式加入画布时创建/复用该方案画布，只返回所选镜头，已删除画布不能静默恢复。
- 片段进入画布不要求剧本场次参考准备；现有手动参考图和视频生成仍沿用画布行为。
- 预览未保存、配置变化、关闭、晚响应、刷新失败和重复提交沿用现有保护。保留所有已有未提交编辑，不提交、不推送。

## 接口

- `GET /api/projects/:id/storyboard/clip/context`：只读项目/画风/技能目录配置签名、默认技能和 storyboard skill_policy。
- `POST .../plan`：`signature, source_text, total_duration, instructions, shots_count?, model_id, skill_ids?`，返回 `signature, shots, used_skills, skill_assignment`。返回签名绑定源内容、时长、导演要求和配置版本。
- `POST .../commit`：`request_id, signature, source_text, total_duration, instructions, shots`，返回 ScriptCanvasResult（scene_ids 空、target_canvas_id 空）；仅新方案保存，request_id 严格幂等。
- `POST .../canvas`：`design_id, shot_ids`，验证片段归属和可用状态，延迟创建/复用画布，返回同一结果结构。
- 共享类型新增 `storyboard/clip-storyboard.ts`；管理快照 designs 增加可选 `source_type: 'clip'`、`source_text`、`total_duration`。片段元信息存独立表 `storyboard_clip_plans`，不伪造剧本场次。

调研沿用此前 StudioBinder/Boords 的场次/镜头管理结构；本次重点为输入来源与真实技能执行，不扩展剪辑、协作或多模型批量生成功能。

## 实现与验证记录

- [x] 后端四个片段路由、独立来源表、真实技能加载、配置签名、独立保存与精确制作范围。
- [x] 片段规划器、自动/手动技能、可编辑多镜预览、保存与晚响应保护。
- [x] 管理来源选择、片段标记与原文详情、保存后选中方案、片段专用制作交接。
- [x] 最终源码后端 5 文件联合 98/98 通过；分镜管理 18 项、片段组件 13 项、管理/画布集成 7 项分项通过，最终前端 8 文件联合 145/145 通过。前后端最终日志分别为 `/tmp/clip-storyboard-backend-regression.log` 和 `/tmp/clip-storyboard-web-regression.log`。
- [x] 隔离 API 验收：自动选择、手动选技能、手动空选的上游正文差异；3 镜共 12 秒、无场次保存、幂等和只返回所选 1 镜。
- [x] 最终联合回归、类型/UI/架构检查、根目录 `npm run build` 与 diff 检查通过；仅有 Vite 大 chunk 提示。
- [x] 隔离浏览器验收：无剧本入口、自动/手动技能、首镜标题编辑、保存与重新进入、精确首镜制作、次镜复用保留首镜、第三镜未导入；390px/桌面与深浅色设置、预览、技能选择及关闭确认通过。
- [x] 技能与交接边界复核完成，3 份 JSON 与 4 张截图归档；专用浏览器空间及三个 QA 端口已关闭，用户原服务保留。

API 验收采用本地假上游，自动选择固定返回可用技能，生成固定返回 3 镜共 12 秒。技能 fixture 来自公开 `zenstory-ai/drama-skills` 的 `skills/short-drama-storyboard` 完整缓存包，固定 revision 为 `fdb7b7c58017e3eae64eca382c2a85ede368dab0`，仅安装到新 QA 数据库；不代表用户当前启用版本。日志已证实自动与手动选择时 4 条独特技能正文规则进入生成请求，手动空选时均未进入。该证据证明调用与注入契约，不证明真实模型的技能选择质量、规划质量或最终视频效果。

完整命令、日志、浏览器和 API 证据见 [片段 Skills 分镜验收记录](../acceptance/2026-11-04-clip-storyboard-skills/README.md)。手动空选由 API/组件测试覆盖，409 冲突由组件测试覆盖，不计为浏览器实测。实现保留未提交、未推送；真实模型质量未测。用户主后端未重启，新迁移与片段路由需其重启后生效。
