# 模型提供商接入调研

调研日期：2026-10-13。依据 Cherry Studio、LobeHub 当前公开主分支源码，以及 Open WebUI 官方站点文档；不是对这些工具的完整实测。主分支实现可能继续变化。

## 结论

接入应该区分四件事：提供商连接、接口协议、模型能力、生成参数。提供商名称和模型名称都不能单独决定请求格式。

普通用户应通过地址、密钥、模型列表和参数表单完成配置。请求模板 JSON 适合作为高级覆盖项，不应是图片模型配置的默认入口。

市面上的生图协议并不完全一致。很多中转平台将不同模型转换成同一种 Images 接口，但原生服务在认证、参考图上传、请求结构和同步／异步返回上仍有差异。

## 三个工具如何设计

| 工具 | 提供商连接 | 模型管理 | 图片参数与协议差异 | 本项目可借鉴的部分 |
| --- | --- | --- | --- | --- |
| Cherry Studio | 提供商连接与模型定义分开；按接口类型配置地址、适配器和认证；预设可被用户配置覆盖 | 模型目录、提供商元数据和用户覆盖配置合并；连接设置包含模型获取、手动添加与验证步骤 | 图片页面按提供商＋模型查询能力，把枚举、范围、开关等参数定义转换为表单控件 | 让模型能力驱动表单；保留自定义接入；图片接口可以有独立地址 |
| LobeHub | 自定义提供商表单独立填写名称、SDK／协议类型、Base URL 和密钥 | 模型独立记录 ID、类型、能力、参数定义；有新增与配置模型的入口 | 使用独立的适配器类型；图片参数定义包含默认值、枚举、范围、参考图数量／大小限制等 | 同一个协议接入多个模型；统一参数定义，由适配器转换成服务要求的字段 |
| Open WebUI | 聊天连接强调协议导向；填写 URL、密钥，可获取或手动指定模型 ID | 模型列表获取与手动配置并存；文档明确没有 `/models` 不一定意味着服务不可用 | 生图设置单独选择引擎、URL、密钥与模型；Images 与原生 Gemini 分开配置，也支持通过代理转换成 Images | 连接与具体生成能力分开；模型列表获取失败时保留手动添加；显示实际协议而不是猜模型名称 |

这些工具也有内置提供商和模型预设。值得借鉴的是预设、适配器、能力元数据与用户配置的分工，而不是承诺所有模型都使用同一份请求。

### Cherry Studio 的证据

- [提供商类型定义](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/provider.ts)：连接、认证及 `endpointConfigs` 与模型目录信息分开；端点可配置地址、模型列表地址、适配器族和协议变体。
- [模型类型定义](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/model.ts)：模型目录与用户覆盖配置分开，包含能力、模态、端点类型和参数支持信息。
- [图片能力查询](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/hooks/useImageGenerationSupport.ts)：按提供商和模型解析图片生成能力，为自定义接入保留后备行为。
- [参数定义转表单](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/form/imageGenerationToFields.ts)：开关、文本、范围、枚举和尺寸定义转换为对应控件。界面标签与实际参数值分开。
- [连接设置向导](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/settings/ProviderSettings/ConnectionSettings/ProviderApiSetupDialog.tsx)：密钥、模型选择和验证属于连接流程，支持获取模型与手动添加。

### LobeHub 的证据

原 `lobehub/lobe-chat` 仓库当前重定向到 `lobehub/lobehub`。

- [新增提供商表单](https://github.com/lobehub/lobehub/blob/main/src/features/Settings/provider/features/CreateNewProvider/Content.tsx)：显示名称、SDK 类型、地址、密钥是独立字段。
- [自定义提供商协议选项](https://github.com/lobehub/lobehub/blob/main/src/features/Settings/provider/features/customProviderSdkOptions.ts)：提供 OpenAI、Google、Anthropic 等适配器选项。这些选项选择调用方式，并不限定只能使用某个模型名称。
- [提供商配置表单](https://github.com/lobehub/lobehub/blob/main/src/features/Settings/provider/features/ProviderConfig/index.tsx)：认证、连接验证和启用状态独立管理；不同适配器可提供不同认证字段。
- [提供商类型定义](https://github.com/lobehub/lobehub/blob/main/packages/model-bank/src/types/aiProvider.ts)：区分内置／自定义来源、SDK 类型、认证、密钥存储和模型获取能力。
- [模型类型定义](https://github.com/lobehub/lobehub/blob/main/packages/model-bank/src/types/aiModel.ts)：模型类型包括聊天、图片、视频等；图片模型有独立参数定义，能力字段区分视觉输入与图片输出。
- [标准图片参数定义](https://github.com/lobehub/lobehub/blob/main/packages/model-bank/src/standard-parameters/index.ts)：定义画幅、尺寸、分辨率、质量、参考图、默认值、范围及枚举。源码也保留部分内置模型识别规则，因此不能理解成完全没有模型预设。

### Open WebUI 的证据

- [OpenAI 兼容连接](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)：明确介绍 Protocol-Oriented Design，支持填写 URL／密钥和手动模型 ID；验证连接通过 `/models` 获取目录。这一页主要讨论聊天连接，不能据此推断所有图片接口兼容。
- [Images 生图设置](https://docs.openwebui.com/features/chat-conversations/image-generation-and-editing/openai/)：在 Admin → Images 单独设置引擎、模型、密钥与图片尺寸；通过 LiteLLM 等代理可接入转换后的接口。
- [Gemini 生图设置](https://docs.openwebui.com/features/chat-conversations/image-generation-and-editing/gemini/)：原生接入选择 Gemini 引擎，区分 `predict` 与 `generateContent`；通过兼容代理时可改走 Images 引擎。

官方站点的这两篇生图教程标记为社区贡献。本次使用它们核实配置结构，不把其中列出的型号或尺寸视作全部服务的通用规范。

## GPT Image 与 Nano Banana 应如何接入

同一个模型可能有多种接入方式。先看所购买服务的协议，再填模型 ID。

| 场景 | 选择依据 | 请求差异 |
| --- | --- | --- |
| 中转平台以 JSON Images 接口提供 GPT Image 或 Nano Banana | 中转平台文档 | 通常使用 `model`、`prompt`；比例可能叫 `size`、`ratio` 或 `aspectRatio`，参考图字段和返回方式需按服务配置 |
| 原生 Gemini 图片生成 | 原生 Gemini 协议及具体端点 | 使用内容／图片部分结构，认证及结果解析也不同，不能只替换 Images 请求中的模型名 |
| 使用文件上传的图片编辑接口 | 文件上传协议 | 可能需要 multipart 文件，而不是 JSON 中的图片 URL 或 Data URL |
| 提交后返回任务编号的平台 | 异步任务协议 | 需要配置任务编号、查询地址、状态与结果字段，不能当作直接返回图片处理 |

用户提供的 [RightAPI 图片文档](https://docs.rightapi.ai/docs/rc_draw/images-generations.html) 就使用 `nano-banana-fast` 举例，同时说明多参考图与异步任务。它证明这种 JSON Images 接口不限于 GPT Image，也不能证明其他平台的接口完全一致。

## 本项目建议的接入流程

1. **添加提供商**：填写显示名称、API 地址和密钥。协议有预设时选择预设；高级区提供认证头、额外请求头、独立图片地址等覆盖。
2. **添加模型**：优先同步模型列表，也允许手动填写模型 ID。目录没有可靠能力元数据时，让用户确认类型和能力，不根据名称自动承诺支持。
3. **配置模型能力**：文本／图片／视频输出、参考图数量、允许的画幅与分辨率、参数范围及默认值。
4. **设置生成参数**：显示该模型支持的控件。画布里的生成选项与模型设置共用参数定义，避免两套配置不一致。
5. **验证**：获取模型目录与真实生成是两种验证。目录可用不代表生图可用；真实生成可能计费，应由用户明确触发。

实现上，界面使用统一的参数名称，例如“画幅”“参考图”“生成数量”；协议适配层再转换成平台需要的字段与图片编码。默认值、参数枚举、参考图限制应由能力元数据提供，并允许用户覆盖。

提供商可以承载多种模型；图片与聊天也可以使用不同端点。模型 ID 不应自动修改提供商地址或切换协议。

## 当前完成的范围：按指定图片接口文档实现

2026-10-13 重新核对了用户指定的 [图片生成](https://docs.rightapi.ai/docs/rc_draw/images-generations.html)、[图片编辑](https://docs.rightapi.ai/docs/rc_draw/images-edits.html) 和它们引用的 [任务查询](https://docs.rightapi.ai/docs/rc_draw/tasks.html) 文档。当前图片模型默认采用这份异步契约，替代此前从其他平台推断的同步／自动尺寸配置。

| 环节 | 文档要求与当前实现 |
| --- | --- |
| 文生图 | `POST /draw/v1/images/generations`，JSON；发送 `model`、`prompt`、`n: 1`、`size` 和必需的 `async: true` |
| 生成接口参考图 | 同一接口的 `image` 或 `images` 数组，支持多张 Data URL／公开 URL；本项目将选中的素材编码为 Data URL |
| 编辑接口参考图 | `POST /draw/v1/images/edits`；支持 JSON 图片数组或 multipart；上传文件时重复 `image` 字段，不使用 `image[]`，至少一张图片 |
| 尺寸 | `size` 使用比例字符串或像素尺寸；不再以 `auto` 作为该契约的默认值；`aspectRatio` 是可选替代字段，当前实现统一使用优先级更高的 `size` |
| 清晰度 | `imageSize` 可选 `1K`、`2K`、`4K`，仅在模型明确支持且用户开启该能力时发送，不从模型名称推断 |
| 提交结果 | 保存 `task_id`，然后开始查询；不等待同步图片响应 |
| 查询地址 | `GET /v1/tasks/{task_id}`，不含 `/draw`，使用相同提供商认证；独立于图片提交 API 地址 |
| 未完成 | `queued`、`in_progress` 等状态继续查询；默认间隔 5 秒 |
| 已完成 | `completed` 或不带状态但有 `data[].url` 的响应；先保存恢复链接，再下载图片 |
| 已失败 | `failed`、`expired`、`canceled`；显示上游 `error.message` |
| 恢复 | 持久化任务编号后只 GET 查询原任务；不重新上传参考图，也不自动再次 POST；下载失败保留恢复链接 |

文档说明生成接口的 `response_format` 无效，异步结果只返回 URL；编辑接口的 `mask` 参数尚未生效，variations 不支持。当前规范因此不提供 Base64 返回、蒙版或变体生成配置。

### 图片模型配置表单

- 新图片模型默认使用“Images API · 异步任务”。已有自定义模板保持原样，用户可通过表单选择该规范。
- “参考图用途”选择编辑图片或参考生成；编辑图片可选择 JSON／文件上传，生成接口固定使用 JSON 数组。
- 尺寸、允许画幅、默认画幅、可选像素尺寸、默认尺寸、清晰度能力、参考图压缩均通过 Mantine 表单配置。
- “连接与任务查询”提供独立提交／查询 API 地址、JSON 图片字段、超时和轮询间隔；表单显示实际三个请求地址。
- 默认从提供商地址推导同一主机的 `/draw/v1` 和 `/v1`，也支持代理前缀及显式任务地址覆盖。不固定服务商或模型名称。
- 高级 JSON 默认折叠。选择文档规范后，后端校验并使用规定字段，防止旧模板遗漏 `async` 或发送不支持的字段。

现有 `gpt-image-2.5` 模型已通过本地模型 PATCH 接口更新为这份契约：保留模型记录、模型 ID、提供商、密钥、价格和可选画幅；提交地址为 `https://www.rightapi.ai/draw/v1`，任务地址为 `https://www.rightapi.ai/v1`，参考图沿用 JSON 编辑接口。原始素材与历史任务未改动。

### 已确认的失败证据与验证范围

此前灵算页面 0.7.1 的同步 Images 实现使用 `image[]` 文件字段与 `auto` 尺寸。这是另一平台的具体协议，不能用于推断本次指定接口的要求；旧自定义接入仍可通过高级配置保留其实现。

旧请求存在固定 90 秒超时、五张 PNG 约 48 MiB JSON 上传、错误正文未保存的问题，之前已补充图片请求超时、上传副本压缩和错误信息保留。本次最近失败请求已记录厂商 HTTP 502／Cloudflare Host Error，耗时约 44–61 秒；请求模板缺少文档要求的 `async: true`。现有证据不能证明修正异步参数就能消除厂商的所有网关故障。

本次验证覆盖模拟接口的准确请求体、多图 JSON／文件上传、独立任务地址、无状态的 URL 结果、任务号与下载链接保存顺序、恢复不重新提交、失败不重复 POST，以及配置 API 与表单保存校验。完成构建和浏览器检查；没有调用付费生图，也没有自动重试历史失败任务。

扩大回归发现 `video-reference-generation.test.ts` 的两条可选视觉设定文本保留断言失败；在隔离的原始 HEAD 代码中也复现相同失败，属于既有问题，本次未改动该视频提示词逻辑。

收尾期间观察到用户触发的一条真实任务已保存厂商任务号，并在查询后收到厂商 `failed` 与提示词内容策略拒绝信息。这验证了提交与任务查询可以连通，但未验证成功出图；本次没有由助手发起或重试付费生成。
