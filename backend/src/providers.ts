import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

export type Modality = 'text' | 'image' | 'video'
export type Adapter = 'http' | 'demo'

export interface GenerationModel {
  id: string
  remote_id: string
  modality: Modality
  settings: Record<string, unknown> | string
  protocol?: 'responses' | 'chat_completions' | 'image_generations' | 'async_video'
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
  /** Optional request fields used by configured templates. */
  mode?: 'text'
}

type Settings = Record<string, unknown>
type Variables = Record<string, unknown>

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = process.env.VIDEO_STUDIO_DATA_DIR ?? join(root, 'data')
export const mediaDir = join(dataDir, 'media')
const maxImageBytes = 30 * 1024 * 1024
const maxVideoBytes = 600 * 1024 * 1024
const textRequestTimeoutMs = 10 * 60_000

function asSettings(model: GenerationModel): Settings {
  if (typeof model.settings !== 'string') return model.settings ?? {}
  const parsed: unknown = JSON.parse(model.settings)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型设置必须是 JSON 对象')
  return parsed as Settings
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

function imageNetworkError(stage: '厂商请求' | '结果图片下载', startedAt: number, error: unknown): Error {
  const code = networkCode(error) ?? 'UNKNOWN'
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const advice = stage === '厂商请求'
    ? '厂商可能已计费，请先核对厂商记录，再手动创建新的生成任务。'
    : '图片已生成，可重试下载现有结果，不会再次请求厂商生成。'
  return new Error(`图片任务网络失败（阶段：${stage}；错误码：${code}；耗时：${seconds} 秒）。${advice}`)
}

async function requestJson(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown,
  modality?: Modality): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  let response: Response
  let raw: string
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(modality === 'text' ? textRequestTimeoutMs : 90_000),
    })
    raw = await response.text()
  } catch (error) {
    if (modality === 'image' && isNetworkFailure(error)) throw imageNetworkError('厂商请求', startedAt, error)
    if (modality === 'text' && networkCode(error) === 'TIMEOUT') {
      throw new Error('文本模型请求超时（最长等待 10 分钟），请稍后重试或切换文本模型。')
    }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!response.ok) {
    if (modality === 'image') throw new Error(`图片生成请求失败（阶段：厂商请求；HTTP ${response.status}；耗时：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）。厂商可能已计费，请先核对厂商记录。`)
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

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null
  if (Array.isArray(value)) {
    const parts = value.map(textValue).filter((part): part is string => part !== null)
    return parts.length ? parts.join('\n') : null
  }
  if (!value || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  if (isNonAnswerBlock(object)) return null
  for (const key of ['output_text', 'text', 'content', 'message', 'delta', 'value']) {
    const result = textValue(object[key])
    if (result !== null) return result
  }
  return null
}

function textAtPath(payload: Record<string, unknown>, path: string): string | null {
  let current: unknown = payload
  for (const part of path.split('.')) {
    if (isNonAnswerBlock(current) || !current || typeof current !== 'object' || !(part in current)) return null
    if (/^(?:reasoning(?:_content)?|reasoning_summary|thinking|analysis|refusal)$/i.test(part)) return null
    current = (current as Record<string, unknown>)[part]
  }
  return textValue(current)
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
    const selected = textAtPath(payload, path)
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
): Promise<string> {
  if (provider.adapter === 'demo') throw new Error('演示模型已停用')
  if (model.modality !== 'text') throw new Error('流式调用只支持文本模型')
  const settings = asSettings(model)
  const key = (resolveApiKey ? await resolveApiKey(provider) : '') || ''
  const authHeader = provider.auth_header || 'Authorization'
  const authPrefix = provider.auth_prefix ?? 'Bearer '
  const headers: Record<string, string> = {
    Accept: 'text/event-stream, application/x-ndjson, application/json',
    ...(key ? { [authHeader]: `${authPrefix}${key}` } : {}),
  }
  const variables = streamBodyVariables(settings, request, model)
  const template = streamRequestTemplate(settings)
  const renderedBody = compactTemplate(renderTemplate(
    template ?? { model: '{{model}}', prompt: '{{prompt}}', stream: true }, variables,
  ))
  // Most OpenAI-compatible providers opt into streaming with a top-level
  // `stream` flag. Add it when the configured template did not specify one;
  // an explicit template value (including false) always wins.
  const body = renderedBody && typeof renderedBody === 'object' && !Array.isArray(renderedBody)
    ? { ...(renderedBody as Record<string, unknown>),
      ...(('stream' in (renderedBody as Record<string, unknown>) || settings.stream === false)
        ? {} : { stream: true }) }
    : renderedBody
  let response: Response
  try {
    response = await fetch(apiUrl(provider.base_url, settingString(settings, 'request_path')), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(textRequestTimeoutMs)]) : AbortSignal.timeout(textRequestTimeoutMs),
    })
  } catch (error) {
    throw new Error(`文本模型流式请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const raw = await response.text()
    throw new Error(`模型接口返回 ${response.status}: ${raw.slice(0, 800)}`)
  }

  let fullText = ''
  const emitPayload = async (payload: Record<string, unknown>) => {
    const reasoning = reasoningSummaryValue(payload)
    if (reasoning) await onEvent({ type: 'reasoning_summary', text: reasoning })
    const text = streamTextValue(payload, settings)
    if (text) {
      fullText += text
      await onEvent({ type: 'delta', text })
    }
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (!response.body || (contentType && !contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson') && !contentType.includes('application/ndjson'))) {
    const raw = await response.text()
    const payload = parseStreamPayload(raw)
    if (payload) await emitPayload(payload)
    else if (raw.trim()) {
      fullText = raw.trim()
      await onEvent({ type: 'delta', text: fullText })
    }
    return fullText
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consumeLine = async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const value = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    const payload = parseStreamPayload(value)
    if (payload) await emitPayload(payload)
  }
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) await consumeLine(line)
    if (done) break
  }
  if (buffer.trim()) await consumeLine(buffer)
  return fullText
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
    const response = await fetch(httpUrl(url), { signal: AbortSignal.timeout(120_000) })
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

async function referenceImage(asset: MediaAsset): Promise<string> {
  if (asset.kind !== 'image') throw new Error('参考素材必须是图片')
  const image = await stat(asset.path)
  if (image.size > 20 * 1024 * 1024) throw new Error('参考图超过 20 MB，请使用较小的图片')
  const extension = extname(asset.path).toLowerCase()
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${(await readFile(asset.path)).toString('base64')}`
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
  if (!['http:', 'https:', ...extra].includes(url.protocol)) throw new Error(`参考视频地址不支持 ${url.protocol} 协议`)
  if (!url.hostname && !url.pathname) throw new Error('参考视频地址无效')
  return url.toString()
}

async function pollTask(
  id: string,
  getResult: () => Promise<Record<string, unknown>>,
  parseResult: (payload: Record<string, unknown>) => { status: string; videoUrl?: string },
  seconds: number,
  projectId: string,
): Promise<GenerationResult> {
  const interval = Math.max(1, Math.min(seconds, 60)) * 1000
  const deadline = Date.now() + 30 * 60_000
  let transientErrors = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
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
      return { path: await download(projectId, url, '.mp4'), remoteUrl: url }
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
  const mode = request.mode ?? 'text'
  const result: Variables = {
    model: null,
    prompt: request.prompt,
    duration: request.duration ?? 5,
    ratio: request.ratio ?? '16:9',
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
  if (request.draft && settings.draft_variables !== undefined) {
    Object.assign(result, configObject(settings.draft_variables, 'draft_variables'))
  }
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

function pollConfiguredVideo(
  externalId: string,
  settings: Settings,
  provider: GenerationProvider,
  headers: Record<string, string>,
  projectId: string,
): Promise<GenerationResult> {
  const success = Array.isArray(settings.success_statuses) ? settings.success_statuses.map(String) : ['succeeded', 'completed']
  const failure = Array.isArray(settings.failure_statuses) ? settings.failure_statuses.map(String) : ['failed', 'cancelled']
  const getPath = settingString(settings, 'get_path').replaceAll('{id}', encodeURIComponent(externalId))
  return pollTask(externalId,
    () => requestJson('GET', apiUrl(provider.base_url, getPath), headers),
    (result) => {
      const status = String(nested(result, settingString(settings, 'status_path', 'status')))
      const videoUrl = success.includes(status) ? String(nested(result, settingString(settings, 'result_path', 'output.url'))) : undefined
      return { status: success.includes(status) ? 'succeeded' : failure.includes(status) ? 'failed' : status, videoUrl }
    },
    Number(settings.poll_seconds ?? 10), projectId)
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
): Promise<GenerationResult> {
  const settings = asSettings(model)
  const authHeader = provider.auth_header || 'Authorization'
  const authPrefix = provider.auth_prefix ?? 'Bearer '
  const headers = key ? { [authHeader]: `${authPrefix}${key}` } : {}
  if (model.modality === 'video' && request._external_id) {
    return pollConfiguredVideo(request._external_id, settings, provider, headers, projectId)
  }
  const images = await Promise.all(references.map(referenceImage))
  const variables: Variables = modeVariables(settings, request)
  variables.model = model.remote_id
  variables.image = images[0] ?? null
  variables.images = images.length ? images : null
  variables.size = request.resolution || settings.default_resolution || settings.size || null

  const roleMap = settings.reference_roles && typeof settings.reference_roles === 'object' && !Array.isArray(settings.reference_roles)
    ? settings.reference_roles as Settings : {}
  const configuredRoles = roleMap[request.mode ?? 'text']
  const roles = Array.isArray(configuredRoles) ? configuredRoles.map(String) : []
  if (settings.image_reference_template && images.length && roles.length === 0) throw new Error('当前模式未配置参考图角色')
  if (settings.image_reference_template && images.length > roles.length && roles.length !== 1) throw new Error('当前模式的参考图角色数量不足')
  variables.image_references = settings.image_reference_template
    ? images.map((image, index) => compactTemplate(renderTemplate(
      settings.image_reference_template,
      { ...variables, image, role: roles[Math.min(index, roles.length - 1)] },
    ))) : []
  variables.video_references = variables.reference_video_url && settings.video_reference_template
    ? [compactTemplate(renderTemplate(settings.video_reference_template, variables))] : []
  variables.content = settings.content_template
    ? renderContentTemplate(settings.content_template, variables) : null

  if (model.modality !== 'video') {
    const payload = await requestJson('POST', apiUrl(provider.base_url, settingString(settings, 'request_path')), headers,
      compactTemplate(renderTemplate(requestTemplate(settings, request, { model: '{{model}}', prompt: '{{prompt}}' }), variables)),
      model.modality)
    if (model.modality === 'text') {
      return { path: await saveBytes(projectId, '.txt', Buffer.from(responseText(payload, settings, model.protocol))), remoteUrl: null }
    }
    return consumeImage(projectId, payload, settings, onImageUrl)
  }

  let externalId = request._external_id
  if (!externalId) {
    const body = compactTemplate(renderTemplate(requestTemplate(settings, request, { model: '{{model}}', prompt: '{{prompt}}' }), variables))
    const created = await requestJson('POST', apiUrl(provider.base_url, settingString(settings, 'create_path')), headers, body)
    externalId = String(nested(created, settingString(settings, 'id_path', 'id')))
    if (!externalId || externalId === 'undefined' || externalId === 'null') throw new Error('视频模型没有返回任务 ID')
    await onExternalId(externalId)
  }
  return pollConfiguredVideo(externalId, settings, provider, headers, projectId)
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
): Promise<GenerationResult> {
  if (provider.adapter === 'demo') throw new Error('演示模型已停用')
  const key = (resolveApiKey ? await resolveApiKey(provider) : '') || ''
  return configuredNetwork(model, provider, request, references, projectId, onExternalId, key, onImageUrl)
}
