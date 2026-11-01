import { geminiImageAnalysisConfig } from '@video-studio/shared/models/image-analysis-settings'
import { createStreamScope, generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'
import type { GenerationModel, GenerationProvider, TextStreamRequest } from './providers.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}

function analysisUrl(base: string, path: string, remoteId: string): string {
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Gemini 反推 API 地址必须是无认证信息和查询参数的 HTTP 或 HTTPS 地址')
  }
  // A model ID is one path segment, even when a gateway gives it a slash.
  const model = remoteId.replace(/^models\//, '')
  if (!model.trim() || model === '.' || model === '..') throw new Error('请填写有效的 Gemini 反推模型 ID')
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '').replaceAll('{model}', encodeURIComponent(model))}`
}

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) {
        await reader.cancel()
        throw new Error('Gemini 反推响应过大，请确认接口仅返回文本')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

function visibleText(payload: ObjectValue): string {
  if (payload.task_id) throw new Error('当前接口返回了异步生图任务，图片反推需要支持同步 TEXT 输出的 Gemini 接口')
  const blocked = object(payload.promptFeedback).blockReason
  if (blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED') throw new Error('Gemini 未返回提示词：输入图片或要求被上游拦截')
  const candidate = object(Array.isArray(payload.candidates) ? payload.candidates[0] : undefined)
  if (candidate.finishReason === 'MAX_TOKENS') throw new Error('Gemini 反推输出不完整：已达到模型输出长度上限，请缩小分析范围')
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new Error('Gemini 未完整返回提示词，请调整图片或反推要求')
  const parts = object(candidate.content).parts
  if (!Array.isArray(parts)) throw new Error('Gemini 未返回提示词文字，请确认当前接口支持 TEXT 输出')
  const answer = parts.map(object).filter(part => part.thought !== true)
  if (answer.some(part => typeof part.text !== 'string' || Object.keys(part)
    .some(key => !['text', 'thought', 'thoughtSignature', 'partMetadata'].includes(key)))) {
    throw new Error('Gemini 反推接口返回了非文本内容，请确认当前模型支持仅 TEXT 输出')
  }
  const text = answer.map(part => typeof part.text === 'string' ? part.text : '').join('').trim()
  if (!text) throw new Error('Gemini 未返回提示词文字，请确认当前接口支持 TEXT 输出')
  if (/^https?:\/\/\S+$/i.test(text) || /^!\[[^\]]*\]\(https?:\/\/\S+\)$/i.test(text)) {
    throw new Error('当前接口返回了图片地址，图片反推需要提示词文字，请更换支持 TEXT 输出的接口')
  }
  return text
}

/** Native Gemini analysis only. Never request IMAGE, retry a paid request, or
 * fall back to the configured Images API when TEXT is unavailable. */
export async function analyzeGeminiImage(model: GenerationModel, provider: GenerationProvider, request: TextStreamRequest,
  decodeKey?: (provider: GenerationProvider) => string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const settings: unknown = typeof model.settings === 'string' ? JSON.parse(model.settings) : model.settings
  const config = geminiImageAnalysisConfig(object(settings))
  if (model.modality !== 'image' || provider.adapter !== 'http' || !config) throw new Error('当前图片模型未配置可用的 Gemini 图片反推接口')
  if (request.images?.length !== 1) throw new Error('Gemini 图片反推需要一张本地图片')
  const image = request.images[0]!.data_url
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
  if (!match || image.length > 6 * 1024 * 1024 || Buffer.byteLength(match[2]!, 'base64') > 4 * 1024 * 1024) {
    throw new Error('图片反推输入必须是有效且不超过 4 MB 的本地图片')
  }
  const url = analysisUrl(config.api_base_url || provider.base_url, config.request_path || 'models/{model}:generateContent', config.remote_id || model.remote_id)
  const key = decodeKey?.(provider) || ''
  const headers = { 'Content-Type': 'application/json',
    ...(key ? { [provider.auth_header || 'Authorization']: `${provider.auth_prefix ?? 'Bearer '}${key}` } : {}) }
  const body = { contents: [{ role: 'user', parts: [{ text: request.prompt }, { inlineData: { mimeType: match[1], data: match[2] } }] }],
    generationConfig: { responseModalities: ['TEXT'] } }
  const scope = createStreamScope(signal, { totalMs: generationStepBudgets.discussion, totalMessage: 'Gemini 图片反推请求超时，请重试或更换看图模型' })
  const clean = (value: string) => (key ? value.split(key).join('[已隐藏]') : value)
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[图片数据已隐藏]')
    .replace(/("data"\s*:\s*")[A-Za-z0-9+/=]{64,}/g, '$1[图片数据已隐藏]')
  try {
    const response = await scope.wait(fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: scope.signal, redirect: 'error' }))
    const raw = await scope.wait(boundedResponse(response))
    let payload: ObjectValue = {}
    try { payload = object(JSON.parse(raw)) } catch { /* Report a safe transport error below. */ }
    if (!response.ok || payload.error) {
      const detail = object(payload.error).message
      throw new Error(`Gemini 反推接口返回 HTTP ${response.status}${typeof detail === 'string' ? `：${clean(detail).slice(0, 600)}` : '，请检查分析接口地址、模型 ID 和提供商认证'}`)
    }
    scope.signal.throwIfAborted()
    return visibleText(payload)
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason
    if (error instanceof TypeError) throw new Error('Gemini 图片反推请求失败，请检查分析接口地址与网络连接')
    throw error
  } finally { scope.close() }
}
