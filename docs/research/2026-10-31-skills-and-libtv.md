# 项目技能安装与 LibTV Skills 分析

核验日期：2026-10-31，Asia/Shanghai。

## 本次已完成的安装

通过正在运行的本项目 `/api/skills` 正式接口更新、预览、安装及配置。应用数据库为 `data/studio.db`，SQLite 仅用于只读核对。

- 原有 8 个 Zenstory 技能全部更新成功，原启用状态、适用环节、全局默认及项目默认均保留。
- 新增 9 个技能，其中 5 个启用为可选创作规则，4 个收入库供阅读、等待工具接入。
- 当前合计 **17 个技能，13 个已启用**；API、数据库和浏览器技能中心显示一致。
- 已登记 `zenstory-ai/drama-skills` 和 `eternityspring/shuohao-skills` 两个来源。
- 本次没有运行技能附带脚本或媒体生成任务。

| 新增技能 | 适用环节 | 当前配置与用途 |
| --- | --- | --- |
| `novel-outline` | 剧本创作 | 已启用：小说改编、大纲、分集钩子和资产预算 |
| `novel-script` | 剧本创作 | 已启用：动作/对白节拍、场次结构和时长预算 |
| `novel-characters` | 视觉设定 | 已启用：角色表、人物画像、形象与音色方向 |
| `novel-art` | 视觉设定、图片提示词 | 已启用：场景锚点、光照变体、叙事道具和尺度参照 |
| `novel-storyboard` | 分镜规划、视频提示词 | 已启用：生成段、段内切镜、关键帧与台词落点 |
| `novel-staging` | 分镜规划 | 已安装、未启用：空间识别、站位数据和交互俯视报告需要适配 |
| `character-refs` | 视觉设定、图片提示词 | 已安装、未启用：实际角色出图需要 Node 和生成模型适配器 |
| `short-drama-produce` | 当前无对应生产技能环节 | 已安装、未启用：外部媒体 adapter 和任务账本尚未接入 |
| `short-drama-edit` | 当前无对应后期技能环节 | 已安装、未启用：FFmpeg/ffprobe 等剪辑工具尚未通过技能执行 |

原有技能包括 `short-drama-novel-analyze`、`short-drama-develop`、`short-drama-write`、`short-drama-assets`、`short-drama-image-prompts`、`short-drama-storyboard`、`short-drama-video-prompts`、`short-drama-review`。

安装后的固定版本：

- Zenstory：[`33eb7fece523fb705869dff3f4c95c58ce9b577d`](https://github.com/zenstory-ai/drama-skills/tree/33eb7fece523fb705869dff3f4c95c58ce9b577d)，更新前为 `fdb7b7c58017e3eae64eca382c2a85ede368dab0`。
- Shuohao：[`5612d2a0bd5f19d978c3ee19d1e42840335e3b4b`](https://github.com/eternityspring/shuohao-skills/tree/5612d2a0bd5f19d978c3ee19d1e42840335e3b4b)。

可复核安装清单见同目录 `2026-10-31-skill-installation.json`。技能明细和配置备份位于本机临时目录 `/tmp/studio-skills-install-20261031/`，该目录不是长期归档。

### 如何使用新增技能

在“技能中心 → 已安装”查看配置。新增五项已进入各自创作环节的可选列表；创作时选择本次主技能或辅助技能即可。本次保留 Zenstory 为默认主干，启用备选不会自动改变默认或对已有作品重新生成。

当前应用有两项接入边界：

1. `backend/src/modules/skills/skills.ts` 只导入文本，应用契约明确不执行第三方脚本、不调用技能自带外部服务。因此安装文档不会自动获得角色出图、站位报告、生产 adapter 或自动剪片能力。
2. `relevantReference` 依据文件名选择参考文档。Shuohao 的 `outline-pass.md`、`script-pass.md`、`storyboard-pass.md`、`schema.md` 等多数核心参考文件目前不会自动注入；五项新增技能主要发挥主 `SKILL.md` 中的方法。它们是可选创作规则，尚不是完整原生工作流。

## LibTV 有哪些可确认的技能

存在两层：站内 Skill 社区，以及官方 Codex 插件随包 Skills。两者都与平台执行工具配合，但公开范围不同。

### 站内 Skill 社区

在 [LibTV Agent](https://www.liblib.tv/skill) 实际查看到技能目录、分类、搜索、收藏及详情。官网前端还提供上传 `SKILL.md` 或文件夹、创建个人 Skill、从对话或节点总结 Skill 的产品文案。

站内支持 `SKILL.md` 文件式规则，**不代表社区文件全部符合标准 Agent Skills YAML 格式**。本次读取的部分公开正文没有有效 frontmatter，不能直接通过本项目要求 `name`、`description` 的 GitHub 导入器。

原目标中四个有代表性的技能：

| 技能 | 版本 | 本次可以确认的内容 |
| --- | --- | --- |
| [精品女频短剧一键成片](https://www.liblib.tv/skill/share?uuid=9662f7b185a84ff7a86790b1cb640b6d) / `xingrannvpin` | 1.0.1 | 详情介绍甜宠、逆袭、虐恋等题材，从剧本切分到成片；正文未公开 |
| [AI短剧制片人](https://www.liblib.tv/skill/share?uuid=d530bbf586fc428992a1c2559064132c) / `ai-short-drama-flow` | 1.0.0 | 页面宣称从剧本到高反转短剧；正文未公开 |
| [微表情情绪精控](https://www.liblib.tv/skill/share?uuid=0df8fc3871fd4210824f75fc1473ed16) / `micro-expression-analyst` | 1.0.2 | 页面介绍微表情精控；正文未公开 |
| [爆款男频短剧skill](https://www.liblib.tv/skill/share?uuid=2ffefb9ec1444546ac280b48eb290aef) / `xingran-nanpintongyongban` | 1.0.3 | 页面介绍男频爽点短剧；正文未公开 |

这些记录的 `showMarkdown=false`。本次只分析其公开介绍，没有请求隐藏正文，也没有证据证明其内部采用 Zenstory、Shuohao 或其他特定 GitHub 技能。

为比较实际方法，另外读取了三份明确公开正文的社区技能：

| 公开技能 | 实际规则 | 判断 |
| --- | --- | --- |
| [AI短剧制片人，栋1321](https://www.liblib.tv/skill/share?uuid=1a4c2fd858f2441d97f41c85718f80d4)，v1.0.3 | 正文约 749 字：确认阶段/形态/语言 → 主角三视图 → 四类场景 → 镜号、景别、画面、台词、时长、运镜 → 成片方案 | 基础流程模板。正文缺少当前 Zenstory 已有的资产状态、跨镜连续性、参考图职责、对白窗口、任务恢复和成片验收细则；没有依据将其评为整体更优。此项与上表同名制片人是不同作者、不同技能 |
| [微表情与情绪表演框架](https://www.liblib.tv/skill/share?uuid=1f922f0d0dc24d3a8d315ed960c6198b)，v1.0.1 | 用肌肉动作替换静态情绪形容词；加入未完成动作、情绪回落、台词触发、时间线和景别约束 | “可见变化、动作回落、镜头能看清”值得借鉴；强制毫米/角度/0.2 秒、逐词绑定等规则不等于模型具有相应执行精度，不宜全部照搬 |
| [微表情演技指导](https://www.liblib.tv/skill/share?uuid=9ae90359ef3c4a81b37b1b6d68c0b24d)，v1.0.0 | 情绪起终点、眼部、呼吸、面部肌肉、生理动作、转折、摄影七层；默认单人、单镜、10 秒、特写，禁止台词和第二人物/场景 | 适合无对白情绪特写的辅助方法。作为全局默认会破坏双人戏及对白戏。其“400字后模型丢弃后续层”的说法未获验证 |

以上三份来自社区命名空间 `libtv-user-generated`，均为 `showMarkdown=true`。公开详情中的 `snapshotData` 保存 `markdownContent`、`skillFiles` 与 `primarySkillFilePath`；这证明文件式规则和版本化快照存在，不证明服务端完整编排实现已公开。

### 官方 Codex 插件的三个技能

官网提供的插件安装来源为 [liblib-ai/marketplace](https://github.com/liblib-ai/marketplace)。本次核验固定提交 [`4ac581c3cbdaa53d0d42df85c6bf62e45600bc5f`](https://github.com/liblib-ai/marketplace/tree/4ac581c3cbdaa53d0d42df85c6bf62e45600bc5f)。

| 官方技能 | 真实流程与边界 |
| --- | --- |
| [libtv-blender-live-action](https://github.com/liblib-ai/marketplace/blob/4ac581c3cbdaa53d0d42df85c6bf62e45600bc5f/plugins/libtv/skills/libtv-blender-live-action/SKILL.md) | 剧本拆空间/人物/动作 → 同场景两个连续视角 → 人物三视图 → Blender 完整白模环境、人物走位和运镜 → 白模预演视频 → Seedance 2.5 实拍化。最值得本项目借鉴的是先确定空间与运镜，再生成画面。需要 Blender、LibTV 工具与目标模型支持 |
| [libtv-to-treatment](https://github.com/liblib-ai/marketplace/blob/4ac581c3cbdaa53d0d42df85c6bf62e45600bc5f/plugins/libtv/skills/libtv-to-treatment/SKILL.md) | 读取画布内已有图像、视频、音频、剧本与分镜，整理中文 16:9 导演提案 HTML、资源包和 ZIP；偏成果提案与交付。无成片时有可选 POP MV 路线，不能视作通用短剧主编剧引擎 |
| [music-driven-product-ad](https://github.com/liblib-ai/marketplace/blob/4ac581c3cbdaa53d0d42df85c6bf62e45600bc5f/plugins/libtv/skills/music-driven-product-ad/SKILL.md) | Zen Piano 实际演奏并取得 WAV → 锁产品和人物参考 → 规划连续横向空间 → 一次 Seedance 视频生成 → 合成音轨与检查。默认 20 秒、一镜到底、向右运动、3–5 空间，是特定广告配方 |

官方 README 和 MCP 配置明确：插件连接 `https://mcp.liblib.tv/mcp`，通过 OAuth 绑定用户 LibTV 身份，不附带本地生成服务器。媒体生成、画布读写、任务监控等能力依赖远程平台，Skill 规定如何组织流程。

`music-driven-product-ad` 还明确区分自身 Codex Skill 与站内 Canvas Skill，要求创意规划由本技能承担；因此上面三个公开文件不是 LibTV 站内技能的完整列表。

## 对当前项目的判断

当前项目已经具备文本规则、视觉设定、镜头引用、模型提供商和媒体任务等基础。LibTV 的公开资料提示三项优先方向：

1. **完善技能参考资料的加载。** 先让已安装技能的关键参考文档按任务和依赖被正确读取，避免仅装入文档却漏掉方法细节。
2. **增加可选的表演辅助规则。** 围绕情绪前后变化、眼神落点、呼吸、动作与对白因果、反应镜头组织；按镜头需要使用，不强制全局单人、无台词或精密数值。
3. **加强空间预演与执行闭环。** 群戏先确定站位、朝向、机位和连续状态，必要时使用 3D 白模；将规划绑定到实际模型参数、参考图和任务结果，再通过播放检查表演、接镜与声音。

本次完成技能安装与分析，没有实施上述功能改造，也没有在 LibTV 发送生成任务。源码与公开规则能够证明方法和接口存在，不能替代同剧本、同模型、同预算的成片质量对比。

## 核验记录

- 安装：8 项更新、9 项新增、2 个来源登记，正式写接口失败数为 0；默认配置前后逐项相同。
- 界面：本地技能中心“已安装 · 17”，五项新增创作技能显示已启用，四项工具流程显示未启用。
- LibTV：实际查看 Agent 目录和女频短剧公开详情；读取三份公开社区正文及三份官方插件技能；未查看私人项目或隐藏正文。
- 本地临时证据：`/tmp/studio-skills-install-20261031/`、`/tmp/liblib-skills-public-research/`。
- 前端机制仅作静态分析，REA 证据：`ev_8372f36f41bb9c7a38432e4623e964f8c05d72b300837e0efb9d345dc349e5b2`、`ev_2d98cee4984e5c2310c7f918aed32c453bb9957fac5f675393f2e17f06200ab2`；图谱覆盖为局部，不代表服务端源码或所有模块运行行为。
