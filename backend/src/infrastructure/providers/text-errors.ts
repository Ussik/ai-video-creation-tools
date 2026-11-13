export type TextProviderFailureDiagnostics = Readonly<{
  upstream_message?: string
  upstream_request_id?: string
  http_status?: number
  elapsed_ms: number
  response_chars: number
  partial_text_incomplete: boolean
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}>

/** Machine-readable transport failures. Callers decide whether their operation
 * is read-only and safe to retry; provider adapters never replay tools. */
export class TextProviderError extends Error {
  readonly statusCode = 502
  diagnostics?: string
  /** Visible response text only; incomplete and never a validated result. */
  raw_output?: string
  providerDiagnostics?: TextProviderFailureDiagnostics
  constructor(message: string, public readonly retryable: boolean, public readonly upstreamCode?: string,
    public readonly upstreamStatus?: number, options?: ErrorOptions, public readonly retryAfterMs?: number) {
    super(message, options)
    this.name = 'TextProviderError'
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
