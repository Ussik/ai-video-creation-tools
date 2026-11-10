export type TextFailureReason = 'output_limit' | 'context_overflow' | 'disconnected' | 'refusal' | 'invalid_tool' | 'invalid_response' | 'upstream_error' | 'cancelled'
export type TextDeliveryState = 'not_sent' | 'rejected' | 'accepted' | 'output_started' | 'completed' | 'unknown'

export function textFailureReason(raw?: string): TextFailureReason {
  if (/^(?:max_output_tokens|length|max_tokens|MAX_TOKENS)$/.test(raw || '')) return 'output_limit'
  if (/^(?:context_length_exceeded|context_window_exceeded|input_too_long|prompt_too_long|context_capacity_exceeded)$/.test(raw || '')) return 'context_overflow'
  if (/^(?:stream_disconnected|connection_error|headers_timeout|first_event_timeout|event_idle_timeout)$/.test(raw || '')) return 'disconnected'
  if (/^(?:content_filter|refusal|SAFETY|RECITATION|PROHIBITED_CONTENT)$/.test(raw || '')) return 'refusal'
  if (/^(?:invalid_tool_call|malformed_function_call|MALFORMED_FUNCTION_CALL)$/.test(raw || '')) return 'invalid_tool'
  if (raw === 'bad_response_body' || raw === 'response_frame_too_large') return 'invalid_response'
  if (raw === 'cancelled') return 'cancelled'
  return 'upstream_error'
}

/** Machine-readable transport failures. Callers decide whether their operation
 * is read-only and safe to retry; provider adapters never replay tools. */
export class TextProviderError extends Error {
  readonly statusCode = 502
  failureReason: TextFailureReason
  rawReason?: string
  delivery: TextDeliveryState = 'unknown'
  partialText?: string
  outputStarted = false
  constructor(message: string, public readonly retryable: boolean, public readonly upstreamCode?: string,
    public readonly upstreamStatus?: number, options?: ErrorOptions, public readonly retryAfterMs?: number) {
    super(message, options)
    this.name = 'TextProviderError'
    this.failureReason = textFailureReason(upstreamCode)
    this.rawReason = upstreamCode
  }
}

export type TextOutputLimitUsage = Readonly<{
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
}>

export type TextOutputLimitReason = 'max_output_tokens' | 'length'
export type TextOutputLimitKind = 'text' | 'reasoning' | 'tool_arguments'

function reasoningExhausted(partialText: string, usage?: TextOutputLimitUsage) {
  return partialText === '' && Number.isSafeInteger(usage?.output_tokens) &&
    (usage?.output_tokens ?? 0) > 0 && usage?.reasoning_tokens === usage?.output_tokens
}

/** A complete transport response whose generated text exceeded the output
 * budget. Only the text-generation caller may decide whether to continue it;
 * retrying the same request would discard work and repeat the same failure. */
export class TextOutputLimitError extends TextProviderError {
  readonly outputLimitKind: TextOutputLimitKind
  constructor(public readonly partialText: string, public readonly reason: TextOutputLimitReason,
    public readonly usage?: TextOutputLimitUsage, public readonly outputLimit?: number) {
    const reasoning = reasoningExhausted(partialText, usage)
    super(reasoning ? '模型输出不完整：推理已耗尽输出预算，未返回答案' : '模型输出不完整：已达到模型输出长度上限', false, reason)
    this.name = 'TextOutputLimitError'
    this.delivery = 'completed'; this.outputStarted = partialText.length > 0
    this.outputLimitKind = reasoning ? 'reasoning' : 'text'
  }
}

/** Tool output is diagnostic only: truncated arguments never become a
 * continuable text draft or an executable tool call. */
export class TextToolOutputLimitError extends TextProviderError {
  readonly outputLimitKind: TextOutputLimitKind
  constructor(public readonly reason: TextOutputLimitReason, public readonly usage?: TextOutputLimitUsage,
    public readonly outputLimit?: number, visibleText = '') {
    const reasoning = reasoningExhausted(visibleText, usage)
    super(reasoning ? '模型输出被截断，未执行工具调用：推理已耗尽输出预算，未返回完整工具调用'
      : '模型输出被截断，未执行工具调用：已达到模型输出长度上限', false, reason)
    this.name = 'TextToolOutputLimitError'
    this.delivery = 'completed'; this.outputStarted = visibleText.length > 0
    this.outputLimitKind = reasoning ? 'reasoning' : 'tool_arguments'
  }
}

export function textRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms) : undefined
}

export function transientTextStatus(status: number, code = '') {
  if (['insufficient_quota', 'billing_hard_limit_reached', 'invalid_api_key', 'bad_response_body'].includes(code)) return false
  return [408, 429, 500, 502, 503, 504, 529].includes(status)
}

export function transientTextNetworkError(issue: unknown): boolean {
  let current = issue
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, cause, message } = current as { code?: string; cause?: unknown; message?: string }
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code || '')) return true
    if (current instanceof TypeError && ['fetch failed', 'terminated'].includes(message || '')) return true
    current = cause
  }
  return false
}

/** Partial text is diagnostic input to a business validator, never an accepted result.
 * Tool argument failures deliberately never expose a continuable partialText. */
export function annotateTextFailure(issue: unknown, state: { partialText?: string; delivery: TextDeliveryState; rawReason?: string; tool?: boolean }): unknown {
  if (!(issue instanceof TextProviderError)) return issue
  issue.delivery = state.delivery
  issue.outputStarted = !!state.partialText
  if (!state.tool && !(issue instanceof TextToolOutputLimitError) && state.partialText !== undefined) issue.partialText = state.partialText
  if (state.rawReason) { issue.rawReason = state.rawReason; const reason = textFailureReason(state.rawReason); if (reason !== 'upstream_error' || issue.failureReason === 'upstream_error') issue.failureReason = reason }
  return issue
}

/** Recognize documented input overflow, never treat any generic 400 as overflow. */
export function confirmedContextOverflow(status: number, code: string, message: string): boolean {
  return textFailureReason(code) === 'context_overflow' || [400, 413, 422].includes(status) &&
    /prompt is too long|input (?:is )?too long|maximum context length|exceeds? (?:the )?(?:context window|maximum input tokens)|输入[^。\n]{0,30}超过[^。\n]{0,20}(?:上下文|token)/i.test(message)
}
