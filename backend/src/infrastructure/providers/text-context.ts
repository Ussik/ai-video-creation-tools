import { textContextSettings } from '@video-studio/shared/models/text-context-settings'
import { TextProviderError } from './text-errors.js'

export type TextContextEstimate = { estimated_input_tokens: number; context_window_tokens?: number; reserved_output_tokens?: number }

export class TextContextCapacityError extends TextProviderError {
  constructor(message: string, public readonly estimate?: TextContextEstimate) {
    super(message, false, 'context_capacity_exceeded')
    this.name = 'TextContextCapacityError'
  }
}

/** A conservative estimate, not a provider tokenizer or a capacity guarantee.
 * Count Unicode code points (not UTF-16 units), allowing more tokens for CJK
 * and emoji than Latin prose. Include the complete wire JSON so instructions,
 * schemas, tool definitions/results and relayed history cannot escape checks.
 * The 10% margin and small framing allowance cover protocol overhead without
 * treating every ASCII byte as a token and rejecting ordinary short inputs. */
export function estimateTextRequestTokens(body: unknown): number {
  const text = JSON.stringify(body) ?? ''
  let count = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    count += point <= 0x7f ? /[A-Za-z]/.test(char) ? 1 / 3 : /\s/.test(char) ? 1 / 4 : 1 / 2
      : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 1.5
        : point > 0xffff ? 3 : 2
  }
  return Math.ceil(count * 1.1) + 32
}

/** Honor the actual outgoing output cap, including legacy max_tokens. An
 * explicit fallback reserve budgets an unknown server default; it never
 * changes the request's output limit or silently truncates input. */
export function assertTextRequestCapacity(settings: Record<string, unknown>, body: unknown, protocol?: string): TextContextEstimate {
  let configured: ReturnType<typeof textContextSettings>
  try { configured = textContextSettings(settings) }
  catch (issue) { throw new TextContextCapacityError(`文本模型容量配置有误：${issue instanceof Error ? issue.message : String(issue)}`) }
  const estimate: TextContextEstimate = { estimated_input_tokens: estimateTextRequestTokens(body),
    ...(configured.context_window_tokens === undefined ? {} : { context_window_tokens: configured.context_window_tokens }) }
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const output = protocol === 'responses' ? request.max_output_tokens
    : protocol === 'chat_completions' ? request.max_completion_tokens ?? request.max_tokens
      : request.max_output_tokens ?? request.max_completion_tokens ?? request.max_tokens
  if (output !== undefined && (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0)) {
    if (configured.context_window_tokens !== undefined) throw new TextContextCapacityError('文本模型请求的输出上限必须为正整数 token 数，当前无法核算上下文预算。请检查请求模板中的输出上限。', estimate)
  } else if (typeof output === 'number') estimate.reserved_output_tokens = output
  estimate.reserved_output_tokens ??= configured.output_reserve_tokens
  // Unknown capacity stays explicitly unknown. Never infer a limit from an ID.
  if (configured.context_window_tokens === undefined) return estimate
  if (estimate.reserved_output_tokens === undefined) throw new TextContextCapacityError('已配置文本模型上下文容量，但请求未设置输出上限，也未配置输出预留，无法核算完整预算。请在模型设置中按厂商实际限制填写输出预留，或在请求模板中配置输出上限。', estimate)
  const total = estimate.estimated_input_tokens + estimate.reserved_output_tokens
  if (total > configured.context_window_tokens) throw new TextContextCapacityError(
    `文本模型上下文预算不足：完整请求输入估算约 ${estimate.estimated_input_tokens.toLocaleString('en-US')} tokens，输出预留 ${estimate.reserved_output_tokens.toLocaleString('en-US')} tokens，合计约 ${total.toLocaleString('en-US')}，超过已配置容量 ${configured.context_window_tokens.toLocaleString('en-US')} tokens。估算包含工具、历史和结构化格式，并非厂商精确分词。请切换经确认容量足够的模型，或按厂商文档核对模型容量与输出配置。原稿和输出上限未被自动缩减；相同配置直接重试无法解决。`, estimate)
  return estimate
}
