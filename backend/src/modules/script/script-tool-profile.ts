/** Function sets per task kind. The server already rejects the omitted calls
 * (see `canDraft` and the review guards in script-document-tools), so offering
 * them only costs schema tokens and invites doomed calls. Filtering keeps the
 * declared order, so each profile serializes identically from turn to turn. */
const draftWriters = ['create_document_draft', 'propose_document_patch', 'manage_document_draft', 'commit_document_draft', 'review_revision_batch']
const reviewOnlyExclusions = [...draftWriters, 'manage_revision_task', 'record_story_decision', 'record_creator_requirement', 'propose_next_step']

export type ScriptToolProfileInput = { discussionOnly?: boolean; reviewOnly?: boolean; legacyPending?: boolean }

export function scriptToolProfile(input: ScriptToolProfileInput): { name: 'review' | 'discussion' | 'full'; excluded: ReadonlySet<string> } {
  if (input.reviewOnly) return { name: 'review', excluded: new Set(reviewOnlyExclusions) }
  if (input.discussionOnly) return { name: 'discussion', excluded: new Set(draftWriters) }
  return { name: 'full', excluded: new Set() }
}

/** Calls that only read project or manuscript state. A model may emit several in
 * one turn; they run in declared order. Any other call is a barrier: calls after
 * it in the same turn are deferred so they are decided against its result. */
export const batchableReadTools: ReadonlySet<string> = new Set(['get_creation_state', 'get_project_visual_style', 'search_project_content',
  'read_source_document', 'search_source_document', 'read_full_source_document', 'read_documents', 'read_episode_scenes',
  'find_related_content', 'get_document_review_context', 'read_visual_profiles', 'get_storyboard_context', 'read_creator_requirements'])

export const deferredCallOutput = (name: string) => JSON.stringify({ ok: false, deferred: true, error: `同一轮中前面的写入类操作已执行，${name} 尚未执行。请基于最新结果在下一轮重新发出。` })
