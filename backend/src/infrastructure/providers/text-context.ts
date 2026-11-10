import { textContextSettings } from '@video-studio/shared/models/text-context-settings'
import { resolveTextCapabilities, type TextBudgetMode, type TextCapabilitySource } from '@video-studio/shared/models/text-capabilities'
import { textOutputMode } from '@video-studio/shared/models/text-api-settings'
import { TextProviderError } from './text-errors.js'
import { textImageCapacityBody } from './text-image-input.js'
import { textVideoCapacityBody } from './text-video-input.js'

export type TextContextEstimate = {
  estimated_input_tokens: number
  context_window_tokens?: number
  input_limit_tokens?: number
  output_limit_tokens?: number
  reserved_output_tokens?: number
  budget_mode?: TextBudgetMode
  input_count_method?: 'estimate' | 'provider' | 'estimated_fallback'
  capacity_status?: 'validated' | 'estimated' | 'partial' | 'unknown'
  output_source?: 'auto' | 'fixed' | 'upstream' | 'template' | 'reserve'
  framing_reserve_tokens?: number
  capability_source?: TextCapabilitySource
}
export type TextRequestPlanOptions = {
  estimateBody?: unknown
  inputTokens?: number
  countMethod?: 'estimate' | 'provider' | 'estimated_fallback'
  purpose?: string
  visualInputTokens?: number
  /** Explicit task allowance, independent of the model capability. */
  outputTokens?: number
  minimumOutputTokens?: number
}
export type TextRequestPlan = { body: Record<string, unknown>; capacity: TextContextEstimate }

export class TextContextCapacityError extends TextProviderError {
  constructor(message: string, public readonly estimate?: TextContextEstimate) {
    super(message, false, 'context_capacity_exceeded')
    this.name = 'TextContextCapacityError'
  }
}

/** Conservative local estimator; this is not a provider tokenizer. Count
 * Unicode code points with an allowance for model framing. Callers that need
 * HTTP size diagnostics should count bytes independently of model input. */
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

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const outputKeys = ['max_output_tokens', 'max_completion_tokens', 'max_tokens'] as const
function outgoingOutput(body: Record<string, unknown>, protocol?: string): unknown {
  return protocol === 'responses' ? body.max_output_tokens : protocol === 'chat_completions' ? body.max_completion_tokens ?? body.max_tokens
    : protocol === 'anthropic_messages' ? body.max_tokens : body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
}
function outputField(settings: Record<string, unknown>, protocol?: string): string {
  const api = record(settings.text_api) ? settings.text_api : {}
  return protocol === 'responses' ? 'max_output_tokens' : protocol === 'anthropic_messages' ? 'max_tokens'
    : api.chat_output_field === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens'
}

/** Actual model input only. Output limits, model IDs and transport controls do
 * not consume input tokens; prompts, history, tools and format schemas do. */
export function textRequestInput(body: unknown): unknown {
  if (!record(body)) return textVideoCapacityBody(textImageCapacityBody(body))
  const input: Record<string, unknown> = {}
  for (const field of ['input', 'messages', 'prompt', 'system', 'instructions', 'tools', 'functions', 'tool_choice', 'response_format'] as const) {
    if (body[field] !== undefined) input[field] = body[field]
  }
  if (record(body.text) && body.text.format !== undefined) input.text = { format: body.text.format }
  if (record(body.output_config) && body.output_config.format !== undefined) input.output_config = { format: body.output_config.format }
  // Unknown custom templates retain conservative accounting rather than
  // silently treating their non-standard input contract as empty.
  return textVideoCapacityBody(textImageCapacityBody(Object.keys(input).length ? input : Object.fromEntries(Object.entries(body).filter(([key]) =>
    !['model', 'temperature', 'top_p', 'stream', 'stream_options', 'reasoning', 'reasoning_effort', 'thinking', 'output_config', ...outputKeys].includes(key)))))
}

/** Native media can arrive in static templates or relayed tool history as well
 * as the request's image helper. Inspect the actual input so those paths have
 * the same image allowance; bytes are never treated as text-token evidence. */
function inputMedia(value: unknown): { images: number; video: boolean } {
  if (Array.isArray(value)) return value.reduce<{ images: number; video: boolean }>((count, item) => {
    const next = inputMedia(item)
    return { images: count.images + next.images, video: count.video || next.video }
  }, { images: 0, video: false })
  if (!record(value)) return { images: 0, video: false }
  if (value.type === 'image' && record(value.source) || value.type === 'input_image' && (value.image_url !== undefined || value.file_id !== undefined)
    || value.type === 'image_url' && value.image_url !== undefined) return { images: 1, video: false }
  if (value.type === 'input_video' || value.type === 'video_url') return { images: 0, video: true }
  return inputMedia(Object.values(value))
}

function thinkingEnabled(body: Record<string, unknown>): boolean {
  if (record(body.thinking) && ['enabled', 'adaptive', 'auto'].includes(String(body.thinking.type))) return true
  const effort = record(body.reasoning) ? body.reasoning.effort : body.reasoning_effort
  return typeof effort === 'string' && !['none', 'off', 'disabled'].includes(effort)
}

function taskOutput(purpose: string | undefined): { desired?: number; minimum: number } {
  if (!purpose) return { minimum: 1024 }
  if (/review|audit/i.test(purpose)) return { desired: 32768, minimum: 4096 }
  if (/generation|repair|create|^script_/i.test(purpose)) return { desired: 65536, minimum: 8192 }
  return { desired: 8192, minimum: 1024 }
}
const number = (value: number) => value.toLocaleString('en-US')

/** One request plan controls both the wire output parameter and its budget.
 * Fixed limits are never lowered, and the caller's payload is never mutated. */
export function planTextRequest(settings: Record<string, unknown>, value: unknown, protocol?: string, options: TextRequestPlanOptions = {}): TextRequestPlan {
  if (!record(value)) throw new TextContextCapacityError('文本模型请求模板必须生成 JSON 对象，请检查自定义接口配置。')
  const body = { ...value }
  let legacy: ReturnType<typeof textContextSettings>, capabilities: ReturnType<typeof resolveTextCapabilities>
  try { legacy = textContextSettings(settings, { outputLimitKnown: positive(outgoingOutput(body, protocol)) }); capabilities = resolveTextCapabilities(settings) }
  catch (issue) { throw new TextContextCapacityError(`文本模型容量配置有误：${issue instanceof Error ? issue.message : String(issue)}`) }
  const { limits } = capabilities
  const media = inputMedia(textRequestInput(value))
  const visualTokens = Math.max(options.visualInputTokens ?? 0, media.images * 4096)
  const inputTokens = options.inputTokens ?? estimateTextRequestTokens(textRequestInput(options.estimateBody ?? value)) + visualTokens
  const capacity: TextContextEstimate = { estimated_input_tokens: inputTokens, budget_mode: limits.budget_mode,
    input_count_method: options.countMethod ?? (options.inputTokens !== undefined ? 'provider' : 'estimate'), capability_source: capabilities.source,
    ...(limits.context_tokens === undefined ? {} : { context_window_tokens: limits.context_tokens }),
    ...(limits.input_tokens === undefined ? {} : { input_limit_tokens: limits.input_tokens }),
    ...(limits.output_tokens === undefined ? {} : { output_limit_tokens: limits.output_tokens }) }
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new TextContextCapacityError('文本模型输入计数无效，必须为非负整数 token 数。', capacity)
  const api = record(settings.text_api) && settings.text_api.mode === 'standard' ? settings.text_api : undefined
  const mode = api ? textOutputMode(settings) : undefined
  let output = outgoingOutput(body, protocol)
  if (mode === 'upstream') {
    for (const key of outputKeys) delete body[key]
    output = undefined
    capacity.output_source = 'upstream'
    if (protocol === 'anthropic_messages') throw new TextContextCapacityError('Anthropic Messages 必须发送最大输出 token 数，请选择自动安排或固定额度。', capacity)
  } else if (mode === 'auto') {
    const task = taskOutput(options.purpose)
    const desired = options.outputTokens ?? task.desired ?? limits.output_tokens
    if (!positive(desired)) throw new TextContextCapacityError('自动生成额度缺少配置：渠道生成上限未知，当前任务也没有明确额度。请填写渠道能力、固定额度，或明确选择沿用服务默认。', capacity)
    const minimum = options.minimumOutputTokens ?? Math.min(desired, task.minimum)
    if (!positive(minimum) || minimum > desired) throw new TextContextCapacityError('自动生成额度的最小可用额度必须为不大于任务额度的正整数。', capacity)
    // The tokenizer counts model input; protocol framing may still add a small envelope.
    // The existing local estimator already includes estimation error separately.
    const framing = limits.budget_mode === 'shared' && limits.context_tokens !== undefined ? 128 : 0
    if (framing) capacity.framing_reserve_tokens = framing
    output = Math.min(desired, limits.output_tokens ?? Infinity, limits.budget_mode === 'shared' && limits.context_tokens !== undefined ? limits.context_tokens - inputTokens - framing : Infinity)
    capacity.output_source = 'auto'
    // Keep the attempted cap in failure diagnostics so the counting layer can
    // recognize proximity to the shared input/output boundary before retrying
    // the same plan with a complete provider input count.
    if (positive(output)) capacity.reserved_output_tokens = output
    if (!positive(output) || output < minimum) throw new TextContextCapacityError(
      `文本模型自动生成预算不足：本次输入${capacity.input_count_method === 'provider' ? '计数' : '估算'}约 ${number(inputTokens)} tokens，剩余生成空间 ${number(Math.max(0, output as number))} tokens，小于当前任务最低可用额度 ${number(minimum)} tokens。请按完整单元拆分任务，或核对模型能力；原稿未被自动缩减。`, capacity)
    for (const key of outputKeys) delete body[key]
    body[outputField(settings, protocol)] = output
  } else if (mode === 'fixed') {
    output = api!.max_output_tokens
    for (const key of outputKeys) delete body[key]
    body[outputField(settings, protocol)] = output
  }
  const thinking = record(body.thinking) ? body.thinking : undefined
  if (thinking?.type === 'enabled' && (!positive(thinking.budget_tokens) || positive(output) && thinking.budget_tokens >= output)) throw new TextContextCapacityError('固定思考预算必须为正整数且小于本次最大输出，未自动改写思考预算或固定额度。', capacity)
  if (output !== undefined && !positive(output)) throw new TextContextCapacityError('文本模型请求的输出上限必须为正整数 token 数，当前无法核算上下文预算。请检查请求模板中的输出上限。', capacity)
  if (positive(output)) {
    capacity.reserved_output_tokens = output
    capacity.output_source ??= mode === 'fixed' ? 'fixed' : 'template'
  } else if (legacy.output_reserve_tokens !== undefined) {
    capacity.reserved_output_tokens = legacy.output_reserve_tokens
    capacity.output_source ??= 'reserve'
  } else capacity.output_source ??= 'upstream'
  const reserve = capacity.reserved_output_tokens
  // Reasoning that is included in total output, and cache hits that remain in
  // input, are already represented here. Neither is subtracted or added twice.
  if (limits.input_tokens !== undefined && inputTokens > limits.input_tokens) throw new TextContextCapacityError(
    `文本模型输入预算不足：完整输入${capacity.input_count_method === 'provider' ? '计数' : '估算'}约 ${number(inputTokens)} tokens，超过已配置最大输入 ${number(limits.input_tokens)} tokens。工具、历史和结构化格式均计入输入；原稿未被自动缩减。`, capacity)
  if (positive(output) && limits.output_tokens !== undefined && output > limits.output_tokens) throw new TextContextCapacityError(
    `文本模型生成预算超出能力：实际请求最大输出 ${number(output)} tokens，超过已配置生成上限 ${number(limits.output_tokens)} tokens。固定额度未被自动缩减，请调整请求额度或核对渠道能力。`, capacity)
  if (limits.budget_mode === 'shared' && limits.context_tokens !== undefined) {
    if (reserve === undefined && !capabilities.configured) throw new TextContextCapacityError('已配置文本模型上下文容量，但请求未设置输出上限，也未配置输出预留，无法核算完整预算。请在模型设置中填写实际最大输出，或按厂商实际限制填写高级输出预留。', capacity)
    const total = inputTokens + (reserve ?? 0)
    if (total > limits.context_tokens) throw new TextContextCapacityError(
      `文本模型上下文预算不足：完整请求输入${capacity.input_count_method === 'provider' ? '计数' : '估算'}约 ${number(inputTokens)} tokens，输出预留 ${number(reserve ?? 0)} tokens，合计约 ${number(total)}，超过已配置容量 ${number(limits.context_tokens)} tokens。${capacity.input_count_method === 'provider' ? '输入采用当前渠道计数。' : '估算包含工具、历史和结构化格式，并非厂商精确分词。'}请切换经确认容量足够的模型，或按厂商文档核对模型容量与输出配置。原稿和输出上限未被自动缩减；相同配置直接重试无法解决。`, capacity)
  }
  const complete = limits.budget_mode === 'shared' ? limits.context_tokens !== undefined && positive(output)
    : limits.budget_mode === 'separate' && limits.input_tokens !== undefined && limits.output_tokens !== undefined && positive(output)
  const unbudgetedMedia = media.video && capacity.input_count_method !== 'provider'
  const unbudgetedThinking = limits.output_includes_reasoning === false && thinkingEnabled(body)
  capacity.capacity_status = complete && !unbudgetedMedia && !unbudgetedThinking ? capacity.input_count_method === 'provider' ? 'validated' : 'estimated'
    : limits.context_tokens !== undefined || limits.input_tokens !== undefined || limits.output_tokens !== undefined ? 'partial' : 'unknown'
  return { body, capacity }
}

/** Compatibility assertion shares the planner's rules and never changes the
 * supplied body. New senders must use the returned plan body for auto mode. */
export function assertTextRequestCapacity(settings: Record<string, unknown>, body: unknown, protocol?: string, visualInputTokens = 0): TextContextEstimate {
  return planTextRequest(settings, body, protocol, { visualInputTokens }).capacity
}
