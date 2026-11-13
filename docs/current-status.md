# 当前功能与验证状态

> 核对日期：2026-10-22。实现基线：`9ba5a25`（`feat: improve script recovery and scoped canvas workflows`）。本页记录当前源码与同次提交前的实际验证结果，不把历史通过记录当作当前全量通过。

> 2026-11-13 可靠性增强与本轮验证见 [AI 接入可靠性与结果恢复](ai-integration-reliability.md)。以下 2026-10-22 的验证表是历史记录。

## 当前已接入的工作流

- 原剧本上传与原稿保留、有效稿修订、目录和人物证据分析、持久断点、按版本与配置校验的增量复用。
- 剧本导演工具对话、阶段提案、草稿编辑、独立评审、有限修订和创作者确认保存。读取资料、生成、评审、保存是不同状态。
- 按场分镜规划、明确确认后加入画布、独立重新设计方案与历史保留；画布、镜头和视觉设定按方案处理。
- 区块提示词、引用编号与用途、来源更新合并、冲突提示；基础/派生视觉设定、多视角候选与固定版本参考。
- 持久化生成任务、同步或异步图片、异步视频任务查询恢复、结果下载和候选审核。模型能力由实际协议配置决定。
- 标准音色配音、逐句候选选用、按镜头放置、取段、对白/旁白与原声/配乐混音、淡变及 ducking。
- 按所选分镜方案读取镜头、制作范围、接镜审核与导出历史，连续预览并导出 MP4。普通画布共享原始分镜方案；项目文档、素材、配音台词和配乐/ducking 设置仍共享，配音放置按方案区分。

完整用法见 [README](../README.md) 和 [文档索引](README.md)；产品优先级见 [产品分析](product-analysis.md)。

## 尚缺能力与验证边界

每镜当前只有一个入片片段；通用多轨/多段剪辑、独立音效轨、字幕烧录、转场编辑、自动逐句音频排布和口型同步尚未接入。视觉设定与参考引用已存在，实际画面仍可能发生人物、道具或空间不一致，需要审核和重拍。

请求次数/token 用量及局部分析预算不等于完整制作的实际账单。当前文档同步没有新增真实模型调用，没有重新制作《听雷桥》或测量真实质量、成本、时延，也没有进行新的浏览器端到端验收。

## 验证记录

以下为 2026-10-22 对同一代码基线的实际运行结果；本轮只修改文档，未用修改业务代码来消除这些失败。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过：架构检查、UI 控件检查、共享包、后端 TypeScript、前端 TypeScript 与 Vite 构建；Vite 提示部分产物超过 500 kB |
| `npm test` 的 tooling 测试 | 2 项通过 |
| `npm test` 的 web 工作区 | 共 869 项，865 通过、4 失败；对 4 个相关文件串行复核仍失败（27 项中 23 通过） |
| `npm run test --workspace=backend` | 允许本地 HTTP 测试监听后共 1,400 项，1,397 通过、报告 3 失败；包含一个失败子测试和其父测试的重复统计，共 2 个失败场景 |
| `git diff --check` | 代码提交前通过；文档修改另行检查空白错误与本地链接 |
| 本轮文档检查 | 27 份 Markdown 的 UTF-8、代码围栏、148 个本地链接及标题锚点、51 个完整源码路径和索引覆盖检查通过；文档 `git diff --check` 通过 |

最初沙箱中的后端测试还有 `listen EPERM`，允许测试监听本地端口后这类失败已消除。下表列的是复核后仍存在的问题，不能全部归因于沙箱权限。

| 文件 | 失败内容/可见证据 |
| --- | --- |
| [`app-canvas-refresh.test.tsx`](../web/test/app-canvas-refresh.test.tsx) | App 轮询更新父级 continuity 状态的计数断言为 `0 !== 1` |
| [`canvas-model-parameters.test.ts`](../web/test/canvas-model-parameters.test.ts) | 原生图片参数场景的实际提示词前缀与断言不一致 |
| [`script-canvas-preparation.test.tsx`](../web/test/script-canvas-preparation.test.tsx) | 统一规划/刷新重试场景未找到“确认加入画布”按钮 |
| [`task-records.test.tsx`](../web/test/task-records.test.tsx) | 内容策略失败的提示词优化场景中，Mantine Textarea Autosize 访问未定义对象的 `addEventListener` |
| [`script-source-story-parts.test.ts`](../backend/test/script-source-story-parts.test.ts) | schema 子测试期望 `/expected array/`，实际错误为中文 Schema 诊断；父测试随该子测试失败 |
| [`script.test.ts`](../backend/test/script.test.ts) | design JSON 续写/整本修复场景中 mock 的 `props` 断言失败，接口实际返回 500，期望 200 |

这些记录描述测试观测，不据此直接断定全部为产品缺陷或全部为测试过时。修复需逐项核对实现与预期契约，再运行相关回归。

## 后续复核命令

在根目录执行 `npm run build`、`npm test`，或执行 `npm run test:web` / `npm run test:backend` 检查对应工作区。后端部分集成测试会启动本机临时 HTTP 服务，需要允许监听 `127.0.0.1`。测试使用模拟或测试服务，不代表厂商真实模型质量验收。
