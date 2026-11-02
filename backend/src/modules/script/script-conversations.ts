import { all, db, newId, now, one, run, type ScriptConversation, type ScriptMessage } from '../../infrastructure/database/db.js'
import { invalid } from '../../infrastructure/http/request.js'

export type ConversationMessage = {
  id?: string; role: 'assistant' | 'user'; text: string; reference_documents?: unknown[];
  processing_duration_ms?: number; stage_context?: unknown; activity?: unknown[]; reply_metadata?: Record<string, unknown>;
}
export function conversationTimestamp(projectId: string) {
  const previous = one<{ updated_at: string }>('SELECT updated_at FROM script_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 1', projectId)
  return new Date(Math.max(Date.now(), Date.parse(previous?.updated_at || '') + 1 || 0)).toISOString()
}
/** Keep the first text ever seen for a message id, independent of the windowed conversation. */
function archiveMessage(conversationId: string, id: string, role: 'assistant' | 'user', text: string, timestamp: string) {
  const owner = one<{ project_id: string }>('SELECT project_id FROM script_conversations WHERE id=?', conversationId)
  if (!owner) return
  run('INSERT OR IGNORE INTO script_message_archive (conversation_id, id, project_id, role, text, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    conversationId, id, owner.project_id, role, text, timestamp)
}
export function insertConversationMessage(conversationId: string, message: ConversationMessage, position: number, timestamp = now()) {
  const messageId = message.id || newId()
  // An in-progress assistant placeholder is not an original statement; only archive final text.
  if (message.text !== '正在处理创作任务…') archiveMessage(conversationId, messageId, message.role, message.text, timestamp)
  run(`INSERT OR REPLACE INTO script_messages
    (id, conversation_id, position, role, text, reference_documents, processing_duration_ms, stage_context, activity, reply_metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, messageId, conversationId, position, message.role, message.text,
  JSON.stringify(message.reference_documents || []), message.processing_duration_ms ?? null, message.stage_context ? JSON.stringify(message.stage_context) : null,
  JSON.stringify(message.activity || []), JSON.stringify(message.reply_metadata || {}), timestamp)
}
function storedMessage(row: ScriptMessage): ConversationMessage {
  return { id: row.id, role: row.role, text: row.text, reference_documents: JSON.parse(row.reference_documents || '[]'),
    ...(row.processing_duration_ms != null ? { processing_duration_ms: row.processing_duration_ms } : {}),
    stage_context: row.stage_context ? JSON.parse(row.stage_context) : undefined,
    activity: JSON.parse(row.activity || '[]'), reply_metadata: JSON.parse(row.reply_metadata || '{}') }
}

export function saveConversation(projectId: string, data: { id?: string; label?: string; messages: ConversationMessage[] }) {
  const id = data.id || newId()
  const existing = one<ScriptConversation>('SELECT * FROM script_conversations WHERE id=?', id)
  if (existing && existing.project_id !== projectId) invalid('对话不属于当前项目')
  const label = (data.label?.trim() || data.messages.find(message => message.role === 'user')?.text.trim() || '未命名对话').slice(0, 120)
  db.transaction(() => {
    const timestamp = conversationTimestamp(projectId)
    const owned = all<{ user_message_id: string; message_id: string }>('SELECT user_message_id, message_id FROM script_director_tasks WHERE conversation_id=?', id)
    const ids = new Set(owned.flatMap(task => [task.user_message_id, task.message_id]))
    const authoritative = all<ScriptMessage>('SELECT * FROM script_messages WHERE conversation_id=? ORDER BY position', id)
      .filter(message => ids.has(message.id)).map(storedMessage)
    const messages = data.messages.map(message => {
      const saved = authoritative.find(item => item.id === message.id)
      // A remounted panel can save a stale snapshot while a task finishes.
      // Keep the server result; accept classification and draft-review updates
      // only when they describe that same completed reply.
      if (!saved) return message
      if (saved.role === 'assistant' && message.text === saved.text && saved.reply_metadata?.task_status !== 'running') {
        return { ...saved, reply_metadata: { ...saved.reply_metadata, ...message.reply_metadata,
          task_id: saved.reply_metadata?.task_id, task_status: saved.reply_metadata?.task_status } }
      }
      return saved
    })
    for (const message of authoritative) if (!messages.some(item => item.id === message.id)) messages.push(message)
    if (existing) {
      run('UPDATE script_conversations SET label=?, updated_at=? WHERE id=?', label, timestamp, id)
      run('DELETE FROM script_messages WHERE conversation_id=?', id)
    } else run('INSERT INTO script_conversations (id, project_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, projectId, label, timestamp, timestamp)
    messages.slice(-80).forEach((message, position) => insertConversationMessage(id, message, position, timestamp))
    run(`DELETE FROM script_conversations WHERE project_id=? AND id NOT IN (
      SELECT id FROM script_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 30
    ) AND id NOT IN (SELECT conversation_id FROM script_director_tasks WHERE status='running')`, projectId, projectId)
  })()
  return id
}
