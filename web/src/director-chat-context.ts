// Match the director chat API's UTF-8 text budget. This only selects a request
// window; stored conversation messages and referenced documents stay intact.
export const directorChatTextBudget = 256_000
export const directorChatMessageLimit = 32

type ChatMessage = { id: string; text: string; pending?: boolean; failed?: boolean }

export function directorChatContext<T extends ChatMessage>(messages: T[]): T[] {
  const complete = messages.filter(message => message.id !== 'welcome' && !message.pending && !message.failed)
  const encoder = new TextEncoder()
  let size = 0
  let start = complete.length
  for (let index = complete.length - 1; index >= 0 && complete.length - index <= directorChatMessageLimit; index--) {
    const bytes = encoder.encode(complete[index]!.text).length
    if (size + bytes > directorChatTextBudget) {
      if (index === complete.length - 1) throw new Error('本次消息过长，请将正文作为文档引用后发送')
      break
    }
    size += bytes
    start = index
  }
  return complete.slice(start)
}
