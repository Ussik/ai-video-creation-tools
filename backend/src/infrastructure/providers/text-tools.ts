import { createTextToolTransport, type GenerationModel, type GenerationProvider, type TextRequestMetrics } from './providers.js'
import { compactToolHistory, contextPressureShare, deduplicateToolHistory } from './text-tool-history.js'
import { estimateTextRequestTokens } from './text-context.js'
import { resolveTextApiSettings, textOutputMode } from '@video-studio/shared/models/text-api-settings'
import { resolveTextCapabilities, scopeTextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { retryReadOnlyRequest } from '../../modules/generation/read-only-retry.js'
import { runModelStep } from '../../modules/generation/model-execution.js'
import { generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'

export type TextTool = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCall = { id: string; name: string; arguments: string }
export type ToolOutput = { id: string; output: string }
export type ToolTurn = { text: string; calls: ToolCall[]; history: unknown[]; initial_history_length?: number; metrics: import('./providers.js').TextRequestMetrics }

/** True when the estimated complete request plus the reserved output exceeds a share of the stated context window.
 * Unknown capacity is never guessed: without a configured window this is always false. */
function contextPressure(model: GenerationModel, provider: GenerationProvider, prompt: string, tools: TextTool[], history: unknown[], outputs: ToolOutput[], continuation?: string): boolean {
  try {
    const raw = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
    const settings = resolveTextApiSettings(scopeTextCapabilities(raw ?? {}, {
      base_url: typeof raw?.api_base_url === 'string' ? raw.api_base_url : provider.base_url ?? '', protocol: model.protocol ?? '', remote_id: model.remote_id ?? '',
    }), model.protocol ?? '')
    const { limits } = resolveTextCapabilities(settings)
    const template = settings.stream_request_template ?? settings.request_template
    const body = template && typeof template === 'object' && !Array.isArray(template) ? template as Record<string, unknown> : {}
    const cap = model.protocol === 'responses' ? body.max_output_tokens : body.max_completion_tokens ?? body.max_tokens
    const reserve = textOutputMode(settings) === 'auto' ? Math.min(8192, limits.output_tokens ?? 8192)
      : typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : typeof settings.output_reserve_tokens === 'number' ? settings.output_reserve_tokens : 0
    const estimate = estimateTextRequestTokens({ prompt, tools, history, outputs, continuation })
    if (limits.input_tokens !== undefined && estimate > limits.input_tokens * contextPressureShare) return true
    return limits.budget_mode === 'shared' && limits.context_tokens !== undefined
      && estimate + reserve > limits.context_tokens * contextPressureShare
  } catch { return false }
}

/** History is private to the provider session. Responses reasoning items and
 * Chat Completions reasoning_content are relayed, never displayed to users. */
export function textToolSession(model: GenerationModel, provider: GenerationProvider, prompt: string,
  tools: TextTool[], key: (provider: GenerationProvider) => string, signal?: AbortSignal, onText?: (text: string) => void,
  onMetrics?: (metrics: TextRequestMetrics) => void, options: { compactHistory?: boolean; parallelCalls?: boolean; onDispatch?: (metrics: TextRequestMetrics) => void } = {}) {
  let history: unknown[] | undefined
  let initialLength = 0
  return async (outputs: ToolOutput[] = [], continuation?: string): Promise<ToolTurn> => {
    signal?.throwIfAborted()
    // Native Messages history includes signed thinking and nested tool pairs.
    // The OpenAI compactor cannot rewrite those authenticated content blocks.
    const nativeMessages = model.protocol === 'anthropic_messages'
    const uniqueHistory = history ? nativeMessages ? structuredClone(history) : deduplicateToolHistory(history, outputs) : undefined
    // Bounded precision-edit sessions retain exact read evidence. Summarizing
    // their document bodies would invalidate their read/patch relationship.
    // The decision uses the complete next request (prompt, tool definitions, relayed history), not just the tool
    // history: when it approaches the stated context window, compact locally first. No model call is added.
    const pressure = uniqueHistory !== undefined && contextPressure(model, provider, prompt, tools, uniqueHistory, outputs, continuation)
    const preparedHistory = uniqueHistory && !nativeMessages && options.compactHistory !== false
      ? await compactToolHistory(uniqueHistory, initialLength, model, provider, key, signal, onMetrics, pressure) : uniqueHistory
    // Retry only the pending model decision. Tool execution is outside this
    // session, and neither partial calls nor failed histories are committed.
    const result = await runModelStep('tool_decision', signal, () => retryReadOnlyRequest(
      () => createTextToolTransport(model, provider, prompt, tools, preparedHistory, outputs, key, signal, onText, continuation, onMetrics, { parallelCalls: options.parallelCalls, onDispatch: options.onDispatch }),
      { signal, onRetry: () => onText?.('模型连接暂时中断，正在重试当前请求；已完成的操作会保留。') },
    ), generationStepBudgets.discussion, '当前工具决策请求超时（5 分钟），已保留完成步骤，请检查后继续。')
    history = result.history
    initialLength = result.initial_history_length || initialLength
    return result
  }
}
