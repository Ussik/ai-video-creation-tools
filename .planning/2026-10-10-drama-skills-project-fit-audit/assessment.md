# Drama Skills 项目适配评估

检查日期：2026-10-10。来源版本：c2426e03c0e7722bebcc6a488b6658dc38c65ac3。仅评估，未安装或更改技能配置。

## 结论

优先新增 short-drama-develop 和 short-drama-review。小说改编需求明确时再接入 short-drama-novel-analyze。既有五个核心技能已安装、已启用，且与 main 当前版本相同，无需重复安装或更新。

## 已有核心能力

| 技能 | 已绑定环节 | 价值 |
|---|---|---|
| short-drama-write | 剧本创作 | 可拍摄的因果、行动、对白与作者风格保留 |
| short-drama-assets | 视觉设定 | 身份、造型/状态变体、跨镜连续性锁 |
| short-drama-image-prompts | 图片提示词 | 角色板/场景板/道具板、明确参考控制范围 |
| short-drama-storyboard | 分镜规划 | 镜头职责、起止动作、空间/持物/视线连续性、冻结关键帧 |
| short-drama-video-prompts | 视频提示词 | 起点→动作→终点、表演时序、声音边界和模型方言 |

## 剩余六个技能

| 技能 | 建议 | 具体增强与限制 |
|---|---|---|
| short-drama-develop | 优先新增 | 机制不同的故事方向、系列冲突引擎、人物驱动力、铺垫兑现、每集进入/退出状态与跨集记忆。用于开发/大纲时选择；逐场写作仍沿用 write。长整稿索引脚本未接入。 |
| short-drama-review | 优先新增 | 以证据定位剧本、视觉设定、分镜和提示词间矛盾，检查提前揭示、左右手/持物、关键帧起终点、重复镜头和模板表达。增强已有评审的专业规则；不是已删除的手动素材通过/拒绝菜单。应按评审任务选择，不把它设为全部写作任务的默认主技能。真实媒体质量仍需媒体可读与视觉/音频分析能力。 |
| short-drama-novel-analyze | 改编小说时再加 | 章节索引、抽样快评、逐章功能提取、人物别名归并、改编价值与分集候选。现有导入器不执行 Python；长文索引、覆盖率、断点续跑不会因安装自动出现，需要新接入。 |
| short-drama-edit | 未来剪辑增强时接入 | 可用片段判定、入出点理由、字幕逐字取剧本、接镜/音效/配音/响度与成片检测。现有时间线和导出已有基础能力；本技能依赖独立剪辑单、Python/ffmpeg，部分画面文字还依赖 Remotion，需要桥接数据库/媒体/剪辑请求。 |
| short-drama-produce | 暂不安装到应用 | 独立生产工具与 adapter，提供图片、视频、TTS、音乐、生产预览确认和中断取回。应用已有模型/API/队列/任务恢复；不执行该技能脚本，也不因安装获得 TTS/音乐。可借鉴其接口设计。 |
| short-drama | 暂不安装到应用 | 文件项目初始化、五文档路由、Dashboard、项目级视觉开发/导出。应用已有数据库、导演对话、技能阶段、画布与项目管理；另建文件真源并不会增强现有项目，需要选择性映射而非引入第二套项目状态。 |

## 应用接入的实际边界

应用技能中心只绑定 script / visual_assets / image_prompt / storyboard / video_prompt 五个环节。文档规则被传入文本模型，外部脚本和 adapter 不会执行。

- develop 已能识别为 script；review 和 novel-analyze 没有自动建议环节，若只安装规则需手动绑定剧本创作，并在对应任务选择。
- develop/review 的细分参考资料需要扩展按任务选文档的逻辑：现有筛选器不覆盖 story-craft、episode-design、serial-character-and-memory、rubric-*、anti-template-repair 等名字。仅安装主文件不能视为全部专业参考已自动使用。
- 所有 11 个文本包均在当前安装器 48 文件、1 MB 的单技能限额内，文件数量不是阻碍。
- 安装不会产生新的自动剪辑/原著处理/配音按钮，不代表实际生成质量已经实测提升。

## 依据

- 当前数据：data/studio.db 只读查询 installed_skills；既有 5 个技能均 enabled=1，版本与远端一致。
- 应用实现：backend/src/skills.ts 的 suggestedSkillStages / loadSkillBundle / skillContext / relevantReference；已有评审见 backend/src/script-document-review.ts。
- 项目机制：docs/model-interaction-controls.md；README 的技能中心与画布/视频流程。
- 仓库：MIT，查看时 2686 stars、572 forks。热度只作来源参考，本次未实测各技能的创作输出，也没有声称具体单技能安装量。

- [short-drama-develop](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama-develop/SKILL.md)
- [short-drama-review](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama-review/SKILL.md)
- [short-drama-novel-analyze](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama-novel-analyze/SKILL.md)
- [short-drama-edit](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama-edit/SKILL.md)
- [short-drama-produce](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama-produce/SKILL.md)
- [short-drama](https://github.com/zenstory-ai/drama-skills/blob/c2426e03c0e7722bebcc6a488b6658dc38c65ac3/skills/short-drama/SKILL.md)
