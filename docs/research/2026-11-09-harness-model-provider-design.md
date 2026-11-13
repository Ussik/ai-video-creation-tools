# DeepSeek Harness 的模型提供商设计参照

核对日期：2026-11-09。目标为本机 `/Applications/DeepSeek Harness.app`，版本 `0.2.2-rc.1`，Bundle ID `com.deepseek.dsh`。

本次通过实际桌面设置界面和安装包选定模块静态分析核实，未保存配置、读取用户凭据或发出模型生成请求。以下是参照分析，尚未实施 Studio 的配置重构。

## 桌面界面观察

- 提供商编辑包含 API 密钥、显示名称、API 地址和协议选择。协议菜单有 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- 每个提供商直接包含模型目录，支持获取可用模型、手动添加、显示名、模型 ID、排序和删除。
- 模型行展开后提供上下文窗口、最大输出 token 数、文本/图片输入类型、推理开关、推理档位和对应 API 参数值。
- 正常编辑通过表单完成；打开配置文件是独立入口。界面不要求用户编写 HTTP 请求体或响应提取路径。
- 当前 Gemini 提供商选择的是 Chat Completions。Studio 当前同一转发渠道的 Gemini 选择 Responses，不能把两个接口的默认行为视为已经相同。
- 当前 Gemini 容量输入框没有显式值；灰色 1M / 128K 为占位提示。推理档位是配置声明，不代表对应渠道已在线验证支持。

## 安装包静态链路

模型手填容量优先于内置目录，之后才回退提供商默认。没有目录或覆盖时，全局默认上下文为 1,000,000、最大输出为 128,000。目录、提供商和请求覆盖都可能改变实际值，所以界面固定占位提示不能代表最终生效额度。

模型最大输出可转换为默认请求控制，经过调用层传递给 SDK。SDK 从 `options.maxTokens ?? model.maxTokens` 取值，并按 `contextWindow − 估算输入 − 4096` 限制输出预算。该字段与 Studio 仅用于本地估算的 `output_reserve_tokens` 作用不同。

协议适配器负责实际字段：Chat Completions 使用 `max_completion_tokens` 或兼容配置指定的 `max_tokens`；Responses 在兼容能力支持时使用 `max_output_tokens`。推理参数转换为 `reasoning_effort` 或 `reasoning.effort`，另有提供商专用处理。上述为所选安装包代码的静态链路，未捕获当前 Gemini 的真实网络请求，不能据此断言它实际请求了 128K，或渠道支持任意自定义推理档位。

REA 父证据：`ev_5a8bcb6ca8241b4aec82e7985bcd68edf5c29c1ab836ebafa4585a007fe807ea`。只覆盖选定模块，未作全安装包行为验收。以下路径及行号均为 `app.asar` 内成员，非已解包的本地独立文件：

| 成员 | 证据位置 |
| --- | --- |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` | 978–987：容量占位提示；1381–1398：推理选项读取 adapter schema；1613–1620：协议显示名 |
| `dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` | 689–711：模型与目录覆盖；959–962：默认容量；1951–1964：最大输出默认控制；2025–2032：传递 SDK 参数 |
| `dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js` | 2187–2191：补入模型默认输出控制 |
| `dsh/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js` | 3–9、18–23：默认输出值与上下文预算 |
| `dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` | 524–527：公共预算；594–600：输出字段；720–727：推理字段 |
| `dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js` | 192–203：公共预算；264–265：输出字段；283–298：推理字段 |

## Studio 的具体差距

Studio 已有提供商连接、模型目录和部分能力表单，问题在于标准文本参数没有完整进入表单：最大输出与推理仍依赖 JSON 请求模板，上下文区域只提供本地容量与输出预留，容易让使用者误判实际输出额度。相关代码在 `web/src/features/models/ModelSettings.tsx:911`、`TextModelContextSettings.tsx:46` 和 `backend/src/infrastructure/providers/text-context.ts:34`。

当前更换协议会把模型设置草稿替换为协议起始模板（`ModelSettings.tsx:870`）。后续重构应按兼容字段迁移，保留模型能力和用户明确设置，避免只改协议却意外覆盖其他参数。

## 建议改造方向

1. 普通流程以“提供商连接 → 模型目录 → 模型选项”组织。用户填写地址和凭据、选择协议、选择或添加模型，无需编写请求模板。
2. 提供商/协议适配器承担路径拼接、鉴权、请求参数、流式处理和返回解析；同一提供商承载多种图片、视频接口时保留模型级适配器选择，不能机械套用文本客户端的单协议结构。
3. 文本模型直接提供上下文能力、实际最大输出、推理强度及输入能力表单。图片、视频分别提供尺寸、画幅、时长等有业务含义的表单。
4. 分开显示模型能力与本次请求设置，展示最终发送值及其来源：模型手填、目录、提供商默认、任务覆盖或未知。留空不能只显示一个与实际解析值可能不符的例子。
5. 本地输出预留默认跟随实际输出预算，估算策略放在高级区域。已有 JSON 自定义配置保留为专家兼容入口，既有模型、任务快照和用户选择不因界面重构被改写。
6. 协议与模型支持的参数需要明确校验；通用推理菜单存在某个档位不代表上游支持。当前 Chat/Responses 的差异应单独核实，不能由 Harness 的可用界面推断 Studio 的 8K 截断已解决。
