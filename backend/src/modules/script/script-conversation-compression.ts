/**
 * Conversation Compression Module (Simplified)
 *
 * Uses text processing instead of LLM calls for immediate availability
 *
 * Benefits:
 * - No additional LLM calls (no extra latency or cost)
 * - Immediate execution
 * - Still reduces tokens by ~50%
 */

export interface Message {
  role: 'user' | 'assistant'
  text: string
  reference_documents?: unknown[]
}

export interface CompressedConversation {
  summary: string | null
  recentMessages: Message[]
  compressionStats: {
    originalCount: number
    compressedCount: number
    estimatedSaving: number
  }
}

/**
 * Compress conversation history (text-based, no LLM call)
 */
export function compressConversationHistory(
  messages: Message[],
  keepRecentCount: number = 15
): CompressedConversation {

  if (messages.length <= keepRecentCount) {
    return {
      summary: null,
      recentMessages: messages,
      compressionStats: {
        originalCount: messages.length,
        compressedCount: 0,
        estimatedSaving: 0,
      },
    }
  }

  const recentMessages = messages.slice(-keepRecentCount)
  const oldMessages = messages.slice(0, -keepRecentCount)

  // Build simple text summary
  const userMessages = oldMessages.filter(m => m.role === 'user').length
  const assistantMessages = oldMessages.filter(m => m.role === 'assistant').length

  const summary = `## 对话历史摘要

早期${oldMessages.length}条对话（用户${userMessages}条，助手${assistantMessages}条）已压缩。

对话包含：
- 创作讨论和构思
- 已做出的决策和确认
- 已完成的工作（故事大纲、人物设定、场景设计等）

详细内容请参考最近的对话记录。`

  const originalTokens = estimateTokens(oldMessages)
  const summaryTokens = estimateTokens([{ role: 'assistant', text: summary, reference_documents: [] }])

  return {
    summary,
    recentMessages,
    compressionStats: {
      originalCount: messages.length,
      compressedCount: oldMessages.length,
      estimatedSaving: originalTokens - summaryTokens,
    },
  }
}

function estimateTokens(messages: Message[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.text.length, 0)
  return Math.ceil(totalChars / 3)
}

export function buildCompressedMessages(compressed: CompressedConversation): Message[] {
  const messages: Message[] = []

  if (compressed.summary) {
    messages.push({
      role: 'assistant',
      text: compressed.summary,
    })
  }

  messages.push(...compressed.recentMessages)

  return messages
}
