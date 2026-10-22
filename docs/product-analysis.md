# AI 视频工具产品分析与当前范围

> 实现核对：2026-10-22，代码基线 `9ba5a25`。功能状态以当前代码为准；外部调研和《听雷桥》试制反馈保留为早期历史依据，不代表本轮重新访问厂商或重新制作了样片。近期测试结果见 [当前状态](current-status.md)。

调研对象：成熟项目公开页面、[小云雀](https://www.xiaoyunque.com/home?from_page=xiaoyunque_landing_page&tab_name=home)、[火山方舟产品文档](https://console.volcengine.com/ark/region:cn-beijing/docs/ark/product-overview?lang=zh)。以下是公开界面与官方接口文档显示的能力，不将站点内部实现视为已知事实。

| 产品 | 重要能力 | 对个人工具的启发 |
| --- | --- | --- |
| 成熟项目 | 项目与素材管理、节点画布、故事板、角色造型、导演辅助、生成历史 | 保存每次尝试；当前已支持多画布、分镜方案历史、基础/派生视觉设定及版本参考，实际生成一致性仍需验收 |
| 小云雀 | 脚本/Agent 入口、模型与模式选择、首尾帧/参考/编辑/延长、样片、分辨率与时长控制、多轨剪辑 | 把生成参数与结果选择放在镜头旁；先完成“生成到成片”的短路径，再增加复杂剪辑 |
| 火山方舟 | 文本 Responses、图片生成、异步视频任务与多种引用模式 | 视频调用必须保存外部任务 ID、轮询状态、及时落盘；接口细节应保存为模型配置 |

## 优秀成片的关键需求

1. **可控的分镜。** 每镜头有明确的主体、动作、场景、运镜、时长和画幅；可调整顺序，避免全片只靠一条长提示词。
2. **可复用的视觉参考。** 支持导入图片、挑选首帧/尾帧或参考图，并保存生成参数和结果来源；已接入视觉资料、多角度候选、基础/派生继承与镜头版本快照。引用约束不保证实际画面一致。
3. **多模型自由组合。** 文本可用 DeepSeek，图片可用 GPT 或 Seedream，视频可用 Seedance 或其他异步 API。厂商连接、模型 ID、请求参数、结果路径均可编辑。
4. **异步任务可靠性。** 保存外部任务 ID，重启后恢复查询；显示排队、运行、成功、失败；缓存最终媒体，避免临时 URL 过期。
5. **版本选择与局部重做。** 同一镜头保留多次生成结果，可从候选中选一版成片，失败或不满意时只重做该镜头。
6. **可检查的成片。** 镜头时间线、对白/旁白放置、原声与配乐混音、裁剪和时长设置清晰，导出标准 MP4；后续增加字幕、转场、独立音效轨和多段剪辑。

## 当前功能清单

| 优先级 | 功能 | 状态 |
| --- | --- | --- |
| P0 | 本地项目、分镜、画幅与镜头时长 | 已实现 |
| P0 | 厂商连接与模型协议/请求模板配置；API Key 本机加密 | 已实现 |
| P0 | 文本、图片、异步视频生成；任务记录与重启恢复 | 已实现 |
| P0 | 素材导入、参考图、镜头候选选择、MP4 导出 | 已实现 |
| P1 | 文本模型按场规划多镜头，编辑预览后批量创建 | 已实现 |
| P1 | 制作范围：完整剧本只制作或导出选定开场 | 已实现 |
| P1 | 候选审核：首中尾帧、问题备注、通过/拒绝 | 已实现 |
| P1 | 实际接镜审核：相邻尾/首帧、备注、通过/需修改、切点变化后重审 | 已实现 |
| P1 | 每镜原声音量、静音、首尾淡变；预览与导出一致 | 已实现 |
| P1 | 可选模型单价与生成前费用估算 | 已实现 |
| P1 | 标准音色配音、逐句候选选用、取段与按镜头放置、对白 ducking | 已实现 |
| P1 | 视觉设定资料库、基础/派生继承、多视角参考与镜头版本快照 | 已实现；实际画面一致性需审核 |
| P1 | 区块提示词、引用编号/用途、来源合并与冲突提示 | 已实现 |
| P1 | 字幕、转场、独立音效轨、通用多轨多段剪辑 | 后续；已有连续预览和区间裁剪 |
| P1 | 对象存储上传，让本地视频可作公网参考 | 后续 |
| P2 | 项目多画布：文本/素材/生成节点、参考连线、自动保存、筛选与可视区渲染 | 已实现 |
| P2 | 剧本 Agent：原生工具对话、阶段草稿、独立评审与明确确认保存 | 已实现；不是无人值守的整片自动生产 |
| P2 | 原稿/有效稿分离、长稿分析与断点、按版本和配置增量复用 | 已实现；质量与节省比例需真实模型评估 |
| P2 | 独立分镜方案历史、按方案隔离制作范围/接镜审核/配音放置/导出 | 已实现；普通画布共用原始方案，项目文档与素材仍共享 |

当前实现入口包括 [`script-document-tools.ts`](../backend/src/modules/script/script-document-tools.ts)、[`script-source-analysis.ts`](../backend/src/modules/script/script-source-analysis.ts)、[`storyboard-planning.ts`](../backend/src/modules/storyboard/storyboard-planning.ts)、[`ProjectCanvas.tsx`](../web/src/features/canvas/ProjectCanvas.tsx)、[`final-cut-scope.ts`](../backend/src/modules/final-cut/final-cut-scope.ts) 和 [`speech-timeline.ts`](../backend/src/modules/speech/speech-timeline.ts)。详细使用说明见 [项目 README](../README.md) 与 [文档索引](README.md)。

## 历史：45 秒试制反馈

《听雷桥》保留约 120 秒、13 场完整剧情，只制作前五场的 7 个镜头，入片时长分别为 8/6/5/7/5/6/8 秒，成片约 45 秒。7 次视频生成各取一个候选；首镜另用图片生成关键帧。首尾帧接续和双角色参考使左右站位、服饰与武器比纯文生镜头稳定，但面具在第四镜提前松动，后续镜头必须根据实际生成结果逐镜改写动作状态。成片已导出，仍属无正式对白、音效未精修的视觉样片。

以下保留当时的质量问题。对白/旁白入片和视觉参考库现已接入，不能再把它们全部列为未开发；本轮没有重新生成或重新验收该样片。当前按成片质量的影响排序：

1. **对白表演与音效。** 标准音色、逐句候选、选用后入片与配乐 ducking 已具备，需验证实际剧情的表演和身份揭示效果；仍缺独立音效轨、拟音编辑与音乐逐段包络或节拍点编辑。
2. **参考库的实际一致性。** 人物、服饰、场景和道具已有命名设定、基础/派生状态与多视角图片，需在连续镜头中核验参考准确性；不能把引用成功视为人物/空间的像素级一致性保障。
3. **动作节拍与镜头预演。** 实际尾/首帧审核和文字连续性提醒已具备，仍需要在付费生成前标注起势、接触、退步、落点，并预演运动方向与关键道具状态。
4. **预算与制作决策。** 已有模型单价预估、请求用量记录及候选分析局部预算；仍需要整段制作预算、跨环节费用回填，以及未知付费任务的账单核对。局部预算不代表全项目费用上限。
5. **精细剪辑。** 可视化切点、转场与字幕，支持一个分镜内多段素材。已有连续预览与区间裁剪，但缺少对音乐节拍和动作重心的编辑控制。

另外应先核对 [当前验证记录](current-status.md#验证记录) 中的失败，再通过真实模型样本评估长稿遗漏、因果、角色一致性、时延和成本。代码能力与模拟回归不能代替完整创作质量验收。

## 历史：方舟接口调研

本节是早期官方资料调研，本轮未联网复核。型号、URL 有效期、任务查询窗口及模式参数可能变化，实际接入以当前厂商文档和本项目显式模型配置为准。

方舟 API Base URL 是 `https://ark.cn-beijing.volces.com/api/v3`，使用 Bearer Key。文本可配置 `POST /responses`，图片可配置 `POST /images/generations`，视频以 `POST /contents/generations/tasks` 创建任务，再用 `GET /contents/generations/tasks/{id}` 查询。[Seedance 2.5](https://ark.volcengine.com/region:cn-beijing/docs/ark/seedance-2-5?lang=zh) 支持文本、首尾帧、参考、编辑、延长和样片，但具体模式有参数约束，例如首尾帧使用 `ratio: adaptive`，编辑视频还需要 `duration: -1`。这些值由用户手动添加模型时的 JSON 配置表达。

当时资料记录方舟视频任务仅可查询近 7 天，结果 URL 通常只有 24 小时；[图片生成结果](https://ark.volcengine.com/region:cn-beijing/docs/ark/seedream-5-0-pro?lang=zh)的 URL 也有限时。当前实现会在任务成功时下载媒体。参考视频需要厂商可访问的公网 URL 或明确支持的 `asset://` 素材，不能将普通本地路径或 Files API 文件 ID 直接替代。

参考：[Responses API](https://ark.volcengine.com/region:cn-beijing/docs/ark/create-model-responses-api?lang=zh)、[图片生成 API](https://ark.volcengine.com/region:cn-beijing/docs/ark/image-generation-api?lang=zh)、[视频创建任务 API](https://ark.volcengine.com/region:cn-beijing/docs/ark/create-video-generation-task-api?lang=zh)、[视频查询任务 API](https://ark.volcengine.com/region:cn-beijing/docs/ark/get-video-generation-task-api?lang=zh)。
