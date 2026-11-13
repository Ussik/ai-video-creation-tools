import { conversationMessage } from './director-activity'
import type { ScriptActivity, ScriptExecution } from './director-activity'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'

export const directorConversationStorageKey = (projectId: string) => `script-director-conversations:${projectId}`

export type DirectorStoredMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
  pending?: boolean
  task_id?: string
  activity?: ScriptActivity[]
  execution?: ScriptExecution
  stage_context?: unknown
  reference_documents?: unknown[]
  processing_duration_ms?: number | null
  review?: DocumentReview
  classification?: unknown
  classification_version?: number
  classification_context?: string
  classification_source?: string
}

export type DirectorStoredConversation = { id: string; label: string; messages: DirectorStoredMessage[] }
type StoredMessage = DirectorStoredMessage
type StoredConversation = DirectorStoredConversation
type DirectorCache = { messages: StoredMessage[]; history: StoredConversation[] }
type StorageLike = Pick<Storage, 'getItem' | 'removeItem'>
export type DirectorRemoteConversation = { id: string; label: string; messages: DirectorStoredMessage[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function persistedMessage(message: StoredMessage): string {
  return canonical(conversationMessage(message))
}

function isMessage(value: unknown): value is StoredMessage {
  return !!value && typeof value === 'object' && typeof (value as StoredMessage).id === 'string'
    && ((value as StoredMessage).role === 'assistant' || (value as StoredMessage).role === 'user')
    && typeof (value as StoredMessage).text === 'string' && !(value as StoredMessage).pending
}

function cacheSnapshot(raw: string): DirectorCache | null {
  try {
    const value = JSON.parse(raw) as { messages?: unknown; history?: unknown }
    if (!Array.isArray(value.messages) || !Array.isArray(value.history) || !value.messages.every(isMessage)) return null
    const history = value.history.filter((item): item is StoredConversation => !!item && typeof item === 'object'
      && typeof (item as StoredConversation).id === 'string' && typeof (item as StoredConversation).label === 'string'
      && Array.isArray((item as StoredConversation).messages) && (item as StoredConversation).messages.every(isMessage))
    if (history.length !== value.history.length) return null
    return { messages: value.messages, history }
  } catch { return null }
}

function containsMessages(local: StoredMessage[], remote: StoredMessage[]): boolean {
  const byId = new Map(remote.map(message => [message.id, message]))
  return local.every(message => {
    const saved = byId.get(message.id)
    return !!saved && persistedMessage(saved) === persistedMessage(message)
  })
}

/** Remove only a byte-for-byte-equivalent fallback whose persisted fields are all confirmed by the server. */
export function releaseVerifiedDirectorConversationCache(projectId: string,
  remote: DirectorRemoteConversation[], storage?: StorageLike): boolean {
  let target: StorageLike
  try { target = storage || window.localStorage } catch { return false }
  const key = directorConversationStorageKey(projectId)
  let raw: string | null
  try { raw = target.getItem(key) } catch { return false }
  if (raw === null) return false
  const local = cacheSnapshot(raw)
  if (!local) return false

  const historyIds = new Set(local.history.map(conversation => conversation.id))
  const activeMatched = remote.some(conversation => !historyIds.has(conversation.id) && containsMessages(local.messages, conversation.messages))
  if (!activeMatched) return false
  for (const history of local.history) {
    const saved = remote.find(conversation => conversation.id === history.id)
    if (!saved || saved.label !== history.label.slice(0, 120) || !containsMessages(history.messages, saved.messages)) return false
  }

  try {
    // Avoid removing a newer local snapshot written while the remote check was in flight.
    if (target.getItem(key) !== raw) return false
    target.removeItem(key)
    return target.getItem(key) === null
  } catch { return false }
}
