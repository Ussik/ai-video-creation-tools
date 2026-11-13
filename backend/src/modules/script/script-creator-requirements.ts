import { all, db, newId, now, one, run } from '../../infrastructure/database/db.js'
import { invalid as reject } from '../../infrastructure/http/request.js'

function invalid(message: string, statusCode?: number): never {
  if (statusCode === undefined) reject(message)
  throw Object.assign(new Error(message), { statusCode })
}

/** Durable record of what the creator actually said. Every entry keeps a verbatim
 * quote and the complete source message, so it stays readable after the chat
 * window or the stored message history has moved on. Only creator-authored text
 * qualifies: assistant suggestions are never promoted by this module. */
export type CreatorRequirement = {
  id: string; project_id: string; kind: 'requirement' | 'open_question'; quote: string; source_text: string
  message_id: string | null; conversation_id: string | null; scope: string; status: 'active' | 'superseded'
  supersedes_id: string | null; superseded_by: string | null; created_at: string; updated_at: string
}
export const maxActiveCreatorRequirements = 100
export const maxRequirementQuote = 2000

export type RecordRequirementInput = {
  kind?: 'requirement' | 'open_question'; quote: string; scope?: string
  /** Complete creator message the quote comes from. */
  source: { text: string; message_id?: string | null; conversation_id?: string | null }
  /** Active entries this one explicitly replaces. */
  supersedes?: string[]
}

export function activeCreatorRequirements(projectId: string): CreatorRequirement[] {
  return all<CreatorRequirement>("SELECT * FROM script_creator_requirements WHERE project_id=? AND status='active' ORDER BY created_at, id", projectId)
}
export function allCreatorRequirements(projectId: string): CreatorRequirement[] {
  return all<CreatorRequirement>('SELECT * FROM script_creator_requirements WHERE project_id=? ORDER BY created_at, id', projectId)
}

/** Compact model-facing view. The verbatim quote is kept in full; the complete
 * source message is available through `read_creator_requirements`. */
export function creatorRequirementsContext(projectId: string) {
  return activeCreatorRequirements(projectId).map(({ id, kind, quote, scope, message_id, created_at, supersedes_id }) =>
    ({ id, kind, quote, ...(scope ? { scope } : {}), ...(message_id ? { message_id } : {}), recorded_at: created_at, ...(supersedes_id ? { supersedes: supersedes_id } : {}) }))
}

export function recordCreatorRequirement(projectId: string, input: RecordRequirementInput): CreatorRequirement {
  const quote = input.quote.trim(), sourceText = input.source.text
  const scope = (input.scope || '').slice(0, 200)
  if (!quote) invalid('要求引文不能为空')
  if (quote.length > maxRequirementQuote) invalid(`引文不能超过 ${maxRequirementQuote} 字；请只摘录相关的原话`)
  if (!sourceText.includes(quote)) invalid('引文必须逐字来自创作者的原消息；助手的说明或你的转述不能作为要求记录')
  const supersedes = [...new Set(input.supersedes || [])]
  return db.transaction(() => {
    const replaced = supersedes.map(id => {
      const entry = one<CreatorRequirement>('SELECT * FROM script_creator_requirements WHERE id=? AND project_id=?', id, projectId)
      if (!entry) invalid(`要替代的要求不存在：${id}`, 404)
      if (entry.status !== 'active') invalid(`该要求已被替代，不能再次替代：${id}`, 409)
      return entry
    })
    if (activeCreatorRequirements(projectId).length - replaced.length >= maxActiveCreatorRequirements) {
      invalid(`有效要求已达 ${maxActiveCreatorRequirements} 条上限；请明确替代或合并旧要求，系统不会静默丢弃`, 409)
    }
    const duplicate = activeCreatorRequirements(projectId).find(item => item.quote === quote && item.kind === (input.kind ?? 'requirement') && item.scope === scope)
    if (duplicate && !supersedes.length) return duplicate
    const id = newId(), timestamp = now()
    run(`INSERT INTO script_creator_requirements (id, project_id, kind, quote, source_text, message_id, conversation_id, scope, status, supersedes_id, superseded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`, id, projectId, input.kind ?? 'requirement', quote, sourceText,
    input.source.message_id ?? null, input.source.conversation_id ?? null, scope, supersedes[0] ?? null, timestamp, timestamp)
    for (const entry of replaced) run("UPDATE script_creator_requirements SET status='superseded', superseded_by=?, updated_at=? WHERE id=?", id, timestamp, entry.id)
    return one<CreatorRequirement>('SELECT * FROM script_creator_requirements WHERE id=?', id)!
  })()
}

/** The creator withdrew a requirement without replacing it. */
export function withdrawCreatorRequirement(projectId: string, id: string, source: RecordRequirementInput['source'], quote: string): CreatorRequirement {
  const entry = one<CreatorRequirement>('SELECT * FROM script_creator_requirements WHERE id=? AND project_id=?', id, projectId)
  if (!entry) invalid('要求不存在', 404)
  if (entry.status !== 'active') invalid('该要求已被替代或撤回', 409)
  if (!quote.trim() || !source.text.includes(quote.trim())) invalid('撤回必须引用创作者的原话')
  const timestamp = now()
  run("UPDATE script_creator_requirements SET status='superseded', superseded_by='withdrawn', updated_at=? WHERE id=?", timestamp, id)
  return one<CreatorRequirement>('SELECT * FROM script_creator_requirements WHERE id=?', id)!
}

/** Resolves a creator message in the stored conversations, so an HTTP caller
 * can cite it by id even after it left the model's request window. */
export function storedCreatorMessage(projectId: string, conversationId: string, messageId: string): { text: string } | null {
  // The archive, not the windowed conversation: the visible conversation drops its oldest messages past 80, but a
  // requirement must stay citable by the message it came from.
  const row = one<{ text: string; role: string }>('SELECT text, role FROM script_message_archive WHERE project_id=? AND conversation_id=? AND id=?',
    projectId, conversationId, messageId)
  return row && row.role === 'user' ? { text: row.text } : null
}

/** Creator-authored messages of this conversation that are older than the request window, oldest first and verbatim.
 * Only the creator's own words qualify: assistant text is never carried forward, so a suggestion can not become a
 * decision. Messages whose wording is already present in the request are skipped.
 *
 * Under a size budget the choice is not "newest wins": wording the creator has recorded as an active requirement or
 * open question must survive pressure, because those are the statements the work is held to. Messages that back an
 * active ledger entry are therefore kept first (in full, in their original order), and the remaining budget goes to the
 * newest other messages. Whatever is left out is counted and named by id so it stays readable from the archive. */
/** Default 200,000 characters of the creator's own earlier wording, in line with the 256 KB a single request may carry.
 * VIDEO_STUDIO_EARLIER_WORDING_CHARS overrides it (smaller values reproduce pressure without building huge histories). */
export const earlierCreatorMessageBudget = (() => {
  const configured = Number(process.env.VIDEO_STUDIO_EARLIER_WORDING_CHARS)
  return Number.isSafeInteger(configured) && configured >= 200 ? configured : 200_000
})()
export function earlierCreatorMessages(projectId: string, conversationId: string | undefined, windowMessages: Array<{ id?: string; text: string }>, budget = earlierCreatorMessageBudget) {
  const empty = { messages: [] as Array<{ id: string; text: string; backs_requirement?: true }>, omitted: 0, omitted_ids: [] as string[] }
  if (!conversationId) return empty
  const inWindow = new Set(windowMessages.flatMap(message => message.id ? [message.id] : []))
  const windowTexts = new Set(windowMessages.map(message => message.text.trim()))
  const rows = all<{ id: string; text: string }>(`SELECT a.id, a.text FROM script_message_archive a
    WHERE a.project_id=? AND a.conversation_id=? AND a.role='user' ORDER BY a.rowid`, projectId, conversationId)
    .filter(row => !inWindow.has(row.id) && !windowTexts.has(row.text.trim()))
  const backing = new Set(activeCreatorRequirements(projectId).flatMap(item => item.message_id && item.conversation_id === conversationId ? [item.message_id] : []))
  const keep = new Set<string>()
  let size = 0
  // 1. messages behind active requirements, newest first within that group, until the budget is spent
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (!backing.has(row.id) || size + row.text.length > budget) continue
    keep.add(row.id); size += row.text.length
  }
  // 2. then the newest of the rest
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (keep.has(row.id) || size + row.text.length > budget) continue
    keep.add(row.id); size += row.text.length
  }
  const messages = rows.filter(row => keep.has(row.id)).map(row => backing.has(row.id) ? { ...row, backs_requirement: true as const } : row)
  const omittedRows = rows.filter(row => !keep.has(row.id))
  return { messages, omitted: omittedRows.length, omitted_ids: omittedRows.map(row => row.id).slice(0, 50) }
}

/** Original wording of one stored message, independent of the windowed conversation (either role: this is a
 * record of what was said, not a source of requirements). */
export function archivedMessage(projectId: string, conversationId: string, messageId: string) {
  return one<{ conversation_id: string; id: string; role: 'assistant' | 'user'; text: string; first_seen_at: string }>(
    'SELECT conversation_id, id, role, text, first_seen_at FROM script_message_archive WHERE project_id=? AND conversation_id=? AND id=?', projectId, conversationId, messageId)
}
/** Page through a conversation's archived messages in the order they were stored. */
export function archivedMessages(projectId: string, conversationId: string, after: number, limit: number) {
  const rows = all<{ rowid: number; id: string; role: 'assistant' | 'user'; text: string; first_seen_at: string }>(
    'SELECT rowid, id, role, text, first_seen_at FROM script_message_archive WHERE project_id=? AND conversation_id=? AND rowid>? ORDER BY rowid LIMIT ?',
    projectId, conversationId, after, limit + 1)
  const more = rows.length > limit, page = rows.slice(0, limit)
  return { messages: page.map(({ rowid: _rowid, ...message }) => message), next_cursor: more ? page.at(-1)!.rowid : null }
}
