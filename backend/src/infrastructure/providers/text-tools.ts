import { createTextToolTransport, type GenerationModel, type GenerationProvider, type TextRequestMetrics } from './providers.js'
import { compactToolHistory, deduplicateToolHistory } from './text-tool-history.js'

export type TextTool = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCall = { id: string; name: string; arguments: string }
export type ToolOutput = { id: string; output: string }
export type ToolTurn = { text: string; calls: ToolCall[]; history: unknown[]; initial_history_length?: number; metrics: import('./providers.js').TextRequestMetrics }

/** History is private to the provider session. Responses reasoning items and
 * Chat Completions reasoning_content are relayed, never displayed to users. */
export function textToolSession(model: GenerationModel, provider: GenerationProvider, prompt: string,
  tools: TextTool[], key: (provider: GenerationProvider) => string, signal?: AbortSignal, onText?: (text: string) => void,
  onMetrics?: (metrics: TextRequestMetrics) => void) {
  let history: unknown[] | undefined
  let initialLength = 0
  return async (outputs: ToolOutput[] = [], continuation?: string): Promise<ToolTurn> => {
    if (history) {
      history = deduplicateToolHistory(history, outputs)
      history = await compactToolHistory(history, initialLength, model, provider, key, signal, onMetrics)
    }
    const result = await createTextToolTransport(model, provider, prompt, tools, history, outputs, key, signal, onText, continuation, onMetrics)
    history = result.history
    initialLength = result.initial_history_length || initialLength
    return result
  }
}
