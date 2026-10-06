import { parseMessageChoices, type ParsedMessageChoices, type InputField } from './director-choices'
export const replyClassificationVersion = 5
export type ReplyClassification = { type: 'other' } | { type: 'episode_script'; episode_number?: number } | {
  type: 'episode_preparation'; episode_number: number
} | { type: 'input_request'; status: 'pending' | 'answered' | 'superseded'; question: string; fields: InputField[] } | {
  type: 'choice_request'; status: 'pending' | 'answered' | 'superseded'; question: string;
  options: Array<{ id: string; title: string; text: string; requires_details?: boolean }>
}
export type ClassifiableMessage = { id: string; role: 'assistant' | 'user'; text: string; pending?: boolean; failed?: boolean; classification?: ReplyClassification; classification_version?: number; classification_context?: string }
export function followingMessages(messages: ClassifiableMessage[], index: number) {
  return messages.slice(index + 1).filter(message => !message.pending && !message.failed).slice(0, 8).map(message => ({ role: message.role, text: message.text.slice(0, 300) }))
}
export function classificationKey(message: { id: string; text: string; following_messages?: unknown }): string { return JSON.stringify([message.id, message.text, message.following_messages || []]) }

export function canAdoptReply(message: ClassifiableMessage): boolean {
  return message.role === 'assistant' && !message.pending && !message.failed && message.classification_version === replyClassificationVersion && message.classification?.type === 'episode_script'
}

/** Only the current completed reply can propose a next step. It never executes
 * an operation or turns a sample scene into an adoptable episode. */
export function episodePreparationAction(messages: ClassifiableMessage[]) {
  const message = messages.at(-1)
  if (!message || message.role !== 'assistant' || message.pending || message.failed ||
    message.classification_version !== replyClassificationVersion || message.classification?.type !== 'episode_preparation') return null
  const episode = message.classification.episode_number
  if (!Number.isInteger(episode) || episode < 1 || episode > 200) return null
  return { messageId: message.id, episode_number: episode }
}

export function replyChoices(message: ClassifiableMessage): ParsedMessageChoices | null {
  if (message.role !== 'assistant' || message.pending || message.failed) return null
  const structured = parseMessageChoices(message.text)
  if (structured) return structured
  const classification = message.classification
  if (message.classification_version !== replyClassificationVersion) return null
  if (classification?.type === 'input_request') return { intro: '', trailing: '', question: classification.question, fields: classification.fields, options: [] }
  if (classification?.type !== 'choice_request') return null
  return { intro: '', trailing: '', question: classification.question, options: classification.options.map(option => ({ label: option.id, title: option.title, text: option.text, requires_details: option.requires_details })) }
}

export function activeReplyChoice(messages: ClassifiableMessage[], dismissed: Record<string, boolean>, retryId: string | null) {
  const candidate = (message: ClassifiableMessage, index: number, submitting = false) => {
    if (dismissed[message.id]) return null
    if ((message.classification?.type === 'choice_request' || message.classification?.type === 'input_request') &&
      (message.classification.status !== 'pending' || !submitting && message.classification_context !== JSON.stringify(followingMessages(messages, index)))) return null
    const choice = replyChoices(message)
    return choice ? { messageId: message.id, choice } : null
  }
  const retryIndex = messages.findIndex(message => message.id === retryId)
  if (retryIndex >= 0) { const retry = candidate(messages[retryIndex], retryIndex, true); if (retry) return retry }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') return null
    if (message.pending) continue
    return candidate(message, index)
  }
  return null
}

/** Background work never becomes a status or a lock on the current reply. */
export function replyRecognitionState(messages: ClassifiableMessage[], messageId: string, pending: Record<string, string>, errors: Record<string, string>): 'processing' | 'error' | null {
  const message = messages.at(-1)
  if (!message || message.id !== messageId || message.role !== 'assistant' || message.pending || message.failed || parseMessageChoices(message.text)) return null
  const following_messages = followingMessages(messages, messages.length - 1)
  if (message.classification_version === replyClassificationVersion && message.classification &&
    (!['choice_request', 'input_request'].includes(message.classification.type) || message.classification_context === JSON.stringify(following_messages))) return null
  const key = classificationKey({ ...message, following_messages })
  if (pending[message.id] === key) return 'processing'
  return errors[message.id] === key ? 'error' : null
}

export function classificationBatch(messages: ClassifiableMessage[], excluded: Set<string>, priorityId?: string | null) {
  const batch: Array<{ id: string; text: string; following_messages: ReturnType<typeof followingMessages> }> = []
  const indices = messages.map((_, index) => index).reverse()
  const priorityIndex = messages.findIndex(message => message.id === priorityId)
  if (priorityIndex >= 0) indices.unshift(...indices.splice(indices.indexOf(priorityIndex), 1))
  for (const index of indices) {
    const message = messages[index]
    const following_messages = followingMessages(messages, index)
    const source = { id: message.id, text: message.text, following_messages }
    const classified = message.classification && message.classification_version === replyClassificationVersion &&
      (!['choice_request', 'input_request'].includes(message.classification.type) || message.classification_context === JSON.stringify(following_messages))
    if (message.role !== 'assistant' || message.id === 'welcome' || message.pending || message.failed || classified || parseMessageChoices(message.text) || excluded.has(classificationKey(source)) || !message.text.trim()) continue
    if (message.text.trim().length > 8000) continue
    const next = [...batch, source]
    if (new TextEncoder().encode(JSON.stringify(next)).length > 40_000) continue
    batch.push(next.at(-1)!)
    // Resolve the current reply before historical housekeeping. Old answered
    // questions must not delay or bias the interaction needed right now.
    if (index === messages.length - 1 || message.id === priorityId) break
    if (batch.length === 10) break
  }
  return batch
}
