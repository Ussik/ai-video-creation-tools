type ConversationMessage = { id: string; role: 'assistant' | 'user'; text: string; pending?: boolean; failed?: boolean }

/** A retry branches from the original question, never from the rejected answer.
 * Only the latest reply can branch without discarding later user decisions. */
export function regenerationSource<T extends ConversationMessage>(messages: T[], replyId: string) {
  const replyIndex = messages.length - 1
  const reply = messages[replyIndex]
  const question = messages[replyIndex - 1]
  if (!reply || reply.id !== replyId || reply.role !== 'assistant' || reply.pending ||
    !question || question.role !== 'user' || question.pending) return null
  const before = messages.slice(0, replyIndex).map(message => message.id === question.id ? { ...message, failed: false } : message)
  const context = before.filter(message => message.id !== 'welcome' && !message.pending && !message.failed).slice(-32)
  return { question, before, context }
}
