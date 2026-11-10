import { acquireModelChannel, modelChannelIdentity, type ModelChannelLease } from './model-channel.js'
import { createTextTransportBoundary, textHeadersTimeoutMs, readTextErrorBody, readTextResponseBody } from './text-transport-boundary.js'
import { assertTextFrameBoundary, createTextFrameBoundary } from './text-frame-boundary.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { projectRoot } from '../paths.js'

import sharp from 'sharp'
import type { TextTool, ToolCall, ToolOutput, ToolTurn } from './text-tools.js'
import { createStreamScope, textRequestTimeoutMs, textStreamIdleTimeoutMs, textReasoningIdleTimeoutMs, generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'
import { backgroundTextResponse, hasTextResponseRecovery } from './text-background.js'
import { isUnrestrictedScriptExecution, modelStepSignal } from '../../modules/generation/model-execution.js'
import { applyOutputContract, strictJsonSchema, type OutputContract } from '../../modules/generation/model-output.js'
import { videoReferenceConfigError, videoReferenceMediaError } from '@video-studio/shared/media/video-reference-config'
import { normalizeSeedance25Request, seedance25RequestError, seedance25RequestVariables } from '@video-studio/shared/media/seedance25-request'
import { defaultImageRequestTimeoutSeconds } from '@video-studio/shared/models/images-api-settings'
import { documentedImageConfigError, documentedImageProfile, documentedImageSettings } from '@video-studio/shared/models/documented-images-api'
import { imageMultipartBody, prepareImageReferences } from './image-references.js'
import { generateCompatibleStructuredText, withCompatibleStructuredSettings } from './text-output-capability.js'
import { TextOutputLimitError, TextToolOutputLimitError, TextProviderError, transientTextStatus, transientTextNetworkError, textRetryAfter,
  annotateTextFailure, confirmedContextOverflow, type TextFailureReason, type TextDeliveryState, type TextOutputLimitReason, type TextOutputLimitUsage, type TextOutputLimitKind } from './text-errors.js'
import { prepareTextRequest, textRequestTrace, notifyTextRequest, observeProviderFetch, type ProviderRequestIdentity } from './text-request-plan.js'
import type { TextContextEstimate } from './text-context.js'
import { scopeTextCapabilities, textCapabilitiesConfigError, resolveTextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { resolveTextApiSettings } from '@video-studio/shared/models/text-api-settings'
import { beginTextRequest, isTextRequestBudgetError } from './text-request-usage.js'
import { currentModelRequestContext } from '../../modules/generation/model-task-policy.js'
import { parseTextUsage, requestPurpose, type ParsedTextUsage } from './text-usage-parse.js'
import { withTextImageInput, textImageCapacityBody, type TextImageInput } from './text-image-input.js'
import { withTextVideoInput, textVideoCapacityBody, type TextVideoInput } from './text-video-input.js'
import { applyScriptReviewRequestPolicy } from './text-script-review-policy.js'
import { requestAnthropicText } from './text-anthropic.js'
export { TextOutputLimitError } from './text-errors.js'

export type Modality = 'text' | 'image' | 'video'
export type Adapter = 'http' | 'demo'

export interface GenerationModel {
  id: string
  remote_id: string
  modality: Modality
  settings: Record<string, unknown> | string
  protocol?: 'responses' | 'chat_completions' | 'anthropic_messages' | 'image_generations' | 'async_video'
}

export interface GenerationProvider {
  adapter: Adapter
  base_url: string
  key_ciphertext?: string | null
  auth_header?: string | null
  auth_prefix?: string | null
}

export interface GenerationRequest {
  prompt: string
  structured_output?: OutputContract
  mode?: 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'edit' | 'extend'
  duration?: number
  ratio?: string
  resolution?: string | null
  /** Provider-neutral image controls rendered by request templates. */
  quality?: string | null
  clarity?: string | null
  background?: string | null
  reference_video_url?: string | null
  generate_audio?: boolean
  draft?: boolean
  _external_id?: string | null
}

export interface MediaAsset {
  id?: string
  kind: 'text' | 'image' | 'video' | 'audio'
  path: string
}

export interface GenerationResult {
  path: string
  remoteUrl: string | null
}

/** Events emitted by the provider-neutral text streaming adapter. */
export type TextStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning_summary'; text: string }

export interface TextStreamRequest {
  prompt: string
  images?: TextImageInput[]
  video?: TextVideoInput
  structured_output?: OutputContract
  /** Optional request fields used by configured templates. */
  mode?: 'text'
}

export type TextRequestMetrics = { task_id?: string; step_id?: string; attempt_id?: string; request_id?: string;
  failure_reason?: TextFailureReason; raw_reason?: string; delivery?: TextDeliveryState; output_started?: boolean;
  model_id?: string; remote_id?: string; endpoint?: string; output_parameter?: 'max_output_tokens' | 'max_completion_tokens' | 'max_tokens';
  request_bytes: number; response_chars?: number; first_event_ms?: number;
  input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; output_limit?: number;
  output_limit_reason?: TextOutputLimitReason; output_limit_kind?: TextOutputLimitKind;
  cache_read_tokens?: number; cache_write_tokens?: number; cache_miss_tokens?: number; request_purpose?: string; upstream_request_id?: string; http_status?: number;
  estimated_input_tokens?: number; context_window_tokens?: number; reserved_output_tokens?: number } & TextContextEstimate

function requestId(response: Response) {
  const value = response.headers.get('x-request-id') || response.headers.get('request-id') || ''
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : undefined
}

function usageMetrics(payload: Record<string, unknown>): ParsedTextUsage {
  const response = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : payload
  return response === payload ? parseTextUsage(payload.usage) : { ...parseTextUsage(payload.usage), ...parseTextUsage(response.usage) }
}

function rawUsageMetrics(raw: string): ParsedTextUsage {
  try {
    const payload: unknown = JSON.parse(raw)
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? usageMetrics(payload as Record<string, unknown>) : {}
  } catch { return {} }
}

function outputLimitMetrics(body: unknown, protocol: GenerationModel['protocol']): Pick<TextRequestMetrics, 'output_limit' | 'output_parameter'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const request = body as Record<string, unknown>
  const limit = protocol === 'responses' ? request.max_output_tokens
    : protocol === 'chat_completions' ? request.max_completion_tokens ?? request.max_tokens : protocol === 'anthropic_messages' ? request.max_tokens : undefined
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? { output_limit: limit, output_parameter: protocol === 'responses' ? 'max_output_tokens' : protocol === 'anthropic_messages' ? 'max_tokens' : request.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens' } : {}
}

type Settings = Record<string, unknown>
type Variables = Record<string, unknown>

const dataDir = process.env.VIDEO_STUDIO_DATA_DIR ?? join(projectRoot, 'data')
export const mediaDir = join(dataDir, 'media')
const maxImageBytes = 30 * 1024 * 1024
const maxVideoBytes = 600 * 1024 * 1024
const badResponseBodyDetail = '上游未能返回有效的模型响应体（bad_response_body）'

function asSettings(model: GenerationModel, provider: GenerationProvider): Settings {
  const parsed: unknown = typeof model.settings === 'string' ? JSON.parse(model.settings) : model.settings ?? {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型设置必须是 JSON 对象')
  if (model.modality === 'text') { const issue = textCapabilitiesConfigError(parsed as Settings); if (issue) throw new Error(issue) }
  return model.modality === 'text' ? resolveTextApiSettings(scopeTextCapabilities(parsed as Settings, {
    base_url: typeof (parsed as Settings).api_base_url === 'string' ? (parsed as Settings).api_base_url as string : provider.base_url,
    protocol: model.protocol ?? '', remote_id: model.remote_id,
  }), model.protocol ?? '') : parsed as Settings
}

function settingString(settings: Settings, key: string, fallback?: string): string {
  const value = settings[key]
  if (typeof value === 'string' && value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`模型设置缺少 ${key}`)
}

function apiUrl(base: string, path: string): string {
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('模型接口地址必须使用 HTTP 或 HTTPS')
  if (/^https?:\/\//i.test(path)) throw new Error('接口路径必须是相对路径')
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function httpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('模型结果不是有效的 HTTP 地址')
  return url.toString()
}

function networkCode(error: unknown): string | null {
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, cause, name } = current as { code?: unknown; cause?: unknown; name?: unknown }
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(code)) return code
    if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT'
    current = cause
  }
  return null
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || networkCode(error) !== null
}

function imageNetworkError(stage: '厂商请求' | '结果图片下载', startedAt: number, error: unknown, timeoutMs?: number): Error {
  const code = networkCode(error) ?? 'UNKNOWN'
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const advice = stage === '厂商请求'
    ? '厂商可能已计费，请先核对厂商记录，再手动创建新的生成任务。'
    : '图片已生成，可重试下载现有结果，不会再次请求厂商生成。'
  const timeout = code === 'TIMEOUT' && timeoutMs ? `；最长等待：${Math.round(timeoutMs / 1000)} 秒` : ''
  return new Error(`图片任务网络失败（阶段：${stage}；错误码：${code}；耗时：${seconds} 秒${timeout}）。${advice}`)
}

function textHttpError(response: Response, raw: string, url: string, startedAt: number, model: string,
  authValues: string[] = []): Error & { diagnostics: string; statusCode: number } {
  const secrets = authValues.flatMap(value => [value, value.replace(/^\S+\s+/, '')]).filter(value => value.length >= 6)
  const clean = (value: string) => secrets.reduce((text, secret) => text.split(secret).join('[已隐藏]'), value)
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:api_key|key|token)=)[^&\s"'<>]+/gi, '$1[已隐藏]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[图片数据已隐藏]')
    .replace(/data:video\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[视频数据已隐藏]')
  let message = raw.trim(), upstreamCode = ''
  try {
    const payload = JSON.parse(message) as Record<string, unknown>
    const error = payload?.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : payload
    if (typeof error?.code === 'string') upstreamCode = error.code
    else if (typeof error?.type === 'string') upstreamCode = error.type
    const detail = error?.message ?? error?.detail ?? payload?.error
    if (upstreamCode === 'bad_response_body') message = badResponseBodyDetail
    else if (typeof detail === 'string' && detail.trim()) {
      message = detail
      if (upstreamCode) message += `\n错误码：${upstreamCode}`
    }
  } catch { /* Retain non-JSON upstream errors. */ }
  if (/^\s*(?:<!doctype|<html)/i.test(message)) message = message
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!message) message = response.status === 502
    ? '上游网关未能取得有效响应，返回了空响应体，未提供具体原因。'
    : '上游返回了空响应体，未提供具体原因。'
  const endpoint = new URL(url)
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-amzn-requestid') || response.headers.get('cf-ray')
  const diagnostics = clean([
    `上游状态：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    `模型：${model}`,
    `接口：${endpoint.origin}${endpoint.pathname}`,
    `耗时：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
    `上游请求编号：${requestId ? requestId.replace(/[\r\n\t]/g, ' ').slice(0, 160) : '未返回'}`,
  ].join('\n'))
  const failure = Object.assign(new TextProviderError(`模型接口返回 ${response.status}: ${clean(message).slice(0, 800)}\n${diagnostics}`,
    transientTextStatus(response.status, upstreamCode) && !confirmedContextOverflow(response.status, upstreamCode, message), upstreamCode || undefined, response.status, undefined, textRetryAfter(response.headers.get('retry-after'))), { diagnostics, delivery: 'rejected' as const })
  if (confirmedContextOverflow(response.status, upstreamCode, message)) { failure.failureReason = 'context_overflow' }
  return failure
}

async function requestJson(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown,
  modality?: Modality, model = '', timeoutMs = modality === 'text' ? textRequestTimeoutMs : 90_000, parentSignal?: AbortSignal, identity: ProviderRequestIdentity = {}): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  parentSignal = modelStepSignal(parentSignal)
  parentSignal?.throwIfAborted()
  let response: Response
  let raw: string
  try {
    response = await observeProviderFetch(url, {
      method,
      headers: { ...headers, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }, method === 'GET' ? 'media_poll' : 'media_create', fetch, { ...identity, ...(body && typeof body === 'object' && !(body instanceof FormData) && typeof (body as Settings).model === 'string' ? { remote_id: (body as Settings).model as string } : {}) })
    raw = response.ok ? await response.text() : await readTextErrorBody(response)
  } catch (error) {
    parentSignal?.throwIfAborted()
    if (modality === 'image' && isNetworkFailure(error)) throw imageNetworkError('厂商请求', startedAt, error, timeoutMs)
    if (modality === 'text' && networkCode(error) === 'TIMEOUT') {
      throw new Error(`文本模型请求超时（最长等待 ${Math.round(textRequestTimeoutMs / 60_000)} 分钟），请稍后重试或切换文本模型。`)
    }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!response.ok) {
    if (modality === 'image') {
      const detail = textHttpError(response, raw, url, startedAt, model, Object.values(headers))
      throw new Error(`图片生成请求失败（阶段：厂商请求；HTTP ${response.status}）。\n${detail.message}\n厂商可能已计费，请先核对厂商记录。`)
    }
    if (modality === 'text') throw textHttpError(response, raw, url, startedAt, model, Object.values(headers))
    const message = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : raw
    throw new Error(`模型接口返回 ${response.status}: ${message.slice(0, 800)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型接口没有返回 JSON 对象')
  return parsed as Record<string, unknown>
}

function nested(value: unknown, dotted: string): unknown {
  let current = value
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) throw new Error(`模型响应缺少 ${dotted}`)
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function optionalNested(value: unknown, dotted: string): unknown {
  try { return nested(value, dotted) } catch { return undefined }
}

function isNonAnswerBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const type = (value as Record<string, unknown>).type
  return typeof type === 'string' && /reasoning|thinking|analysis|refusal|tool_call|function_call/i.test(type)
}

function textValue(value: unknown, preserveWhitespace = false): string | null {
  if (typeof value === 'string') return (preserveWhitespace ? value.length : value.trim().length) ? value : null
  if (Array.isArray(value)) {
    const parts = value.map(part => textValue(part, preserveWhitespace)).filter((part): part is string => part !== null)
    return parts.length ? parts.join('\n') : null
  }
  if (!value || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  if (isNonAnswerBlock(object)) return null
  for (const key of ['output_text', 'text', 'content', 'message', 'delta', 'value']) {
    const result = textValue(object[key], preserveWhitespace)
    if (result !== null) return result
  }
  return null
}

function textAtPath(payload: Record<string, unknown>, path: string, preserveWhitespace = false): string | null {
  let current: unknown = payload
  for (const part of path.split('.')) {
    if (isNonAnswerBlock(current) || !current || typeof current !== 'object' || !(part in current)) return null
    if (/^(?:reasoning(?:_content)?|reasoning_summary|thinking|analysis|refusal)$/i.test(part)) return null
    current = (current as Record<string, unknown>)[part]
  }
  return textValue(current, preserveWhitespace)
}

function responseText(payload: Record<string, unknown>, settings: Settings, protocol?: GenerationModel['protocol']): string {
  const paths = Array.isArray(settings.text_paths)
    ? settings.text_paths.filter((value): value is string => typeof value === 'string' && !!value)
    : typeof settings.text_path === 'string' && settings.text_path ? [settings.text_path] : []
  if (!paths.length) throw new Error('文本模型必须配置 text_path 或 text_paths')
  for (const path of paths) {
    const selected = textAtPath(payload, path)
    if (selected !== null) return selected
  }
  if (protocol === 'responses') {
    const selected = textValue(payload.output)
    if (selected !== null) return selected
  }
  throw new Error(`模型响应没有符合配置路径的文本：${paths.join(', ')}`)
}

function streamTextPaths(settings: Settings): string[] {
  const configured = Array.isArray(settings.stream_text_paths)
    ? settings.stream_text_paths.filter((value): value is string => typeof value === 'string' && !!value)
    : []
  if (configured.length) return configured
  const paths = Array.isArray(settings.text_paths)
    ? settings.text_paths.filter((value): value is string => typeof value === 'string' && !!value)
    : typeof settings.text_path === 'string' && settings.text_path ? [settings.text_path] : []
  // A provider often uses a different path for a delta than for the final message.
  const derived = paths.flatMap((path) => {
    const variants = [path]
    if (path.includes('.message.')) variants.push(path.replace('.message.', '.delta.'))
    if (path.endsWith('.message')) variants.push(`${path.slice(0, -'.message'.length)}.delta`)
    return variants
  })
  return [...derived, 'choices.0.delta.content', 'choices.0.text', 'output_text', 'response.output_text.delta', 'delta', 'content']
}

function streamTextValue(payload: Record<string, unknown>, settings: Settings): string | null {
  // Some Responses-style streams put every event's payload in `delta`. Do not
  // let a reasoning/thinking event fall through to that generic path.
  const eventType = payload.type
  if (typeof eventType === 'string' && /reasoning|thinking|analysis/i.test(eventType)) return null
  for (const path of streamTextPaths(settings)) {
    // A delta can consist entirely of whitespace inside a JSON string or
    // editable prose. Dropping it changes already checkpointed documents and
    // makes the provider's terminal snapshot appear to rewrite their content.
    const selected = textAtPath(payload, path, true)
    if (selected !== null) return selected
  }
  return null
}

function reasoningSummaryValue(payload: Record<string, unknown>): string | null {
  // Only provider supplied summaries are allowed. Raw reasoning_content/thinking
  // fields are intentionally ignored so private chain-of-thought is not exposed.
  for (const key of ['reasoning_summary', 'reasoning_summary_text', 'analysis_summary']) {
    const value = textValue(payload[key])
    if (value) return value
  }
  return null
}

function streamBodyVariables(settings: Settings, request: TextStreamRequest, model: GenerationModel): Variables {
  const variables = modeVariables(settings, { prompt: request.prompt, mode: 'text' })
  variables.model = model.remote_id
  variables.stream = true
  return variables
}

function streamRequestTemplate(settings: Settings): unknown {
  return settings.stream_request_template ?? settings.request_template
}

function parseStreamPayload(raw: string): Record<string, unknown> | null {
  const value = raw.trim()
  if (!value || value === '[DONE]') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function responseFailureDetail(payload: Record<string, unknown>) {
  const response = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : payload
  const incomplete = response.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as Record<string, unknown> : {}
  const error = response.error && typeof response.error === 'object' ? response.error as Record<string, unknown>
    : payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {}
  const reason = typeof incomplete.reason === 'string' ? incomplete.reason : ''
  const code = typeof error.code === 'string' ? error.code : ''
  const known: Record<string, string> = {
    max_output_tokens: '已达到模型输出长度上限',
    content_filter: '输出被内容审核中断',
    rate_limit_exceeded: '模型服务达到请求速率限制',
    server_error: '模型服务中断',
    bad_response_body: badResponseBodyDetail,
  }
  if (known[reason]) return known[reason]
  if (reason && /^[a-z0-9_.-]{1,64}$/i.test(reason)) return `上游原因：${reason}`
  if (known[code]) return known[code]
  if (code && /^[a-z0-9_.-]{1,64}$/i.test(code)) return `上游错误：${code}`
  return ''
}

function responseEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : payload
}

function terminalTextValue(payload: Record<string, unknown>, settings?: Settings): string | null {
  const response = responseEnvelope(payload)
  const paths = Array.isArray(settings?.text_paths) ? settings.text_paths
    : typeof settings?.text_path === 'string' ? [settings.text_path] : []
  for (const path of paths) {
    if (typeof path !== 'string' || !path) continue
    const selected = textAtPath(payload, path) ?? textAtPath(response, path)
    if (selected !== null) return selected
  }
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  return textValue(response.output_text) ?? textValue(response.output) ?? textValue(choice?.message) ?? textValue(choice?.text)
}

function textOutputLimitReason(payload: Record<string, unknown>): TextOutputLimitReason | undefined {
  const incomplete = responseEnvelope(payload).incomplete_details as Record<string, unknown> | undefined
  const finish = (payload.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason
  return incomplete?.reason === 'max_output_tokens' ? 'max_output_tokens' : finish === 'length' ? 'length' : undefined
}

function limitUsage(metrics: TextOutputLimitUsage): TextOutputLimitUsage {
  return { ...(metrics.input_tokens === undefined ? {} : { input_tokens: metrics.input_tokens }),
    ...(metrics.output_tokens === undefined ? {} : { output_tokens: metrics.output_tokens }),
    ...(metrics.reasoning_tokens === undefined ? {} : { reasoning_tokens: metrics.reasoning_tokens }) }
}

const usageFooterExpired = Symbol('optional usage footer deadline')
/** A terminal failure is already known. Collect optional billing metadata for
 * at most one second, even in an otherwise unrestricted script execution. */
function createUsageFooterWait() {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof usageFooterExpired>(resolve => { timer = setTimeout(() => resolve(usageFooterExpired), 1000) })
  return { wait: <T>(read: Promise<T>) => Promise.race([read, expired]), close: () => clearTimeout(timer) }
}

function recordLimitFailure(metrics: TextRequestMetrics, failure: TextProviderError) {
  if (failure instanceof TextOutputLimitError || failure instanceof TextToolOutputLimitError) {
    metrics.output_limit_reason = failure.reason
    metrics.output_limit_kind = failure.outputLimitKind
  }
  return failure
}

function textResponseFailure(payload: Record<string, unknown>, partialText: string, toolCall = false,
  usage: TextOutputLimitUsage = usageMetrics(payload), outputLimit?: number): TextProviderError | undefined {
  const response = responseEnvelope(payload)
  const incomplete = response.incomplete_details as Record<string, unknown> | undefined
  const finish = (payload.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason
  const limit = textOutputLimitReason(payload)
  // Function-call arguments are never continued or executed after truncation.
  if (limit) return toolCall ? new TextToolOutputLimitError(limit, limitUsage(usage), outputLimit, partialText)
    : new TextOutputLimitError(partialText, limit, limitUsage(usage), outputLimit)
  const choice = (payload.choices as Array<{ message?: { refusal?: string }; delta?: { refusal?: string } }> | undefined)?.[0]
  const outputRefusal = Array.isArray(response.output) && response.output.some(item => item && typeof item === 'object' && Array.isArray(item.content) && item.content.some((block: { type?: string }) => block?.type === 'refusal'))
  if (choice?.message?.refusal || choice?.delta?.refusal || outputRefusal) return new TextProviderError('模型拒绝返回本次内容', false, 'refusal')
  const status = String(response.status || '')
  if (payload.error || payload.type === 'response.failed' || payload.type === 'response.incomplete' || ['failed', 'incomplete', 'cancelled'].includes(status)) {
    const detail = responseFailureDetail(payload)
    const error = (response.error || payload.error) as Record<string, unknown> | undefined
    const code = typeof error?.code === 'string' ? error.code : ''
    const reason = typeof incomplete?.reason === 'string' ? incomplete.reason : ''
    return new TextProviderError(`模型${toolCall ? '工具调用' : '生成'}失败或输出不完整${detail ? `：${detail}` : '，请检查已收到内容后重试'}`,
      !reason && ['server_error', 'rate_limit_exceeded', 'service_unavailable', 'overloaded_error'].includes(code), reason || code || undefined)
  }
  if (finish && !['stop', ...(toolCall ? ['tool_calls'] : [])].includes(finish)) {
    return new TextProviderError(finish === 'content_filter' ? '模型输出被内容审核中断' : `模型输出被截断或异常结束${toolCall ? '，未执行工具调用' : ''}`, false, finish)
  }
}

function hasTerminalText(payload: Record<string, unknown>): boolean {
  const response = responseEnvelope(payload)
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  return typeof response.status === 'string' && ['completed', 'incomplete', 'failed', 'cancelled'].includes(response.status)
    || ['response.completed', 'response.incomplete', 'response.failed'].includes(String(payload.type)) || !!choice?.message
}

/** Native function calls use the configured endpoint, auth and model options,
 * while reserving the protocol fields needed to relay actual tool results. */
export function publicToolText(raw: string): string {
  let output = raw.replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, '')
  const start = output.lastIndexOf('<'), tail = output.slice(start).toLowerCase()
  if (start >= 0 && !tail.includes('>') && (['<think', '<thinking', '<analysis', '<reasoning'].some(tag => tag.startsWith(tail)) || /^<\/?(?:think(?:ing)?|analysis|reasoning)\b/.test(tail))) output = output.slice(0, start)
  return output
}

export async function createTextToolTransport(model: GenerationModel, provider: GenerationProvider, prompt: string,
  tools: TextTool[], previous: unknown[] | undefined, outputs: ToolOutput[],
  resolveKey: (provider: GenerationProvider) => string, signal?: AbortSignal, onText?: (text: string) => void, continuation?: string,
  onMetrics?: (metrics: TextRequestMetrics) => void, options: { parallelCalls?: boolean; onDispatch?: (metrics: TextRequestMetrics) => void } = {}): Promise<ToolTurn> {
  if (provider.adapter === 'demo' || model.modality !== 'text') throw new Error('工具调用需要可用的文本模型')
  const protocol = model.protocol
  if (protocol !== 'responses' && protocol !== 'chat_completions' && protocol !== 'anthropic_messages') throw new Error('当前文本协议不支持工具调用')
  const settings = asSettings(model, provider)
  if (resolveTextCapabilities(settings).compatibility.tools === false) throw new TextProviderError('当前渠道已声明不支持工具调用', false, 'unsupported_tools')
  const variables = streamBodyVariables(settings, { prompt }, model)
  const template = streamRequestTemplate(settings)
  const rendered = compactTemplate(renderTemplate(template, variables))
  if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) throw new Error('工具调用需要对象形式的请求模板')
  const base = rendered as Record<string, unknown>
  if (protocol === 'anthropic_messages') {
    const result = await requestAnthropicText({ model, provider, settings, base,
      url: apiUrl(settingString(settings, 'api_base_url', provider.base_url), settingString(settings, 'request_path')), key: resolveKey(provider),
      request: { prompt }, signal, onMetrics, onDispatch: options.onDispatch, httpError: textHttpError,
      tool: { tools, previous, outputs, continuation, parallelCalls: options.parallelCalls, onText: text => onText?.(publicToolText(text)) } })
    return { ...result.turn!, text: publicToolText(result.text) }
  }
  const initial = protocol === 'responses' ? Array.isArray(base.input) ? base.input : typeof base.input === 'string' ? [{ role: 'user', content: base.input }] : []
    : Array.isArray(base.messages) ? base.messages : []
  if (!initial.length) throw new Error(`工具调用需要请求模板中的 ${protocol === 'responses' ? 'input' : 'messages'} 字段`)
  const history = [...(previous || initial), ...outputs.map(item => protocol === 'responses'
    ? { type: 'function_call_output', call_id: item.id, output: item.output }
    : { role: 'tool', tool_call_id: item.id, content: item.output }), ...(continuation ? [{ role: 'user', content: continuation }] : [])]
  // A task-specific text response format must not compete with tool arguments.
  delete base.response_format
  if (base.text && typeof base.text === 'object') { base.text = { ...base.text as Record<string, unknown> }; delete (base.text as Record<string, unknown>).format }
  const strict = settings.strict_tool_arguments === true
  let body: Record<string, unknown> = { ...base, stream: settings.stream !== false && base.stream !== false, tool_choice: 'auto', parallel_tool_calls: options.parallelCalls === true,
    tools: tools.map(tool => { const selected = { name: tool.name, description: tool.description, parameters: strict ? strictJsonSchema(tool.parameters) : tool.parameters, strict }; return protocol === 'responses' ? { type: 'function', ...selected } : { type: 'function', function: selected } }),
    ...(protocol === 'responses' ? { input: history } : { messages: history, n: 1 }) }
  if (protocol === 'responses' && resolveTextCapabilities(settings).compatibility.encrypted_reasoning === true) { body.store = false; body.include = [...new Set([...(Array.isArray(body.include) ? body.include as string[] : []), 'reasoning.encrypted_content'])] }
  if (protocol === 'chat_completions' && body.stream === true && resolveTextCapabilities(settings).compatibility.stream_usage === true) body.stream_options = { ...(body.stream_options as Record<string, unknown> || {}), include_usage: true }
  const key = resolveKey(provider)
  const requestUrl = apiUrl(settingString(settings, 'api_base_url', provider.base_url), settingString(settings, 'request_path'))
  const planned = await prepareTextRequest(settings, body, protocol, { modelId: model.id, purpose: 'tool_decision', url: requestUrl, signal: modelStepSignal(signal),
    headers: key ? { [provider.auth_header || 'Authorization']: `${provider.auth_prefix ?? 'Bearer '}${key}` } : {} })
  body = planned.body as Record<string, unknown>
  const capacity = planned.capacity
  const requestBody = JSON.stringify(body)
  const metrics: TextRequestMetrics = { ...textRequestTrace(), model_id: model.id, remote_id: typeof body.model === 'string' ? body.model : model.remote_id, endpoint: new URL(requestUrl).origin + new URL(requestUrl).pathname, delivery: 'not_sent', request_bytes: Buffer.byteLength(requestBody), request_purpose: currentModelRequestContext()?.policy.purpose ?? 'tool_decision', ...outputLimitMetrics(body, protocol), ...capacity }
  const startedAt = Date.now()
  const scope = createStreamScope(modelStepSignal(signal), { totalMs: isUnrestrictedScriptExecution() ? null : generationStepBudgets.discussion,
    idleMessage: '模型接口长时间没有返回事件，当前步骤已停止，已完成结果保留。',
    totalMessage: '当前工具决策请求超时（5 分钟），已保留完成步骤，请检查后继续。' })
  const streaming = body.stream === true && settings.stream !== false
  const eventTimeout = !streaming || settings.reasoning_effort || body.reasoning_effort || body.reasoning || body.thinking ? textReasoningIdleTimeoutMs : textStreamIdleTimeoutMs
  const transport = createTextTransportBoundary(scope, { autoStart: false, headersMs: streaming ? textHeadersTimeoutMs : textRequestTimeoutMs,
    firstEventMs: eventTimeout, idleMs: isUnrestrictedScriptExecution() ? undefined : eventTimeout })
  let channel: ModelChannelLease | undefined
  let usageRequest: ReturnType<typeof beginTextRequest> | undefined
  let partialVisibleText = ''
  try {
    scope.signal.throwIfAborted()
    channel = await acquireModelChannel(modelChannelIdentity(settingString(settings, 'api_base_url', provider.base_url), protocol,
      provider.auth_header || 'Authorization', key ? `${provider.auth_prefix ?? 'Bearer '}${key}` : ''), transport.signal)
    transport.signal.throwIfAborted(); transport.start()
    usageRequest = beginTextRequest({ request_bytes: metrics.request_bytes, estimated_input_tokens: capacity.estimated_input_tokens,
      reserved_output_tokens: metrics.output_limit ?? capacity.reserved_output_tokens })
    // Record what is being sent before waiting on the network, so a cancelled or
    // interrupted request still carries its purpose and size.
    notifyTextRequest('dispatch', { ...metrics }, options.onDispatch)
    metrics.delivery = 'unknown'
    const response = await transport.wait(fetch(requestUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json',
        ...(key ? { [provider.auth_header || 'Authorization']: `${provider.auth_prefix ?? 'Bearer '}${key}` } : {}) },
      body: requestBody,
      signal: transport.signal,
    }))
    transport.headers(); channel.response(response)
    metrics.http_status = response.status
    metrics.delivery = response.ok ? 'accepted' : 'rejected'
    metrics.upstream_request_id = requestId(response)
    if (!response.ok) {
      const raw = await readTextErrorBody(response, { wait: transport.wait, onChunk: transport.event })
      Object.assign(metrics, rawUsageMetrics(raw))
      throw textHttpError(response, raw, requestUrl, startedAt, model.remote_id,
        key ? [`${provider.auth_prefix ?? 'Bearer '}${key}`] : [])
    }
    const chatMessage: Record<string, unknown> = { role: 'assistant', content: '' }
    const chatCalls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
    let finalOutput: Array<Record<string, unknown>> = []
    const responseItems = new Map<number, Record<string, unknown>>()
    let text = ''
    let completed = false
    let streamEnded = false
    let outputLimitPayload: Record<string, unknown> | undefined
    let footerWait: ReturnType<typeof createUsageFooterWait> | undefined
    const awaitUsageFooter = protocol === 'chat_completions' &&
      (body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true
    let finishReason: unknown
    const markPayload = (payload: Record<string, unknown>) => {
      transport.event()
      metrics.first_event_ms ??= Date.now() - startedAt
      Object.assign(metrics, usageMetrics(payload))
    }
    const publish = (value: string) => { partialVisibleText = value; metrics.output_started = !!value; const visible = publicToolText(value); if (visible.trim()) onText?.(visible) }
    const consume = (payload: Record<string, unknown>) => {
      scope.touch()
      markPayload(payload)
      // After truncation, only token usage may be consumed. Later text or
      // calls cannot change the failed turn into an executable response.
      if (outputLimitPayload) { if (usageMetrics(payload).output_tokens !== undefined) streamEnded = true; return }
      const snapshot = terminalTextValue(payload, settings)
      const terminalDelta = (payload.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content
      const partial = snapshot ?? (protocol === 'responses' ? text : String(chatMessage.content || '')) + (typeof terminalDelta === 'string' ? terminalDelta : '')
      const failure = textResponseFailure(payload, partial, true, metrics, metrics.output_limit)
      if (failure) {
        text = partial
        metrics.response_chars = text.length
        if (textOutputLimitReason(payload)) {
          outputLimitPayload = payload
          recordLimitFailure(metrics, failure)
          streamEnded = usageMetrics(payload).output_tokens !== undefined
          return
        }
        throw failure
      }
      if (protocol === 'responses') {
        if (payload.type === 'response.output_item.done') responseItems.set(Number(payload.output_index), payload.item as Record<string, unknown>)
        if (payload.type === 'response.completed') { finalOutput = (payload.response as { output?: typeof finalOutput })?.output || []; completed = true; streamEnded = true }
        if (Array.isArray(payload.output)) { finalOutput = payload.output as typeof finalOutput; completed = true }
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') { text += payload.delta; publish(text) }
        if (typeof payload.output_text === 'string') text = payload.output_text
        return
      }
      const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
      if (!choice) return
      if (choice.finish_reason) { metrics.raw_reason = String(choice.finish_reason); finishReason = choice.finish_reason; completed = true; streamEnded = !awaitUsageFooter }
      const message = choice.message as Record<string, unknown> | undefined
      if (message) { Object.assign(chatMessage, message, { role: 'assistant' }); completed = true; return }
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) return
      if (typeof delta.content === 'string') { chatMessage.content = String(chatMessage.content || '') + delta.content; publish(String(chatMessage.content)) }
      if (typeof delta.reasoning_content === 'string') chatMessage.reasoning_content = String(chatMessage.reasoning_content || '') + delta.reasoning_content
      for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> : []) {
        const call = chatCalls.get(item.index) || { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
        if (item.id) call.id = item.id
        if (item.function?.name) call.function.name += item.function.name
        if (item.function?.arguments) { call.function.arguments += item.function.arguments; metrics.output_started = true }
        chatCalls.set(item.index, call)
      }
    }
    if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      const frameBoundary = createTextFrameBoundary()
      try {
        while (!streamEnded) {
          let next: ReadableStreamReadResult<Uint8Array> | typeof usageFooterExpired
          try { next = await transport.wait(outputLimitPayload ? (footerWait ??= createUsageFooterWait()).wait(reader.read()) : reader.read()) }
          catch (issue) { if (outputLimitPayload && !scope.signal.aborted) break; throw issue }
          if (next === usageFooterExpired) break
          const { done, value } = next
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; assertTextFrameBoundary(buffer)
          for (const line of lines) {
            frameBoundary.line(line); assertTextFrameBoundary(line)
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              if (data === '[DONE]') streamEnded = true
              else { const payload = parseStreamPayload(data); if (payload) consume(payload) }
            }
            if (streamEnded) break
          }
          if (!streamEnded) frameBoundary.pending(buffer)
          if (done) break
        }
        if (!streamEnded && buffer.startsWith('data:')) { const payload = parseStreamPayload(buffer.slice(5)); if (payload) consume(payload) }
      } finally { footerWait?.close(); void reader.cancel().catch(() => {}); reader.releaseLock() }
      if (outputLimitPayload) throw recordLimitFailure(metrics, textResponseFailure(outputLimitPayload, text, true, metrics, metrics.output_limit)!)
      if (!completed) throw new TextProviderError('模型工具调用连接提前结束，未执行未完成的调用；可继续当前任务。', true, 'stream_disconnected')
    } else consume(JSON.parse(await readTextResponseBody(response, { wait: transport.wait, onChunk: transport.event })) as Record<string, unknown>)
    if (outputLimitPayload) throw recordLimitFailure(metrics, textResponseFailure(outputLimitPayload, text, true, metrics, metrics.output_limit)!)
    if (!completed) throw new Error('模型未返回完整的工具调用结果')
    if (finishReason && !['stop', 'tool_calls'].includes(String(finishReason))) throw new Error('模型输出被截断或异常结束，未执行工具调用')
    let calls: ToolCall[]
    if (protocol === 'responses') {
      if (!finalOutput.length) finalOutput = [...responseItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
      text = textValue(finalOutput) || text
      calls = finalOutput.filter(item => item.type === 'function_call').map(item => ({ id: String(item.call_id || ''), name: String(item.name || ''), arguments: String(item.arguments || '') }))
      history.push(...finalOutput)
    } else {
      if (chatCalls.size) chatMessage.tool_calls = [...chatCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      text = textValue(chatMessage.content) || ''
      calls = (Array.isArray(chatMessage.tool_calls) ? chatMessage.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> : []).map(item => ({ id: item.id, name: item.function?.name, arguments: item.function?.arguments }))
      history.push(chatMessage)
    }
    if (calls.some(call => { try { const args: unknown = JSON.parse(call.arguments); return !args || typeof args !== 'object' || Array.isArray(args) } catch { return true } })) throw new TextProviderError('模型返回的工具参数不完整，未执行调用', false, 'invalid_tool_call')
    if (calls.length > 10 || calls.some(call => !call.id || !call.name || typeof call.arguments !== 'string' || call.arguments.length > 650_000) || new Set(calls.map(call => call.id)).size !== calls.length) throw new TextProviderError('模型返回了无效的工具调用', false, 'invalid_tool_call')
    metrics.response_chars = text.length + calls.reduce((total, call) => total + call.arguments.length, 0)
    metrics.delivery = 'completed'
    return { text: publicToolText(text), calls, history, initial_history_length: initial.length, metrics }
  } catch (issue) {
    channel?.failure(issue)
    if (scope.signal.aborted) { metrics.failure_reason = scope.signal.reason?.name === 'AbortError' ? 'cancelled' : 'disconnected'; metrics.raw_reason = scope.signal.reason?.kind; throw scope.signal.reason }
    const failure = !scope.signal.aborted && !(issue instanceof TextProviderError) && transientTextNetworkError(issue)
      ? new TextProviderError('模型接口连接中断，未完成的工具调用未执行；可继续当前任务。', true, 'connection_error', undefined, { cause: issue }) : issue
    annotateTextFailure(failure, { delivery: failure instanceof TextToolOutputLimitError ? 'completed' : metrics.output_started ? 'output_started' : metrics.delivery ?? 'unknown', partialText: partialVisibleText, tool: true })
    if (failure instanceof TextProviderError) Object.assign(metrics, { failure_reason: failure.failureReason, raw_reason: failure.rawReason, delivery: failure.delivery })
    throw failure
  } finally {
    try { usageRequest?.complete(metrics); notifyTextRequest('metrics', metrics, onMetrics) }
    finally { channel?.release(); transport.close(); scope.close() }
  }
}

/**
 * Stream a configured text provider response. The provider configuration remains
 * the source of truth for URL, payload and extraction paths. Providers that do
 * not return a streaming body are handled as a single delta.
 */
export async function streamText(
  model: GenerationModel,
  provider: GenerationProvider,
  request: TextStreamRequest,
  resolveApiKey?: (provider: GenerationProvider) => string | Promise<string>,
  onEvent: (event: TextStreamEvent) => void | Promise<void> = () => {},
  signal?: AbortSignal,
  onMetrics?: (metrics: TextRequestMetrics) => void,
  onDispatch?: (metrics: TextRequestMetrics) => void,
  /** An already rendered non-streaming jobs request; do not render source text twice. */
  wireBody?: unknown,
): Promise<string> {
  if (provider.adapter === 'demo') throw new Error('演示模型已停用')
  if (model.modality !== 'text') throw new Error('流式调用只支持文本模型')
  const settings = asSettings(model, provider)
  if (request.structured_output && !settings.structured_output_mode) {
    return generateCompatibleStructuredText(model, provider, request.prompt, request.structured_output, signal,
      (configured, target, prompt, contract, requestSignal) => streamText(configured, target, { ...request, prompt, structured_output: contract }, resolveApiKey, onEvent, requestSignal, onMetrics, onDispatch, wireBody))
  }
  if (model.protocol === 'anthropic_messages') {
    const rendered = wireBody ?? compactTemplate(renderTemplate(streamRequestTemplate(settings), streamBodyVariables(settings, request, model)))
    return (await requestAnthropicText({ model, provider, settings, base: rendered,
      url: apiUrl(settingString(settings, 'api_base_url', provider.base_url), settingString(settings, 'request_path')),
      key: (resolveApiKey ? await resolveApiKey(provider) : '') || '', request, onEvent, signal, onMetrics, onDispatch, httpError: textHttpError })).text
  }
  const key = (resolveApiKey ? await resolveApiKey(provider) : '') || ''
  const authHeader = provider.auth_header || 'Authorization'
  const authPrefix = provider.auth_prefix ?? 'Bearer '
  const headers: Record<string, string> = {
    Accept: 'text/event-stream, application/x-ndjson, application/json',
    ...(key ? { [authHeader]: `${authPrefix}${key}` } : {}),
  }
  const variables = streamBodyVariables(settings, request, model)
  const template = streamRequestTemplate(settings)
  const renderedBody = wireBody ?? compactTemplate(renderTemplate(
    template ?? { model: '{{model}}', prompt: '{{prompt}}', stream: true }, variables,
  ))
  // Most OpenAI-compatible providers opt into streaming with a top-level
  // `stream` flag. Add it when the configured template did not specify one;
  // an explicit template value (including false) always wins.
  const requestUrl = apiUrl(settingString(settings, 'api_base_url', provider.base_url), settingString(settings, 'request_path'))
  const body = applyScriptReviewRequestPolicy(withTextVideoInput(withTextImageInput(applyOutputContract(renderedBody && typeof renderedBody === 'object' && !Array.isArray(renderedBody)
    ? { ...(renderedBody as Record<string, unknown>),
      ...((wireBody !== undefined || 'stream' in (renderedBody as Record<string, unknown>) || settings.stream === false)
        ? {} : { stream: true }) }
    : renderedBody, model.protocol, settings, request.structured_output), request.images, model.protocol, settings), request.video, model.protocol, settings),
    { url: requestUrl, remoteId: model.remote_id, protocol: model.protocol, policy: request.structured_output?.request_policy })
  if (model.protocol === 'chat_completions' && (body as Record<string, unknown>).stream === true && resolveTextCapabilities(settings).compatibility.stream_usage === true) {
    const target = body as Record<string, unknown>; target.stream_options = { ...(target.stream_options as Record<string, unknown> || {}), include_usage: true }
  }
  const background = settings.background_responses === true && model.protocol === 'responses' && !!request.structured_output && hasTextResponseRecovery()
  if (model.protocol === 'responses' && resolveTextCapabilities(settings).compatibility.encrypted_reasoning === true) {
    const target = body as Record<string, unknown>
    target.store = false
    target.include = [...new Set([...(Array.isArray(target.include) ? target.include as string[] : []), 'reasoning.encrypted_content'])]
  }
  const outgoing = background ? { ...body as Record<string, unknown>, stream: false, background: true } : body
  const planned = await prepareTextRequest(settings, outgoing, model.protocol, {
    modelId: model.id, purpose: requestPurpose(request.structured_output?.name), url: requestUrl, headers, signal: modelStepSignal(signal),
    estimateBody: (request.images?.length || request.video) ? textVideoCapacityBody(textImageCapacityBody(outgoing)) : outgoing,
    visualInputTokens: (request.images?.length || 0) * 4096 + (request.video ? Math.ceil(request.video.duration_ms / 1000 * (request.video.fps ?? 1)) * 2048 : 0),
  })
  const finalBody = planned.body
  const capacity = planned.capacity
  const requestBody = JSON.stringify(finalBody)
  if (request.video && settings.video_input_format === 'doubao_ark' && Buffer.byteLength(requestBody) >= 64 * 1024 * 1024) throw new Error('豆包视频理解请求体需小于 64 MB，请缩小视频片段或降低分辨率')
  const metrics: TextRequestMetrics = { ...textRequestTrace(), model_id: model.id, remote_id: typeof finalBody.model === 'string' ? finalBody.model : model.remote_id, endpoint: new URL(requestUrl).origin + new URL(requestUrl).pathname, delivery: 'not_sent', request_bytes: Buffer.byteLength(requestBody), request_purpose: currentModelRequestContext()?.policy.purpose ?? requestPurpose(request.structured_output?.name), ...outputLimitMetrics(finalBody, model.protocol), ...capacity }
  let response: Response
  const startedAt = Date.now()
  const scope = createStreamScope(modelStepSignal(signal), { totalMs: isUnrestrictedScriptExecution() ? null : (wireBody !== undefined || request.structured_output) ? textRequestTimeoutMs : generationStepBudgets.discussion,
    idleMessage: '模型接口长时间没有返回事件，当前步骤已停止，已完成结果保留。',
    totalMessage: `文本模型请求超时（最长等待 ${Math.round(((wireBody !== undefined || request.structured_output) ? textRequestTimeoutMs : generationStepBudgets.discussion) / 60_000)} 分钟）。请检查草稿后重试或切换文本模型。` })
  const streaming = finalBody.stream === true && settings.stream !== false
  const eventTimeout = !streaming || background || settings.reasoning_effort || finalBody.reasoning_effort || finalBody.reasoning || finalBody.thinking ? textReasoningIdleTimeoutMs : textStreamIdleTimeoutMs
  const transport = createTextTransportBoundary(scope, { autoStart: false, headersMs: streaming ? textHeadersTimeoutMs : textRequestTimeoutMs,
    firstEventMs: wireBody !== undefined ? textRequestTimeoutMs : eventTimeout,
    idleMs: isUnrestrictedScriptExecution() || wireBody !== undefined ? undefined : eventTimeout })
  let channel: ModelChannelLease | undefined
  let usageRequest: ReturnType<typeof beginTextRequest> | undefined
  let partialVisibleText = ''
  try {
    try {
      scope.signal.throwIfAborted()
      channel = await acquireModelChannel(modelChannelIdentity(settingString(settings, 'api_base_url', provider.base_url), model.protocol || 'custom',
        authHeader, key ? headers[authHeader]! : ''), transport.signal)
      transport.signal.throwIfAborted(); transport.start()
      metrics.delivery = 'unknown'
      if (!background) usageRequest = beginTextRequest({ request_bytes: metrics.request_bytes, estimated_input_tokens: capacity.estimated_input_tokens,
        reserved_output_tokens: metrics.output_limit ?? capacity.reserved_output_tokens })
      notifyTextRequest('dispatch', { ...metrics }, onDispatch, !background)
      response = background
        ? await backgroundTextResponse(requestUrl, finalBody as Record<string, unknown>, { ...headers, 'Content-Type': 'application/json' }, transport.signal, transport.wait, transport.event,
          capacity.reserved_output_tokens, capacity.estimated_input_tokens, { model_id: model.id, remote_id: typeof finalBody.model === 'string' ? finalBody.model : model.remote_id })
        : await transport.wait(fetch(requestUrl, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: requestBody, signal: transport.signal,
        }))
    } catch (error) {
      if (isTextRequestBudgetError(error) || error instanceof TextProviderError) throw error
      scope.signal.throwIfAborted()
      throw new Error(`文本模型流式请求失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    transport.headers(); channel.response(response)
    metrics.http_status = response.status
    metrics.delivery = response.ok ? 'accepted' : 'rejected'
    metrics.upstream_request_id = requestId(response)
    if (!response.ok) {
      const raw = await readTextErrorBody(response, { wait: transport.wait, onChunk: transport.event })
      Object.assign(metrics, rawUsageMetrics(raw))
      throw textHttpError(response, raw, requestUrl, startedAt, model.remote_id, key ? [headers[authHeader]!] : [])
    }

    let fullText = partialVisibleText
    let completed = false
    let streamEnded = false
    let outputLimitPayload: Record<string, unknown> | undefined
    let footerWait: ReturnType<typeof createUsageFooterWait> | undefined
    const awaitUsageFooter = model.protocol === 'chat_completions' &&
      (body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true
    const emitPayload = async (payload: Record<string, unknown>) => {
      transport.event()
      metrics.first_event_ms ??= Date.now() - startedAt
      Object.assign(metrics, usageMetrics(payload))
      if (outputLimitPayload) { if (usageMetrics(payload).output_tokens !== undefined) streamEnded = true; return }
      const status = String(responseEnvelope(payload).status || '')
      const finish = (payload.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason
      const rawReason = (responseEnvelope(payload).incomplete_details as { reason?: string } | undefined)?.reason ?? finish ?? (status || undefined)
      if (rawReason) metrics.raw_reason = String(rawReason)
      const reasoning = reasoningSummaryValue(payload)
      if (reasoning) await onEvent({ type: 'reasoning_summary', text: reasoning })
      const snapshot = hasTerminalText(payload) ? terminalTextValue(payload, settings) : null
      const text = snapshot ?? streamTextValue(payload, settings)
      if (text) {
        // Terminal Responses output and Chat messages are cumulative snapshots;
        // capture their final text without repeating already streamed deltas.
        const delta = snapshot !== null ? text.startsWith(fullText) ? text.slice(fullText.length) : '' : text
        fullText = snapshot !== null ? text : fullText + text
        partialVisibleText = fullText; metrics.output_started = true
        metrics.response_chars = fullText.length
        if (delta) await onEvent({ type: 'delta', text: delta })
      }
      const failure = textResponseFailure(payload, fullText, false, metrics, metrics.output_limit)
      if (failure) {
        if (textOutputLimitReason(payload)) {
          outputLimitPayload = payload
          recordLimitFailure(metrics, failure)
          streamEnded = usageMetrics(payload).output_tokens !== undefined
          return
        }
        throw failure
      }
      if (finish === 'stop' || payload.type === 'response.completed' || status === 'completed') {
        completed = true
        streamEnded = !awaitUsageFooter || payload.type === 'response.completed' || status === 'completed'
      }
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || ''
    if (!response.body || (contentType && !contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson') && !contentType.includes('application/ndjson'))) {
      const raw = await readTextResponseBody(response, { wait: transport.wait, onChunk: transport.event })
      const payload = parseStreamPayload(raw)
      if (payload) {
        await emitPayload(payload)
        if (outputLimitPayload) throw recordLimitFailure(metrics, textResponseFailure(outputLimitPayload, fullText, false, metrics, metrics.output_limit)!)
        if (wireBody !== undefined) { fullText = responseText(payload, settings, model.protocol); partialVisibleText = fullText }
        // A provider may return ordinary Responses JSON instead of a stream.
        // Keep the same output-array fallback as non-streaming generation.
        if (!fullText && model.protocol === 'responses') {
          const text = textValue(payload.output)
          if (text !== null) {
            fullText = text
            await onEvent({ type: 'delta', text })
          }
        }
      } else if (wireBody !== undefined) {
        throw new TextProviderError('模型接口没有返回有效 JSON 对象', false, 'bad_response_body')
      } else if (raw.trim()) {
        fullText = raw.trim()
        await onEvent({ type: 'delta', text: fullText })
      }
      metrics.response_chars = fullText.length
      metrics.delivery = 'completed'; partialVisibleText = fullText
      return fullText
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const frameBoundary = createTextFrameBoundary()
    const consumeLine = async (line: string) => {
      frameBoundary.line(line); assertTextFrameBoundary(line)
      const trimmed = line.trim()
      if (!trimmed) return
      const value = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
      if (value === '[DONE]') { completed = true; streamEnded = true; return }
      const payload = parseStreamPayload(value)
      if (payload) await emitPayload(payload)
    }
    try {
      while (!streamEnded) {
        let next: ReadableStreamReadResult<Uint8Array> | typeof usageFooterExpired
        try { next = await transport.wait(outputLimitPayload ? (footerWait ??= createUsageFooterWait()).wait(reader.read()) : reader.read()) }
        catch (issue) { if (outputLimitPayload && !scope.signal.aborted) break; throw issue }
        if (next === usageFooterExpired) break
        const { done, value } = next
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        assertTextFrameBoundary(buffer)
        for (const line of lines) { await consumeLine(line); if (streamEnded) break }
        if (!streamEnded) frameBoundary.pending(buffer)
        if (done) break
      }
      if (!streamEnded && buffer.trim()) await consumeLine(buffer)
      if (outputLimitPayload) throw recordLimitFailure(metrics, textResponseFailure(outputLimitPayload, fullText, false, metrics, metrics.output_limit)!)
      if (!completed && contentType.includes('text/event-stream')) throw new TextProviderError('文本模型连接提前结束，未收到完成事件；请检查已收到内容后重试', true, 'stream_disconnected')
    } finally { footerWait?.close(); void reader.cancel().catch(() => {}); reader.releaseLock() }
    metrics.response_chars = fullText.length
    metrics.delivery = 'completed'; partialVisibleText = fullText
    return fullText
  } catch (issue) {
    channel?.failure(issue)
    if (scope.signal.aborted) { metrics.failure_reason = scope.signal.reason?.name === 'AbortError' ? 'cancelled' : 'disconnected'; metrics.raw_reason = scope.signal.reason?.kind; throw scope.signal.reason }
    const failure = !scope.signal.aborted && !(issue instanceof TextProviderError) && transientTextNetworkError(issue)
      ? new TextProviderError('文本模型连接中断，已通过校验的进度会保留；可继续当前任务。', true, 'connection_error', undefined, { cause: issue }) : issue
    annotateTextFailure(failure, { delivery: failure instanceof TextOutputLimitError ? 'completed' : partialVisibleText ? 'output_started' : metrics.delivery ?? 'unknown', partialText: partialVisibleText })
    if (failure instanceof TextProviderError) Object.assign(metrics, { failure_reason: failure.failureReason, raw_reason: failure.rawReason, delivery: failure.delivery, output_started: failure.outputStarted })
    throw failure
  } finally {
    try { usageRequest?.complete(metrics); notifyTextRequest('metrics', metrics, onMetrics, !background) }
    finally { channel?.release(); transport.close(); scope.close() }
  }
}

function base64Bytes(value: string): Buffer {
  const encoded = value.replace(/^data:[^,]*;base64,/, '').replace(/\s/g, '')
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) throw new Error('模型返回的图片 Base64 无效')
  if (encoded.length > maxImageBytes * 1.4) throw new Error('模型返回的图片超过 30 MB')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > maxImageBytes) throw new Error('模型返回的图片无效或过大')
  return bytes
}

async function targetPath(projectId: string, suffix: string): Promise<string> {
  // Project IDs come from the database, but keep generated paths confined to mediaDir.
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('无效的项目 ID')
  const directory = join(mediaDir, projectId)
  await mkdir(directory, { recursive: true })
  return join(directory, `${randomUUID()}${suffix}`)
}

async function saveBytes(projectId: string, suffix: string, bytes: Buffer): Promise<string> {
  const path = await targetPath(projectId, suffix)
  await writeFile(path, bytes)
  return path
}

async function saveImage(projectId: string, bytes: Buffer): Promise<string> {
  if (bytes.length > maxImageBytes) throw new Error('图片超过 30 MB')
  const path = await targetPath(projectId, '.png')
  try {
    await sharp(bytes).rotate().png().toFile(path)
    return path
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
}

async function download(projectId: string, url: string, suffix: '.mp4' | '.png'): Promise<string> {
  const target = await targetPath(projectId, suffix === '.png' ? '.download' : suffix)
  try {
    const parent = modelStepSignal()
    const response = await observeProviderFetch(httpUrl(url), { signal: parent ? AbortSignal.any([parent, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }, 'media_download')
    if (!response.ok || !response.body) throw new Error(`下载模型结果失败 (${response.status})`)
    const limit = suffix === '.png' ? maxImageBytes : maxVideoBytes
    const length = Number(response.headers.get('content-length'))
    if (length > limit) throw new Error(`模型结果超过 ${Math.round(limit / 1024 / 1024)} MB`)
    const file = await open(target, 'w', 0o600)
    let total = 0
    try {
      for await (const chunk of response.body) {
        total += chunk.length
        if (total > limit) throw new Error(`模型结果超过 ${Math.round(limit / 1024 / 1024)} MB`)
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) throw new Error('模型结果写入失败')
          offset += bytesWritten
        }
      }
    } finally {
      await file.close()
    }
    if (!total) throw new Error('模型结果为空')
    if (suffix === '.png') return await saveImage(projectId, await readFile(target))
    return target
  } catch (error) {
    await rm(target, { force: true })
    throw error
  } finally {
    if (suffix === '.png') await rm(target, { force: true })
  }
}

async function referenceImage(asset: MediaAsset, settings?: Settings): Promise<string> {
  if (asset.kind !== 'image') throw new Error('参考素材必须是图片')
  const image = await stat(asset.path)
  const seedance = ['seedance_2_0', 'seedance_2_5'].includes(String(settings?.video_reference_profile))
  const label = settings?.video_reference_profile === 'seedance_2_5' ? 'Seedance 2.5' : 'Seedance 2.0'
  if (seedance ? image.size >= 30 * 1024 * 1024 : image.size > 20 * 1024 * 1024) throw new Error(`参考图${seedance ? '必须小于 30 MB' : '超过 20 MB，请使用较小的图片'}`)
  if (seedance) {
    // Use the decoded format, not a filename extension that can be incorrect.
    const metadata = await sharp(asset.path).metadata()
    const mimes: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
      tiff: 'image/tiff', heif: metadata.compression === 'av1' ? 'image/avif' : 'image/heic' }
    const mime = metadata.format ? mimes[metadata.format] : undefined
    if (!mime || mime === 'image/avif') throw new Error(`${label} 参考图片格式不支持，请使用 JPEG、PNG、WebP、GIF、TIFF 或 HEIC 图片`)
    return `data:${mime};base64,${(await readFile(asset.path)).toString('base64')}`
  }
  const extension = extname(asset.path).toLowerCase()
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${(await readFile(asset.path)).toString('base64')}`
}

/** Called before queueing as well as before submission; no generation request is made here. */
export async function validateVideoReferenceAssets(settings: Settings, references: MediaAsset[]): Promise<void> {
  if (!['seedance_2_0', 'seedance_2_5'].includes(String(settings.video_reference_profile))) return
  const label = settings.video_reference_profile === 'seedance_2_5' ? 'Seedance 2.5' : 'Seedance 2.0'
  const info = await Promise.all(references.map(async (asset, index) => {
    if (asset.kind !== 'image') throw new Error('视频参考素材必须是图片')
    try {
      const file = await stat(asset.path)
      if (file.size >= 30 * 1024 * 1024) throw new Error(`参考图 ${index + 1} 必须小于 30 MB`)
      const metadata = await sharp(asset.path).metadata()
      if (!['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif'].includes(metadata.format ?? '') || metadata.format === 'heif' && metadata.compression === 'av1') {
        throw new Error(`图片格式不在 ${label} 支持范围，请改用 JPEG、PNG、WebP、GIF、TIFF 或 HEIC`)
      }
      const rotated = metadata.orientation !== undefined && metadata.orientation >= 5
      return { bytes: file.size, width: (rotated ? metadata.height : metadata.width) ?? 0, height: (rotated ? metadata.width : metadata.height) ?? 0 }
    } catch (error) {
      throw new Error(`无法使用参考图 ${index + 1}：${error instanceof Error ? error.message : String(error)}`)
    }
  }))
  const issue = videoReferenceMediaError(settings, info)
  if (issue) throw new Error(issue)
}

function imageResult(payload: Record<string, unknown>, settings: Settings): { base64?: string; url?: string } {
  const base64Path = typeof settings.image_base64_path === 'string' ? settings.image_base64_path : null
  const urlPath = typeof settings.image_url_path === 'string' ? settings.image_url_path : null
  if (!base64Path && !urlPath) throw new Error('图片模型必须配置 image_base64_path 或 image_url_path')
  const base64 = base64Path ? optionalNested(payload, base64Path) : undefined
  const url = urlPath ? optionalNested(payload, urlPath) : undefined
  if (typeof base64 === 'string' && base64) return { base64 }
  if (typeof url === 'string' && url) return { url }
  throw new Error('图片模型没有返回图片地址或 Base64')
}

async function downloadImage(projectId: string, url: string): Promise<string> {
  const startedAt = Date.now()
  try { return await download(projectId, url, '.png') }
  catch (error) {
    if (isNetworkFailure(error)) throw imageNetworkError('结果图片下载', startedAt, error)
    throw new Error(`图片已生成，但结果图片下载失败（阶段：结果图片下载；耗时：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）。可重试下载现有结果，不会再次请求厂商生成。`)
  }
}

export async function recoverImage(projectId: string, url: string): Promise<GenerationResult> {
  return { path: await downloadImage(projectId, httpUrl(url)), remoteUrl: url }
}

/** Download an already generated video without any model or provider access. */
export async function recoverVideo(projectId: string, url: string): Promise<GenerationResult> {
  const validatedUrl = httpUrl(url)
  try { return { path: await download(projectId, validatedUrl, '.mp4'), remoteUrl: validatedUrl } }
  catch (error) {
    // A signed result URL can contain credentials. Keep the transport's raw
    // message out of persisted/public job errors while retaining a safe code.
    throw new Error(`视频已生成，但结果视频下载失败（错误码：${networkCode(error) ?? 'UNKNOWN'}）。可重试下载现有结果，不会再次请求厂商生成。`)
  }
}

async function consumeImage(projectId: string, payload: Record<string, unknown>, settings: Settings,
  onImageUrl: (url: string) => void | Promise<void>): Promise<GenerationResult> {
  const result = imageResult(payload, settings)
  if (result.base64) {
    try { return { path: await saveImage(projectId, base64Bytes(result.base64)), remoteUrl: null } }
    catch (error) {
      throw new Error(`图片已由厂商返回 Base64，但保存本地文件失败（错误码：${networkCode(error) ?? 'UNKNOWN'}）。本次结果没有可恢复链接；请先核对厂商记录，再手动创建新的生成任务。`)
    }
  }
  const url = httpUrl(result.url!)
  try { await onImageUrl(url) }
  catch {
    throw new Error('图片已生成，但保存可恢复链接失败。厂商可能已计费，请先核对厂商记录，再手动创建新的生成任务。')
  }
  return recoverImage(projectId, url)
}

function validatedVideoReference(value: string, settings: Settings): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('参考视频地址无效') }
  const extra = Array.isArray(settings.reference_video_schemes)
    ? settings.reference_video_schemes.filter((scheme): scheme is string => typeof scheme === 'string') : []
  if (settings.video_reference_profile === 'seedance_2_5') extra.push('asset:')
  if (!['http:', 'https:', ...extra].includes(url.protocol)) throw new Error(`参考视频地址不支持 ${url.protocol} 协议`)
  if (!url.hostname && !url.pathname) throw new Error('参考视频地址无效')
  return url.toString()
}

/** Keep provider polling cancelable while using the same host timer as the rest
 * of the app (and offline test clocks). */
async function waitForProviderPoll(milliseconds: number): Promise<void> {
  const signal = modelStepSignal()
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function pollTask(
  id: string,
  getResult: () => Promise<Record<string, unknown>>,
  parseResult: (payload: Record<string, unknown>) => { status: string; videoUrl?: string },
  seconds: number,
  projectId: string,
  onVideoUrl: (url: string) => void | Promise<void>,
): Promise<GenerationResult> {
  const interval = Math.max(1, Math.min(seconds, 60)) * 1000
  const deadline = Date.now() + 30 * 60_000
  let transientErrors = 0
  while (Date.now() < deadline) {
    await waitForProviderPoll(interval)
    let result: Record<string, unknown>
    try {
      result = await getResult()
      transientErrors = 0
    } catch (error) {
      if (++transientErrors < 3) continue
      throw new Error(`查询视频任务 ${id} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { status, videoUrl } = parseResult(result)
    if (status === 'succeeded' || status === 'completed') {
      if (!videoUrl) throw new Error('视频任务成功，但没有返回视频地址')
      const url = httpUrl(videoUrl)
      try { await onVideoUrl(url) }
      catch { throw new Error('视频已生成，但保存可恢复链接失败。厂商可能已计费，请先核对厂商记录，不要重复提交。') }
      return recoverVideo(projectId, url)
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
      throw new Error(`视频任务 ${id} 失败: ${JSON.stringify(result.error ?? status).slice(0, 800)}`)
    }
  }
  throw new Error(`视频任务 ${id} 超过 30 分钟仍未完成，可凭任务 ID 在厂商控制台查询`)
}

function renderTemplate(value: unknown, variables: Variables): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-z_]+)\}\}$/.exec(value)
    if (exact?.[1]) return variables[exact[1]] ?? null
    return value.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => String(variables[key] ?? ''))
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplate(item, variables)]))
  return value
}

function compactTemplate(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(compactTemplate)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, compactTemplate(item)]))
  }
  return value
}

function renderContentTemplate(value: unknown, variables: Variables): unknown {
  if (!Array.isArray(value)) return compactTemplate(renderTemplate(value, variables))
  return value.flatMap((item) => {
    const rendered = compactTemplate(renderTemplate(item, variables))
    if (rendered === null || rendered === undefined) return []
    return Array.isArray(rendered) ? rendered : [rendered]
  })
}

function configObject(value: unknown, key: string): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型设置 ${key} 必须是 JSON 对象`)
  return value as Settings
}

function modeVariables(settings: Settings, request: GenerationRequest): Variables {
  request = normalizeSeedance25Request(settings, request)
  const mode = request.mode ?? 'text'
  const result: Variables = {
    model: null,
    prompt: request.prompt,
    duration: request.duration ?? (settings.create_path ? settings.default_duration : undefined) ?? 5,
    ratio: request.ratio ?? (settings.image_api_profile === documentedImageProfile || settings.create_path ? settings.default_ratio : undefined) ?? '16:9',
    resolution: request.resolution ?? settings.default_resolution ?? settings.resolution ?? null,
    quality: request.quality ?? settings.default_quality ?? settings.quality ?? null,
    clarity: request.clarity ?? settings.default_clarity ?? settings.clarity ?? null,
    background: request.background ?? settings.default_background ?? settings.background ?? null,
    reference_video_url: request.reference_video_url ? validatedVideoReference(request.reference_video_url, settings) : null,
    generate_audio: request.generate_audio ?? true,
    draft: request.draft ? true : null,
    mode,
  }
  const perMode = settings.mode_variables
  if (perMode && typeof perMode === 'object' && !Array.isArray(perMode)) {
    const override = (perMode as Settings)[mode]
    if (override !== undefined) Object.assign(result, configObject(override, `mode_variables.${mode}`))
  }
  // Mode defaults must not replace explicitly selected output dimensions.
  if (request.ratio != null) result.ratio = request.ratio
  if (request.resolution != null) result.resolution = request.resolution
  if (request.draft && settings.draft_variables !== undefined) {
    Object.assign(result, configObject(settings.draft_variables, 'draft_variables'))
  }
  Object.assign(result, seedance25RequestVariables(settings, request))
  return result
}

function requestTemplate(settings: Settings, request: GenerationRequest, fallback: unknown): unknown {
  const perMode = settings.request_templates
  if (perMode && typeof perMode === 'object' && !Array.isArray(perMode)) {
    const override = (perMode as Settings)[request.mode ?? 'text']
    if (override !== undefined) return override
  }
  return settings.request_template ?? fallback
}

function mediaVariables(settings: Settings, request: GenerationRequest, images: string[], remoteId: string): Variables {
  const variables = modeVariables(settings, request)
  variables.model = remoteId
  variables.image = images[0] ?? null
  variables.images = images.length ? images : null
  variables.size = request.resolution || settings.default_resolution || settings.size || null
  const roleMap = settings.reference_roles && typeof settings.reference_roles === 'object' && !Array.isArray(settings.reference_roles)
    ? settings.reference_roles as Settings : {}
  const configuredRoles = roleMap[request.mode ?? 'text']
  const roles = Array.isArray(configuredRoles) ? configuredRoles.map(String) : []
  const needsRoles = JSON.stringify(settings.image_reference_template ?? '').includes('{{role}}')
  if (needsRoles && images.length && roles.length === 0) throw new Error('当前模式未配置参考图角色')
  if (needsRoles && images.length > roles.length && roles.length !== 1) throw new Error('当前模式的参考图角色数量不足')
  variables.image_references = settings.image_reference_template
    ? images.map((image, index) => compactTemplate(renderTemplate(settings.image_reference_template,
      { ...variables, image, role: roles[Math.min(index, roles.length - 1)] }))) : []
  variables.video_references = variables.reference_video_url && settings.video_reference_template
    ? [compactTemplate(renderTemplate(settings.video_reference_template, variables))] : []
  variables.content = settings.content_template ? renderContentTemplate(settings.content_template, variables) : null
  return variables
}

function videoPayload(settings: Settings, request: GenerationRequest, images: string[], remoteId: string): unknown {
  if (settings.video_reference_profile === 'seedance_2_5' && request.mode === 'reference' && !images.length && !request.reference_video_url) throw new Error('Seedance 2.5 参考模式需要至少一张参考图片或一个参考视频')
  const variables = mediaVariables(settings, request, images, remoteId)
  const body = compactTemplate(renderTemplate(requestTemplate(settings, request, { model: '{{model}}', prompt: '{{prompt}}' }), variables))
  // Check the rendered payload too: indirection must not lose a selected image.
  const sentImages = new Set<string>()
  let sentVideo = false
  function collect(value: unknown): void {
    if (typeof value === 'string') {
      if (images.includes(value)) sentImages.add(value)
      if (variables.reference_video_url && value === variables.reference_video_url) sentVideo = true
    }
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(body)
  if (images.some(image => !sentImages.has(image))) throw new Error('视频请求模板未传递全部参考图片，请检查当前模式的图片字段')
  if (request.reference_video_url && !sentVideo) throw new Error('视频请求模板未传递参考视频，请检查当前模式的视频字段')
  if (settings.video_reference_profile === 'seedance_2_5') {
    const payload = configObject(body, 'request_template')
    if (!Array.isArray(payload.content)) throw new Error('Seedance 2.5 请求模板必须使用 content 数组传递提示词与参考素材')
    const imageContent = payload.content.filter(item => item && typeof item === 'object' && !Array.isArray(item) && (item as Settings).type === 'image_url') as Settings[]
    const roles = request.mode === 'first_frame' ? ['first_frame'] : request.mode === 'first_last_frame' ? ['first_frame', 'last_frame'] : images.map(() => 'reference_image')
    if (imageContent.length !== images.length || images.some((image, index) => imageContent[index]?.role !== roles[index]
      || (imageContent[index]?.image_url as Settings | undefined)?.url !== image)) {
      throw new Error('Seedance 2.5 必须在 content 中按顺序以 image_url 和当前模式的正确角色传递全部参考图片')
    }
    for (const key of ['ratio', 'duration', 'resolution', 'omni_reference_task_type', 'generate_audio', 'draft']) {
      if (variables[key] != null && (key !== 'draft' || request.draft) && payload[key] !== variables[key]) throw new Error(`Seedance 2.5 请求模板必须正确传递 ${key}`)
    }
    if (variables.omni_reference_task_type === null && payload.omni_reference_task_type != null) throw new Error('Seedance 2.5 文生视频、首帧或首尾帧模式不能传递全模态任务类型')
    if (variables.draft === null && payload.draft != null && payload.draft !== false) throw new Error('Seedance 2.5 请求模板不能在关闭样片时启用 draft')
    if (request.reference_video_url && !payload.content.some(item => item && typeof item === 'object' && !Array.isArray(item)
      && (item as Settings).type === 'video_url' && (item as Settings).role === 'reference_video'
      && ((item as Settings).video_url as Settings | undefined)?.url === variables.reference_video_url)) {
      throw new Error('Seedance 2.5 参考视频必须以 video_url 和 reference_video 角色传递到 content')
    }
  }
  const issue = videoReferenceMediaError(settings, [], Buffer.byteLength(JSON.stringify(body), 'utf8'))
  if (issue) throw new Error(issue)
  return body
}

/** Dry-run the exact Seedance payload before queueing, including Base64 and template duplication. */
export async function validateVideoReferenceRequest(settings: Settings, references: MediaAsset[], request: GenerationRequest, remoteId: string): Promise<Settings | undefined> {
  checkVideoReferenceRequestMode(settings, request)
  const issue = videoReferenceConfigError(settings, references.length, request.mode ?? 'text')
  if (issue) throw new Error(issue)
  await validateVideoReferenceAssets(settings, references)
  if (!['seedance_2_0', 'seedance_2_5'].includes(String(settings.video_reference_profile)) && !request.reference_video_url) return
  const images = await Promise.all(references.map(asset => referenceImage(asset, settings)))
  const body = videoPayload(settings, request, images, remoteId)
  if (settings.video_reference_profile === 'seedance_2_5') {
    const payload = configObject(body, 'request_template')
    return Object.fromEntries(['ratio', 'resolution', 'duration', 'generate_audio', 'draft', 'omni_reference_task_type']
      .filter(key => payload[key] !== undefined).map(key => [key, payload[key]]))
  }
}

function checkVideoReferenceRequestMode(settings: Settings, request: GenerationRequest): void {
  const issue = seedance25RequestError(settings, request)
  if (issue) throw new Error(issue)
  if (settings.video_reference_profile === 'seedance_2_0' && request.reference_video_url && ['first_frame', 'first_last_frame'].includes(request.mode ?? 'text')) {
    throw new Error('Seedance 2.0 首帧、首尾帧与全模态参考互斥，不能同时传入参考视频')
  }
}

function pollConfiguredVideo(
  externalId: string,
  settings: Settings,
  provider: GenerationProvider,
  headers: Record<string, string>,
  projectId: string,
  onVideoUrl: (url: string) => void | Promise<void>,
  identity: ProviderRequestIdentity = {},
): Promise<GenerationResult> {
  const success = Array.isArray(settings.success_statuses) ? settings.success_statuses.map(String) : ['succeeded', 'completed']
  const failure = Array.isArray(settings.failure_statuses) ? settings.failure_statuses.map(String) : ['failed', 'cancelled']
  const getPath = settingString(settings, 'get_path').replaceAll('{id}', encodeURIComponent(externalId))
  return pollTask(externalId,
    () => requestJson('GET', apiUrl(provider.base_url, getPath), headers, undefined, undefined, '', undefined, undefined, identity),
    (result) => {
      const status = String(nested(result, settingString(settings, 'status_path', 'status')))
      const videoUrl = success.includes(status) ? String(nested(result, settingString(settings, 'result_path', 'output.url'))) : undefined
      return { status: success.includes(status) ? 'succeeded' : failure.includes(status) ? 'failed' : status, videoUrl }
    },
    Number(settings.poll_seconds ?? 10), projectId, onVideoUrl)
}

async function pollConfiguredImage(
  externalId: string,
  settings: Settings,
  provider: GenerationProvider,
  headers: Record<string, string>,
  projectId: string,
  onImageUrl: (url: string) => void | Promise<void>,
  identity: ProviderRequestIdentity = {},
): Promise<GenerationResult> {
  const success = Array.isArray(settings.success_statuses) ? settings.success_statuses.map(String) : ['succeeded', 'completed']
  const failure = Array.isArray(settings.failure_statuses) ? settings.failure_statuses.map(String) : ['failed', 'expired', 'cancelled', 'canceled']
  const getPath = settingString(settings, 'get_path').replaceAll('{id}', encodeURIComponent(externalId))
  const interval = Math.max(1, Math.min(Number(settings.poll_seconds) || 5, 60)) * 1000
  const deadline = Date.now() + 30 * 60_000
  let transientErrors = 0
  while (Date.now() < deadline) {
    let result: Record<string, unknown>
    try {
      result = await requestJson('GET', apiUrl(settingString(settings, 'image_task_base_url', provider.base_url), getPath), headers, undefined, undefined, '', undefined, undefined, identity)
      transientErrors = 0
    } catch (error) {
      if (++transientErrors >= 3) throw new Error(`查询图片任务 ${externalId} 失败，可继续查询原任务：${error instanceof Error ? error.message : String(error)}`)
      await waitForProviderPoll(interval)
      continue
    }
    const status = optionalNested(result, settingString(settings, 'status_path', 'status'))
    if (failure.includes(String(status))) {
      const message = optionalNested(result, settingString(settings, 'error_path', 'error.message')) ?? result.error ?? status
      throw new Error(`图片任务 ${externalId} 失败：${String(typeof message === 'string' ? message : JSON.stringify(message)).slice(0, 800)}`)
    }
    // RightAPI's completed Images response can omit status and return only
    // the usual data array. Pending responses must never consume old results.
    const hasImage = [settings.image_base64_path, settings.image_url_path].some(path => {
      const value = typeof path === 'string' ? optionalNested(result, path) : undefined
      return typeof value === 'string' && !!value
    })
    if (success.includes(String(status)) || status === undefined && hasImage) {
      return consumeImage(projectId, result, settings, onImageUrl)
    }
    if (typeof status !== 'string' || !status) throw new Error(`查询图片任务 ${externalId} 未返回任务状态或图片结果`)
    await waitForProviderPoll(interval)
  }
  throw new Error(`图片任务 ${externalId} 超过 30 分钟仍未完成，可继续查询原任务或凭任务编号到厂商查看`)
}

async function configuredNetwork(
  model: GenerationModel,
  provider: GenerationProvider,
  request: GenerationRequest,
  references: MediaAsset[],
  projectId: string,
  onExternalId: (id: string) => void | Promise<void>,
  key: string,
  onImageUrl: (url: string) => void | Promise<void>,
  onVideoUrl: (url: string) => void | Promise<void>,
  options: { signal?: AbortSignal; onMetrics?: (metrics: TextRequestMetrics) => void; onDispatch?: (metrics: TextRequestMetrics) => void } = {},
): Promise<GenerationResult> {
  options.signal?.throwIfAborted()
  let settings = asSettings(model, provider)
  const identity = { model_id: model.id, remote_id: model.remote_id }
  const hasExternalId = request._external_id !== undefined && request._external_id !== null
  if (hasExternalId && model.modality !== 'video' && !(model.modality === 'image' && settings.async_image === true)) {
    throw new Error('现有厂商任务编号与当前模型配置不兼容，无法安全继续查询。请先核对厂商记录，不要重复提交。')
  }
  if (hasExternalId && (typeof request._external_id !== 'string' || !request._external_id.trim() || ['undefined', 'null'].includes(request._external_id.trim()))) {
    throw new Error(`现有${model.modality === 'video' ? '视频' : '图片'}任务编号无效，无法继续查询。请先核对厂商记录，不要重复提交。`)
  }
  if (model.modality === 'text') {
    const textImages = await Promise.all(references.map(asset => referenceImage(asset)))
    const text = await withCompatibleStructuredSettings(model, provider, request.structured_output, options.signal, configured => {
      const configuredSettings = asSettings(configured, provider)
      const rendered = compactTemplate(renderTemplate(requestTemplate(configuredSettings, request, { model: '{{model}}', prompt: '{{prompt}}' }),
        mediaVariables(configuredSettings, request, textImages, model.remote_id)))
      const nonStreaming = rendered && typeof rendered === 'object' && !Array.isArray(rendered) && (configured.protocol === 'anthropic_messages' || 'stream' in rendered)
        ? { ...rendered as Settings, stream: false } : rendered
      return streamText(configured, provider, { prompt: request.prompt, structured_output: request.structured_output },
        () => key, undefined, options.signal, options.onMetrics, options.onDispatch, nonStreaming)
    })
    options.signal?.throwIfAborted()
    return { path: await saveBytes(projectId, '.txt', Buffer.from(text)), remoteUrl: null }
  }
  const documentedImages = model.modality === 'image' && settings.image_api_profile === documentedImageProfile
  if (documentedImages) {
    const issue = documentedImageConfigError(settings)
    if (issue) throw new Error(issue)
    settings = documentedImageSettings(settings, provider.base_url)
  }
  provider = { ...provider, base_url: settingString(settings, 'api_base_url', provider.base_url) }
  const authHeader = provider.auth_header || 'Authorization'
  const authPrefix = provider.auth_prefix ?? 'Bearer '
  const headers = key ? { [authHeader]: `${authPrefix}${key}` } : {}
  if (model.modality === 'video' && request._external_id !== undefined && request._external_id !== null) {
    return pollConfiguredVideo(request._external_id, settings, provider, headers, projectId, onVideoUrl, identity)
  }
  if (model.modality === 'image' && settings.async_image === true && request._external_id) {
    return pollConfiguredImage(request._external_id, settings, provider, headers, projectId, onImageUrl, identity)
  }
  if (documentedImages) {
    if (['reference', 'edit'].includes(request.mode ?? '') && references.length === 0) throw new Error('参考图生成需要至少一张参考图片')
    if (settings.image_clarity_parameter && request.clarity && !['1K', '2K', '4K'].includes(request.clarity)) throw new Error('imageSize 只支持 1K、2K 或 4K')
    const size = settings.image_size_mode === 'pixels' ? request.resolution || settings.default_resolution : request.ratio || settings.default_ratio
    if (typeof size !== 'string' || !(settings.image_size_mode === 'pixels' ? /^[1-9]\d*x[1-9]\d*$/ : /^[1-9]\d*:[1-9]\d*$/).test(size)) throw new Error('图片 size 应为画幅比例或像素尺寸')
  }
  if (model.modality === 'video') {
    checkVideoReferenceRequestMode(settings, request)
    const issue = videoReferenceConfigError(settings, references.length, request.mode ?? 'text')
    if (issue) throw new Error(issue)
    await validateVideoReferenceAssets(settings, references)
  }
  const preparedImages = model.modality === 'image' ? await prepareImageReferences(references, settings.compress_reference_images !== false) : []
  const images = model.modality === 'image' ? preparedImages.map(image => image.dataUrl)
    : await Promise.all(references.map(asset => referenceImage(asset, model.modality === 'video' ? settings : undefined)))
  const variables = mediaVariables(settings, request, images, model.remote_id)

  if (model.modality !== 'video') {
    const rendered = compactTemplate(renderTemplate(requestTemplate(settings, request, { model: '{{model}}', prompt: '{{prompt}}' }), variables))
    const multipart = model.modality === 'image' && references.length > 0 && settings.image_reference_transport === 'multipart'
    const path = model.modality === 'image' && references.length > 0
      ? settingString(settings, 'image_reference_path', settingString(settings, 'request_path')) : settingString(settings, 'request_path')
    const timeoutSeconds = Number(settings.request_timeout_seconds ?? defaultImageRequestTimeoutSeconds)
    if (model.modality === 'image' && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800)) throw new Error('图片请求超时必须为 30 到 1800 秒的整数')
    const body = multipart ? imageMultipartBody(rendered, preparedImages) : rendered
    const payload = await requestJson('POST', apiUrl(provider.base_url, path), headers, body,
      model.modality, model.remote_id, model.modality === 'image' ? timeoutSeconds * 1000 : textRequestTimeoutMs, undefined, identity)
    if (settings.async_image === true) {
      const externalId = nested(payload, settingString(settings, 'id_path', 'id'))
      if (typeof externalId !== 'string' || !externalId.trim()) throw new Error('图片模型没有返回有效任务编号')
      try { await onExternalId(externalId) }
      catch { throw new Error(`图片任务 ${externalId} 已提交，但保存任务编号失败，请凭此编号查询厂商结果`) }
      return pollConfiguredImage(externalId, settings, provider, headers, projectId, onImageUrl, identity)
    }
    return consumeImage(projectId, payload, settings, onImageUrl)
  }

  let externalId = request._external_id
  if (!externalId) {
    const body = videoPayload(settings, request, images, model.remote_id)
    const created = await requestJson('POST', apiUrl(provider.base_url, settingString(settings, 'create_path')), headers, body, undefined, '', undefined, undefined, identity)
    const rawId = optionalNested(created, settingString(settings, 'id_path', 'id'))
    // Generic gateways may use numeric database IDs. Preserve exact safe
    // integers, while never turning objects, booleans or imprecise numbers
    // into a fabricated task identity.
    const returnedId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId
    if (typeof returnedId !== 'string' || !returnedId.trim() || ['undefined', 'null'].includes(returnedId.trim())) {
      throw new Error('视频模型没有返回有效任务 ID，厂商可能已接受或计费。请先核对厂商记录，不要重复提交。')
    }
    externalId = returnedId
    try { await onExternalId(externalId) }
    catch { throw new Error(`视频任务 ${externalId} 已提交，但保存任务编号失败。厂商可能已计费，请凭此编号查询厂商结果，不要重复提交。`) }
  }
  return pollConfiguredVideo(externalId, settings, provider, headers, projectId, onVideoUrl, identity)
}

export async function generate(
  model: GenerationModel,
  provider: GenerationProvider,
  request: GenerationRequest,
  references: MediaAsset[],
  projectId: string,
  onExternalId: (id: string) => void | Promise<void>,
  resolveApiKey?: (provider: GenerationProvider) => string | Promise<string>,
  onImageUrl: (url: string) => void | Promise<void> = () => {},
  onVideoUrl: (url: string) => void | Promise<void> = () => {},
  options: { signal?: AbortSignal; onMetrics?: (metrics: TextRequestMetrics) => void; onDispatch?: (metrics: TextRequestMetrics) => void } = {},
): Promise<GenerationResult> {
  if (provider.adapter === 'demo') throw new Error('演示模型已停用')
  const key = (resolveApiKey ? await resolveApiKey(provider) : '') || ''
  return configuredNetwork(model, provider, request, references, projectId, onExternalId, key, onImageUrl, onVideoUrl, options)
}
