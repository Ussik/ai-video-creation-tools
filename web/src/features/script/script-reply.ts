import { parseMessageChoices, confirmationChoices, type ParsedMessageChoices, type InputField } from './director-choices'
import { allowsDirectorInteraction, readDirectorInteraction, type DirectorInteraction, type DirectorStageContext } from './script-workflow'
export const replyClassificationVersion = 8
export const contextualReplyTypes = ['choice_request', 'input_request', 'confirmation_request', 'question_set']
type InteractionQuestion = { id: string; question: string; interaction?: DirectorInteraction } & ({ kind: 'confirmation' } | { kind: 'input_request'; fields: InputField[] } | {
  kind: 'choices'; options: Array<{ id: string; title: string; text: string; requires_details?: boolean }> })
export type ReplyClassification = { type: 'other' } | { type: 'workflow_action'; interaction: DirectorInteraction } | { type: 'episode_script'; episode_number?: number } | {
  type: 'episode_preparation'; episode_number: number
} | { type: 'confirmation_request'; interaction?: DirectorInteraction; status: 'pending' | 'answered' | 'superseded'; question: string
} | { type: 'question_set'; interaction?: DirectorInteraction; status: 'pending' | 'answered' | 'superseded'; question: string; questions: InteractionQuestion[]
} | { type: 'input_request'; interaction?: DirectorInteraction; status: 'pending' | 'answered' | 'superseded'; question: string; fields: InputField[] } | {
  type: 'choice_request'; interaction?: DirectorInteraction; status: 'pending' | 'answered' | 'superseded'; question: string;
  options: Array<{ id: string; title: string; text: string; requires_details?: boolean }>
}
export type ClassifiableMessage = { id: string; role: 'assistant' | 'user'; text: string; stage_context?: DirectorStageContext; pending?: boolean; failed?: boolean; classification?: ReplyClassification; classification_version?: number; classification_context?: string; execution?: { outcome?: { kind?: string } } }
export function followingMessages(messages: ClassifiableMessage[], index: number) {
  let includedAnswer = false
  return messages.slice(index + 1).filter(message => !message.pending && !message.failed).slice(0, 8).map(message => {
    const limit = message.role === 'user' && !includedAnswer ? 40_000 : 300
    if (message.role === 'user') includedAnswer = true
    return { role: message.role, text: message.text.slice(0, limit) }
  })
}
export function classificationKey(message: { id: string; text: string; following_messages?: unknown; stage_context?: DirectorStageContext }): string { return JSON.stringify([message.id, message.text, message.following_messages || [], message.stage_context || null]) }

function hasStageClassification(message: ClassifiableMessage): boolean {
  const classification = message.classification
  if (!classification || !('status' in classification) || classification.status !== 'pending') return true
  return classification.type === 'question_set' ? classification.questions.every(item => !!item.interaction) : !!classification.interaction
}

/** Saved, discarded and cancelled notices are program-written status text with no
 * question or proposal, so a model call could only answer `other`. */
const statusNoticeOutcomes = new Set(['saved', 'discarded', 'cancelled'])
export const isStatusNotice = (message: ClassifiableMessage) => message.role === 'assistant' && statusNoticeOutcomes.has(message.execution?.outcome?.kind || '')

export function latestReplyNeedsRecognition(messages: ClassifiableMessage[], controlled = false): boolean {
  const message = messages.at(-1)
  if (!message || message.role !== 'assistant' || isStatusNotice(message) || message.pending || message.failed || hasDirectInteraction(message, controlled)) return false
  return message.classification_version !== replyClassificationVersion || !message.classification || controlled && !hasStageClassification(message) ||
    contextualReplyTypes.includes(message.classification.type) && message.classification_context !== '[]'
}

export function canAdoptReply(message: ClassifiableMessage): boolean {
  return message.role === 'assistant' && !message.pending && !message.failed && message.classification_version === replyClassificationVersion && message.classification?.type === 'episode_script'
}

/** Only the current completed reply can propose a next step. It never executes
 * an operation or turns a sample scene into an adoptable episode. */
export function episodePreparationAction(messages: ClassifiableMessage[], context?: DirectorStageContext) {
  const message = messages.at(-1)
  if (!message || message.role !== 'assistant' || message.pending || message.failed ||
    message.classification_version !== replyClassificationVersion || message.classification?.type !== 'episode_preparation') return null
  if (context && (context.stage !== 'episode' || context.mode === 'review' ||
    message.stage_context && message.stage_context.progress_key !== context.progress_key || message.classification.episode_number !== context.episode_number)) return null
  const episode = message.classification.episode_number
  if (!Number.isInteger(episode) || episode < 1 || episode > 200) return null
  return { messageId: message.id, episode_number: episode }
}

export function replyChoices(message: ClassifiableMessage): ParsedMessageChoices | null {
  if (message.role !== 'assistant' || message.pending || message.failed) return null
  const structured = parseMessageChoices(message.text)
  if (structured && (message.classification_version !== replyClassificationVersion || !message.classification)) return structured
  const classification = message.classification
  if (message.classification_version !== replyClassificationVersion) return structured
  const explanation = { intro: structured?.intro || '', trailing: structured?.trailing || '' }
  if (classification?.type === 'confirmation_request') return { interaction: classification.interaction, ...explanation, question: classification.question, confirmation: true, options: confirmationChoices(classification.question) }
  if (classification?.type === 'question_set') return parseMessageChoices(JSON.stringify({ kind: 'question_set', ...explanation, question: classification.question, questions: classification.questions }))
  if (classification?.type === 'input_request') return { interaction: classification.interaction, ...explanation, question: classification.question, fields: classification.fields, options: [] }
  if (classification?.type !== 'choice_request') return null
  return { interaction: classification.interaction, ...explanation, question: classification.question, options: classification.options.map(option => ({ label: option.id, title: option.title, text: option.text, requires_details: option.requires_details })) }
}

export function activeReplyChoice(messages: ClassifiableMessage[], dismissed: Record<string, boolean>, retryId: string | null, context?: DirectorStageContext) {
  const candidate = (message: ClassifiableMessage, index: number, submitting = false) => {
    if (dismissed[message.id]) return null
    if (message.classification && 'status' in message.classification &&
      (message.classification.status !== 'pending' || !submitting && message.classification_context !== JSON.stringify(followingMessages(messages, index)))) return null
    const choice = stageReplyChoices(message, context)
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
export function replyRecognitionState(messages: ClassifiableMessage[], messageId: string, pending: Record<string, string>, errors: Record<string, string>, controlled = false): 'processing' | 'error' | null {
  const message = messages.at(-1)
  if (!message || message.id !== messageId || message.role !== 'assistant' || isStatusNotice(message) || message.pending || message.failed || hasDirectInteraction(message, controlled)) return null
  const following_messages = followingMessages(messages, messages.length - 1)
  if (message.classification_version === replyClassificationVersion && message.classification &&
    (!controlled || hasStageClassification(message)) &&
    (!contextualReplyTypes.includes(message.classification.type) || message.classification_context === JSON.stringify(following_messages))) return null
  const key = classificationKey({ ...message, following_messages })
  if (pending[message.id] === key) return 'processing'
  return errors[message.id] === key ? 'error' : null
}

export function classificationBatch(messages: ClassifiableMessage[], excluded: Set<string>, priorityId?: string | null, controlled = false) {
  const batch: Array<{ id: string; text: string; stage_context?: DirectorStageContext; following_messages: ReturnType<typeof followingMessages> }> = []
  const indices = messages.map((_, index) => index).reverse()
  const priorityIndex = messages.findIndex(message => message.id === priorityId)
  if (priorityIndex >= 0) indices.unshift(...indices.splice(indices.indexOf(priorityIndex), 1))
  for (const index of indices) {
    const message = messages[index]
    const following_messages = followingMessages(messages, index)
    const source = { id: message.id, text: message.text, following_messages, ...(message.stage_context ? { stage_context: message.stage_context } : {}) }
    const classified = message.classification && message.classification_version === replyClassificationVersion &&
      (!controlled || hasStageClassification(message)) &&
      (!contextualReplyTypes.includes(message.classification.type) || message.classification_context === JSON.stringify(following_messages))
    if (message.role !== 'assistant' || message.id === 'welcome' || isStatusNotice(message) || message.pending || message.failed || classified || message.id !== priorityId && hasDirectInteraction(message, controlled) || excluded.has(classificationKey(source)) || !message.text.trim()) continue
    if (message.text.trim().length > 80_000) continue
    const next = [...batch, source]
    if (new TextEncoder().encode(JSON.stringify(next)).length > (batch.length ? 40_000 : 640_000)) continue
    batch.push(next.at(-1)!)
    // Resolve the current reply before historical housekeeping. Old answered
    // questions must not delay or bias the interaction needed right now.
    if (index === messages.length - 1 || message.id === priorityId) break
    if (batch.length === 10) break
  }
  return batch
}


function directWorkflowAction(message: ClassifiableMessage): { interaction: DirectorInteraction; intro: string } | null {
  try {
    const value = JSON.parse(message.text)
    const interaction = readDirectorInteraction(value.interaction)
    return value.kind === 'workflow_action' && interaction && interaction.purpose !== 'setting'
      ? { interaction, intro: typeof value.intro === 'string' ? value.intro : '' } : null
  } catch { return null }
}

function hasDirectInteraction(message: ClassifiableMessage, controlled: boolean): boolean {
  if (directWorkflowAction(message)) return true
  const choice = parseMessageChoices(message.text)
  return !!choice && (!controlled || (choice.questions || [choice]).every(item => !!item.interaction))
}

export function stageReplyChoices(message: ClassifiableMessage, context?: DirectorStageContext): ParsedMessageChoices | null {
  const choice = replyChoices(message)
  if (!choice || !context) return choice
  if (message.stage_context && message.stage_context.progress_key !== context.progress_key) return null
  const allowed = (item: ParsedMessageChoices) => item.interaction?.purpose === 'setting' && allowsDirectorInteraction(item.interaction, context)
  if (!choice.questions) return allowed(choice) ? choice : null
  const questions = choice.questions.filter(allowed)
  if (!questions.length) return null
  return questions.length === 1 ? { ...questions[0], intro: choice.intro, trailing: choice.trailing }
    : { ...choice, questions }
}

export function replyWorkflowAction(messages: ClassifiableMessage[], context: DirectorStageContext) {
  const message = messages.at(-1)
  if (!message || message.role !== 'assistant' || message.pending || message.failed ||
    message.stage_context && message.stage_context.progress_key !== context.progress_key) return null
  const classification = message.classification_version === replyClassificationVersion ? message.classification : undefined
  if (classification && 'status' in classification &&
    (classification.status !== 'pending' || message.classification_context !== '[]')) return null
  const choice = replyChoices(message)
  const interaction = classification?.type === 'workflow_action' ? classification.interaction
    : (!classification ? directWorkflowAction(message)?.interaction : undefined) ||
      (choice?.questions || (choice ? [choice] : [])).find(item => item.interaction && item.interaction.purpose !== 'setting')?.interaction
  if (!interaction || interaction.purpose === 'setting' || !allowsDirectorInteraction(interaction, context)) return null
  return interaction
}

export function replyDisplayText(message: ClassifiableMessage): string {
  const action = directWorkflowAction(message)
  return action ? action.intro || '可以整理当前阶段草稿，检查后确认保存。' : message.text
}
