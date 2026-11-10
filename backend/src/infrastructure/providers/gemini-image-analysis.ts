import { acquireModelChannel, modelChannelIdentity, type ModelChannelLease } from './model-channel.js'
import { readTextErrorBody } from './text-transport-boundary.js'
import { modelStepSignal } from '../../modules/generation/model-execution.js'
import { currentModelRequestContext } from '../../modules/generation/model-task-policy.js'
import { beginTextRequest } from './text-request-usage.js'
import { estimateTextRequestTokens } from './text-context.js'
import { textRequestTrace, notifyTextRequest } from './text-request-plan.js'
import { TextOutputLimitError, TextProviderError, annotateTextFailure, transientTextNetworkError, transientTextStatus, textRetryAfter } from './text-errors.js'
import { geminiImageAnalysisConfig } from '@video-studio/shared/models/image-analysis-settings'
import { createStreamScope, generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'
import type { GenerationModel, GenerationProvider, TextStreamRequest, TextRequestMetrics } from './providers.js'

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

function visibleText(payload: ObjectValue, metrics: TextRequestMetrics): string {
  if (payload.task_id) throw new Error('当前接口返回了异步生图任务，图片反推需要支持同步 TEXT 输出的 Gemini 接口')
  const blocked = object(payload.promptFeedback).blockReason
  if (blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED') throw new TextProviderError('Gemini 未返回提示词：输入图片或要求被上游拦截', false, 'content_filter')
  const candidate = object(Array.isArray(payload.candidates) ? payload.candidates[0] : undefined)
  metrics.raw_reason = typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined
  if (candidate.finishReason === 'MAX_TOKENS') {
    const parts = object(candidate.content).parts
    const partial = Array.isArray(parts) ? parts.map(object).filter(part => part.thought !== true).map(part => typeof part.text === 'string' ? part.text : '').join('') : ''
    const failure = new TextOutputLimitError(partial, 'max_output_tokens', metrics)
    failure.rawReason = 'MAX_TOKENS'
    throw failure
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new TextProviderError('Gemini 未完整返回提示词，请调整图片或反推要求', false, String(candidate.finishReason))
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
  decodeKey?: (provider: GenerationProvider) => string, signal?: AbortSignal,
  callbacks: { onDispatch?: (metrics: TextRequestMetrics) => void; onMetrics?: (metrics: TextRequestMetrics) => void } = {}): Promise<string> {
  signal = modelStepSignal(signal)
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
  const metrics: TextRequestMetrics = { ...textRequestTrace(), request_purpose: currentModelRequestContext()?.policy.purpose ?? 'image_analysis',
    model_id: model.id, remote_id: config.remote_id || model.remote_id, endpoint: new URL(url).origin + new URL(url).pathname,
    request_bytes: Buffer.byteLength(JSON.stringify(body)), estimated_input_tokens: estimateTextRequestTokens({ prompt: request.prompt }) + 4096, delivery: 'not_sent' }
  let channel: ModelChannelLease | undefined
  let usage: ReturnType<typeof beginTextRequest> | undefined
  const scope = createStreamScope(signal, { totalMs: generationStepBudgets.discussion, totalMessage: 'Gemini 图片反推请求超时，请重试或更换看图模型' })
  const clean = (value: string) => (key ? value.split(key).join('[已隐藏]') : value)
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[图片数据已隐藏]')
    .replace(/("data"\s*:\s*")[A-Za-z0-9+/=]{64,}/g, '$1[图片数据已隐藏]')
  try {
    channel = await acquireModelChannel(modelChannelIdentity(config.api_base_url || provider.base_url, 'gemini_generate_content',
      provider.auth_header || 'Authorization', key ? `${provider.auth_prefix ?? 'Bearer '}${key}` : ''), scope.signal)
    scope.signal.throwIfAborted()
    usage = beginTextRequest({ request_bytes: metrics.request_bytes, estimated_input_tokens: metrics.estimated_input_tokens! })
    notifyTextRequest('dispatch', { ...metrics }, callbacks.onDispatch)
    metrics.delivery = 'unknown'
    const started = Date.now()
    const response = await scope.wait(fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: scope.signal, redirect: 'error' }))
    channel.response(response); scope.touch(); metrics.first_event_ms = Date.now() - started; metrics.http_status = response.status; metrics.delivery = response.ok ? 'accepted' : 'rejected'
    const requestId = response.headers.get('x-request-id') || response.headers.get('request-id')
    if (requestId && /^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) metrics.upstream_request_id = requestId
    const raw = response.ok ? await scope.wait(boundedResponse(response)) : await readTextErrorBody(response, { wait: scope.wait })
    let payload: ObjectValue = {}
    try { payload = object(JSON.parse(raw)) } catch { /* Report a safe transport error below. */ }
    if (!response.ok || payload.error) {
      const detail = object(payload.error).message
      const rawCode = object(payload.error).status ?? object(payload.error).code
      throw new TextProviderError(`Gemini 反推接口返回 HTTP ${response.status}${typeof detail === 'string' ? `：${clean(detail).slice(0, 600)}` : '，请检查分析接口地址、模型 ID 和提供商认证'}`, transientTextStatus(response.status, String(rawCode ?? '')), typeof rawCode === 'string' ? rawCode : undefined, response.status, undefined, textRetryAfter(response.headers.get('retry-after')))
    }
    scope.signal.throwIfAborted()
    const tokens = object(payload.usageMetadata)
    const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    if (integer(tokens.promptTokenCount)) metrics.input_tokens = tokens.promptTokenCount
    if (integer(tokens.thoughtsTokenCount)) metrics.reasoning_tokens = tokens.thoughtsTokenCount
    if (integer(tokens.candidatesTokenCount)) metrics.output_tokens = tokens.candidatesTokenCount + (metrics.reasoning_tokens || 0)
    if (integer(tokens.cachedContentTokenCount)) metrics.cache_read_tokens = tokens.cachedContentTokenCount
    const text = visibleText(payload, metrics)
    metrics.response_chars = text.length; metrics.output_started = !!text; metrics.delivery = 'completed'
    return text
  } catch (issue) {
    channel?.failure(issue)
    if (scope.signal.aborted) { metrics.failure_reason = 'cancelled'; throw scope.signal.reason }
    const failure = !scope.signal.aborted && !(issue instanceof TextProviderError) && transientTextNetworkError(issue)
      ? new TextProviderError('Gemini 反推连接中断，请核对当前任务后继续。', true, 'connection_error', undefined, { cause: issue }) : issue
    if (failure instanceof TextOutputLimitError) metrics.response_chars = failure.partialText.length
    annotateTextFailure(failure, { delivery: failure instanceof TextOutputLimitError ? 'completed' : metrics.delivery ?? 'unknown',
      ...(failure instanceof TextOutputLimitError ? { partialText: failure.partialText } : {}) })
    if (failure instanceof TextProviderError) Object.assign(metrics, { failure_reason: failure.failureReason, raw_reason: failure.rawReason, delivery: failure.delivery, output_started: failure.outputStarted })
    throw failure
  } finally { try { usage?.complete(metrics); notifyTextRequest('metrics', metrics, callbacks.onMetrics) } finally { channel?.release(); scope.close() } }
}
