import { createTextToolTransport, type GenerationModel, type GenerationProvider } from './providers.js'

export type TextTool = { name: string; description: string; parameters: Record<string, unknown> }
export type ToolCall = { id: string; name: string; arguments: string }
export type ToolOutput = { id: string; output: string }
export type ToolTurn = { text: string; calls: ToolCall[]; history: unknown[] }

/** History is private to the provider session. Responses reasoning items and
 * Chat Completions reasoning_content are relayed, never displayed to users. */
export function textToolSession(model: GenerationModel, provider: GenerationProvider, prompt: string,
  tools: TextTool[], key: (provider: GenerationProvider) => string, signal?: AbortSignal, onText?: (text: string) => void) {
  let history: unknown[] | undefined
  return async (outputs: ToolOutput[] = [], continuation?: string): Promise<ToolTurn> => {
    const result = await createTextToolTransport(model, provider, prompt, tools, history, outputs, key, signal, onText, continuation)
    history = result.history
    return result
  }
}
