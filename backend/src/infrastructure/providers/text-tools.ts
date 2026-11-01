import { createTextToolTransport, type GenerationModel, type GenerationProvider, type TextRequestMetrics } from './providers.js'
import { compactToolHistory, deduplicateToolHistory } from './text-tool-history.js'
import { retryReadOnlyRequest } from '../../modules/generation/read-only-retry.js'
import { runModelStep } from '../../modules/generation/model-execution.js'
import { generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'

export type TextTool = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCall = { id: string; name: string; arguments: string }
export type ToolOutput = { id: string; output: string }
export type ToolTurn = { text: string; calls: ToolCall[]; history: unknown[]; initial_history_length?: number; metrics: import('./providers.js').TextRequestMetrics }

/** History is private to the provider session. Responses reasoning items and
 * Chat Completions reasoning_content are relayed, never displayed to users. */
export function textToolSession(model: GenerationModel, provider: GenerationProvider, prompt: string,
  tools: TextTool[], key: (provider: GenerationProvider) => string, signal?: AbortSignal, onText?: (text: string) => void,
  onMetrics?: (metrics: TextRequestMetrics) => void, options: { compactHistory?: boolean } = {}) {
  let history: unknown[] | undefined
  let initialLength = 0
  return async (outputs: ToolOutput[] = [], continuation?: string): Promise<ToolTurn> => {
    signal?.throwIfAborted()
    const uniqueHistory = history ? deduplicateToolHistory(history, outputs) : undefined
    // Bounded precision-edit sessions retain exact read evidence. Summarizing
    // their document bodies would invalidate their read/patch relationship.
    const preparedHistory = uniqueHistory && options.compactHistory !== false
      ? await compactToolHistory(uniqueHistory, initialLength, model, provider, key, signal, onMetrics) : uniqueHistory
    // Retry only the pending model decision. Tool execution is outside this
    // session, and neither partial calls nor failed histories are committed.
    const result = await runModelStep('tool_decision', signal, () => retryReadOnlyRequest(
      () => createTextToolTransport(model, provider, prompt, tools, preparedHistory, outputs, key, signal, onText, continuation, onMetrics),
      { signal, onRetry: () => onText?.('模型连接暂时中断，正在重试当前请求；已完成的操作会保留。') },
    ), generationStepBudgets.discussion, '当前工具决策请求超时（5 分钟），已保留完成步骤，请检查后继续。')
    history = result.history
    initialLength = result.initial_history_length || initialLength
    return result
  }
}
