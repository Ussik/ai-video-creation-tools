# 图片反推提示词

核对日期：2026-10-26。功能按图片输入与文字输出能力选择模型，不限定豆包或 Seed 品牌。

## 支持范围

| 模型与接口 | 当前接入 |
| --- | --- |
| 支持视觉的文本模型，Responses / Chat Completions | 模型设置中开启“支持图片理解”后，可在画布“看图模型”中选择，包括支持视觉的 GPT、Gemini、豆包等兼容模型 |
| Nano Banana 等 Gemini 图片模型，原生 `generateContent` | 显式配置独立反推接口；该接口必须支持同步 `TEXT` 输出 |
| GPT Image，Images API | 只生成或编辑图片，不能直接返回反推提示词；使用支持视觉的 GPT 文本模型完成分析 |
| 只返回异步生图任务或图片地址的兼容服务 | 不作为文字反推接口使用 |

Google 的 Gemini 2.5 Flash Image（Nano Banana）模型页列明输入和输出均支持图片与文字。`generateContent` 的 `responseModalities` 可指定 `TEXT`；具体模型和服务商支持哪些模态组合，以其实际接口为准。不支持该组合时显示上游错误，不改为请求图片。

RightAPI 2026-10-24 的 Gemini 生图文档要求 `async: true`，立即返回 `task_id`，完成后在 `parts[].text` 返回图片 URL。该文档没有说明支持同步文字反推，因此不能将现有 RightAPI 生图配置自动视为可用的反推接口。

## 配置与使用

1. 打开模型设置，编辑对应图片模型，开启“启用 Gemini 图片反推”。
2. 填写支持同步文字输出的分析 API 地址，以及服务商实际支持的 Gemini 模型 ID。留空时分别沿用提供商地址和当前模型 ID。
3. 分析请求路径默认 `models/{model}:generateContent`，相对分析 API 地址拼接。例如 Google 官方 API 地址为 `https://generativelanguage.googleapis.com/v1beta`。
4. 分析认证沿用该模型所属提供商。直连 Google 时，应使用配置了 Google 密钥的提供商，并设置认证头 `x-goog-api-key`、认证前缀留空；中转服务按自己的认证文档配置。不会读取或替换其他提供商的密钥。
5. 在画布的图片反推节点中选择看图模型，上传或连接图片，填写可选侧重点，点击“开始反推”。结果可编辑、复制或用于创建图片生成节点。

反推配置保存在图片模型设置的独立 `image_analysis` 字段中，现有生图模板、地址与参数保留。例如在原设置中合并：

```json
{
  "image_analysis": {
    "enabled": true,
    "protocol": "gemini_generate_content",
    "api_base_url": "https://generativelanguage.googleapis.com/v1beta",
    "remote_id": "gemini-2.5-flash-image",
    "request_path": "models/{model}:generateContent"
  }
}
```

## 请求与验证

后端读取当前项目真实图片像素，经旋转和压缩后以内嵌 Base64 图片发送。Gemini 请求固定 `generationConfig.responseModalities: ["TEXT"]`，不使用图片生成模板、不提交异步生图任务、不自动重试或回退生图。

反推支持取消，结果最多 20,000 字符。上游返回异步任务、纯图片地址、图片内容、空答案、仅思考过程、截断或被拦截的结果时，显示错误并保留原有提示词。

相关验证使用 mock 接口和临时数据库，覆盖配置、画布选择、真实像素编码、默认路由至 Gemini adapter、取消、错误与生图结果拒绝。没有调用付费模型；实际可用性仍需使用匹配的服务商接口与密钥验证。

## 文档依据

- [OpenAI：Images and vision](https://developers.openai.com/api/docs/guides/images-vision)：区分图片理解与图片生成接口。
- [Google：Gemini 2.5 Flash Image](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)：Nano Banana 的输入和输出模态。
- [Google：generateContent API](https://ai.google.dev/api/generate-content)：`inlineData`、`responseModalities`、文字结果与结束原因。
- [RightAPI：Gemini 生成](https://docs.rightapi.ai/docs/rc_draw/gemini.html)：异步生图接口与图片 URL 结果格式。
