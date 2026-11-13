import { beforeMediaDispatch, mediaExecutionSignal } from './media-execution.js'
import { modelStepSignal } from '../../modules/generation/model-execution.js'
import { observeProviderFetch } from './text-request-plan.js'
import { randomUUID } from 'node:crypto'

export interface SpeechSynthesisInput {
  api_key: string
  text: string
  speaker: string
  instructions?: string
  context_text?: string
  speech_rate?: number
  /** Persisted by the caller before dispatch; correlation, not provider idempotency. */
  request_id?: string
  signal?: AbortSignal
}

export interface SpeechWordTimestamp {
  text: string
  start_ms: number
  end_ms: number
}

export interface SpeechSynthesisResult {
  audio: Buffer
  duration_ms: number | null
  subtitles: SpeechWordTimestamp[]
  usage_characters: number | null
  request_id: string
}

export const speechRequestTimeoutMs = 180_000
export const maxSpeechResponseBytes = 30 * 1024 * 1024
const endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const successCode = 20_000_000
class SpeechProviderError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function validatedInput(input: SpeechSynthesisInput): SpeechSynthesisInput {
  const key = input.api_key.trim()
  if (!key || /[\r\n]/.test(key)) throw new Error('请先配置有效的语音 API Key。')
  if (!input.text.trim()) throw new Error('请输入需要合成的台词或旁白。')
  const speaker = input.speaker.trim()
  if (!speaker || /[\r\n]/.test(speaker)) throw new Error('请选择标准音色。')
  if (/^S_/i.test(speaker)) throw new Error('当前仅支持标准音色，请选择官方标准 Speaker ID。')
  if (input.speech_rate !== undefined && (!Number.isInteger(input.speech_rate) || input.speech_rate < -50 || input.speech_rate > 100)) {
    throw new Error('语速参数必须是 -50 到 100 之间的整数。')
  }
  return { ...input, api_key: key, speaker }
}

function timeoutError(): Error {
  return new SpeechProviderError('语音生成超时（最长等待 3 分钟）。服务可能已处理本次请求，请核对记录后再手动重试。')
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(timeoutError())
    if (signal.aborted) { reject(timeoutError()); return }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function httpError(status: number): Error {
  const advice = status === 401 || status === 403
    ? '请检查语音 API Key、所属项目和语音合成 2.0 开通状态。'
    : status === 429 ? '请检查语音服务额度或稍后手动重试。' : '请检查语音服务调用记录。'
  return new SpeechProviderError(`语音服务请求失败（HTTP ${status}）。${advice}`)
}

/** Uses one paid request and never automatically retries it. Provider error bodies are not exposed. */
export async function synthesizeSpeech(rawInput: SpeechSynthesisInput, fetchImpl: typeof fetch = fetch): Promise<SpeechSynthesisResult> {
  const input = validatedInput(rawInput)
  const performance = [input.instructions?.trim(), input.context_text?.trim()
    ? `情境参考（不要朗读）：\n${input.context_text.trim()}` : ''].filter(Boolean).join('\n')
  const requestId = input.request_id ?? randomUUID()
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) throw new Error('语音请求编号无效，未发送。')
  const controller = new AbortController()
  const parent = modelStepSignal(input.signal ?? mediaExecutionSignal())
  const abortParent = () => controller.abort(parent!.reason)
  if (parent?.aborted) abortParent()
  else parent?.addEventListener('abort', abortParent, { once: true })
  const timer = setTimeout(() => controller.abort(), speechRequestTimeoutMs)
  timer.unref()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let completed = false
  let dispatched = false
  try {
    beforeMediaDispatch(requestId)
    dispatched = true
    const response = await withAbort(observeProviderFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': input.api_key,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Request-Id': requestId,
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      body: JSON.stringify({
        req_params: {
          text: input.text,
          speaker: input.speaker,
          audio_params: { format: 'mp3', sample_rate: 24_000, enable_subtitle: true,
            ...(input.speech_rate === undefined ? {} : { speech_rate: input.speech_rate }) },
          ...(performance ? { additions: JSON.stringify({ context_texts: [performance] }) } : {}),
        },
      }),
      signal: controller.signal,
    }, 'speech_create', fetchImpl, { remote_id: 'seed-tts-2.0' }), controller.signal)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw httpError(response.status)
    }
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxSpeechResponseBytes) {
      void response.body?.cancel().catch(() => {})
      throw new SpeechProviderError('语音服务响应超过 30 MB，请缩短台词后重新生成。')
    }
    if (!response.body) throw new SpeechProviderError('语音服务没有返回音频数据。')
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const audioChunks: Buffer[] = []
    const subtitles: SpeechWordTimestamp[] = []
    const subtitleKeys = new Set<string>()
    let usageCharacters: number | null = null
    let receivedBytes = 0
    let audioBytes = 0
    let pending = ''

    const consume = (line: string) => {
      if (!line.trim()) return
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new SpeechProviderError('语音服务返回的数据格式无效。') }
      const message = record(parsed)
      if (!message || !Number.isInteger(message.code)) throw new SpeechProviderError('语音服务返回的数据格式无效。')
      if (message.code !== 0 && message.code !== successCode) {
        // Only the numeric code is safe to persist; some provider messages echo request content.
        throw new SpeechProviderError(`语音服务生成失败（错误码 ${message.code}）。请检查音色、服务权限与额度。`)
      }
      if (typeof message.data === 'string' && message.data.length > 0) {
        if (message.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) {
          throw new SpeechProviderError('语音服务返回的音频数据无效。')
        }
        const chunk = Buffer.from(message.data, 'base64')
        audioBytes += chunk.length
        if (audioBytes > maxSpeechResponseBytes) throw new SpeechProviderError('语音服务音频超过 30 MB，请缩短台词后重新生成。')
        audioChunks.push(chunk)
      } else if (message.data !== undefined && message.data !== null && message.data !== '') {
        throw new SpeechProviderError('语音服务返回的音频数据无效。')
      }
      const sentence = record(message.sentence)
      if (Array.isArray(sentence?.words)) for (const value of sentence.words) {
        const word = record(value)
        const start = positiveNumber(word?.startTime)
        const end = positiveNumber(word?.endTime)
        if (!word || typeof word.word !== 'string' || start === null || end === null || end < start) continue
        const timestamp = { text: word.word, start_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000) }
        const key = JSON.stringify(timestamp)
        if (!subtitleKeys.has(key)) { subtitleKeys.add(key); subtitles.push(timestamp) }
      }
      const usage = record(message.usage)
      const characters = positiveNumber(usage?.text_words)
      if (characters !== null) usageCharacters = characters
      if (message.code === successCode) completed = true
    }

    while (!completed) {
      const part = await withAbort(reader.read(), controller.signal)
      if (part.done) {
        try { pending += decoder.decode() } catch { throw new SpeechProviderError('语音服务返回的数据编码无效。') }
        if (pending.trim()) consume(pending)
        break
      }
      receivedBytes += part.value.byteLength
      if (receivedBytes > maxSpeechResponseBytes) throw new SpeechProviderError('语音服务响应超过 30 MB，请缩短台词后重新生成。')
      try { pending += decoder.decode(part.value, { stream: true }) } catch { throw new SpeechProviderError('语音服务返回的数据编码无效。') }
      let newline = pending.indexOf('\n')
      while (newline !== -1 && !completed) {
        consume(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    if (!completed) throw new SpeechProviderError('语音服务连接提前结束，尚未确认生成完成。请核对调用记录后再手动重试。')
    if (audioBytes === 0) throw new SpeechProviderError('语音服务已结束，但没有返回音频。')
    // The API documents word offsets, not an audio-duration field. Actual duration is probed after storage.
    return { audio: Buffer.concat(audioChunks, audioBytes), duration_ms: null,
      subtitles, usage_characters: usageCharacters, request_id: requestId }
  } catch (error) {
    if (parent?.aborted) throw parent.reason
    if (!dispatched) throw error
    const failure = controller.signal.aborted ? timeoutError() : error instanceof SpeechProviderError ? error
      : new SpeechProviderError('语音服务连接失败，请检查网络与调用记录后再手动重试。')
    // Correlation survives failures; the vendor does not promise idempotency for this ID.
    failure.message += `（请求编号：${requestId}）`
    throw Object.assign(failure, { code: 'speech_provider_error', provider_request_id: requestId, delivery: 'unknown' as const })
  } finally {
    parent?.removeEventListener('abort', abortParent)
    clearTimeout(timer)
    // An intentional terminal-frame stop precedes internal controller cleanup,
    // so transport diagnostics do not misclassify a successful stop as user cancellation.
    if (reader) void reader.cancel().catch(() => {})
    controller.abort()
  }
}
