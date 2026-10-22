import { z } from 'zod'
import { db, one, run } from '../../infrastructure/database/db.js'
import { scriptSourceCharacterLimit, type ScriptSourceDocument, type ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import { scriptDocumentVersion } from './script-source-identity.js'
import { captureSourceRevisionBase } from './script-source-revision-reuse.js'
export { scriptDocumentVersion } from './script-source-identity.js'

type Source = Omit<ScriptSourceDocument, 'analysis'>
type Revision = { id: string; project_id: string; source_base_version: string; revision: number; original_content: string; content: string; created_at: string }
export const scriptSourceUpdateSchema = z.object({
  id: z.string().min(1).max(120), base_version: z.string().min(1).max(160),
  original_content: z.string().min(1).max(scriptSourceCharacterLimit), content: z.string().min(1).max(scriptSourceCharacterLimit).refine(value => !!value.trim(), '文稿正文不能为空'),
  replacements: z.array(z.object({ find: z.string().min(1).max(scriptSourceCharacterLimit), replace: z.string().max(scriptSourceCharacterLimit), reason: z.string().min(1).max(2000) }).strict()).max(2000),
}).strict()
export const originalScriptSource = (projectId: string) => one<Source>('SELECT * FROM script_source_documents WHERE project_id=?', projectId) || null
const revisionListeners = new Set<(projectId: string, modelId: string) => void>()
export function onScriptSourceRevision(listener: (projectId: string, modelId: string) => void) {
  revisionListeners.add(listener)
  return () => { revisionListeners.delete(listener) }
}

/** Every processing path reads this version; the upload remains a separate source. */
export function effectiveScriptSource(projectId: string): Source | null {
  const original = originalScriptSource(projectId)
  if (!original) return null
  const revision = one<Revision>('SELECT * FROM script_source_revisions WHERE project_id=? AND source_base_version=? ORDER BY revision DESC LIMIT 1', projectId, scriptDocumentVersion(original))
  return revision ? { ...original, content: revision.content, updated_at: revision.created_at, revision: revision.revision } : original
}

/** Called inside the same transaction that saves the reviewed stage documents. */
export function commitScriptSourceUpdate(projectId: string, input: ScriptSourceUpdate) {
  return db.transaction(() => {
    const update = scriptSourceUpdateSchema.parse(input), current = effectiveScriptSource(projectId), original = originalScriptSource(projectId)
    if (!current || !original) throw Object.assign(new Error('文稿来源已移除，草稿仍保留，请重新检查'), { statusCode: 409 })
    const saved = one<Revision>('SELECT * FROM script_source_revisions WHERE id=?', update.id)
    if (saved) {
      if (saved.project_id === projectId && saved.source_base_version === scriptDocumentVersion(original) && saved.original_content === update.original_content && saved.content === update.content && current.updated_at === saved.created_at) return current
      throw Object.assign(new Error('文稿修订已变化，请重新打开草稿'), { statusCode: 409 })
    }
    if (scriptDocumentVersion(current) !== update.base_version || current.content !== update.original_content) {
      throw Object.assign(new Error('当前有效稿已变化，草稿未保存，请重新核对文稿修订'), { statusCode: 409 })
    }
    if (current.content === update.content) return current
    const timestamp = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString()
    run('INSERT INTO script_source_revisions (id, project_id, source_base_version, revision, original_content, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      update.id, projectId, scriptDocumentVersion(original), (current.revision || 0) + 1, current.content, update.content, timestamp)
    const analysis = one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', projectId)
    let modelId: string | undefined
    try {
      const candidate = analysis && (JSON.parse(analysis.snapshot) as { model_id?: unknown }).model_id
      if (typeof candidate === 'string' && candidate.trim()) modelId = candidate
    } catch { /* A damaged old analysis must not prevent a confirmed revision. */ }
    const revised = effectiveScriptSource(projectId)!, revisionVersion = scriptDocumentVersion(revised)
    captureSourceRevisionBase(current, original, revised, update.id)
    run('DELETE FROM script_source_analyses WHERE project_id=?', projectId)
    // Notifications run after the outer document transaction commits. A failed
    // transaction or another replacement must never launch a stale analysis.
    if (modelId) queueMicrotask(() => {
      const currentSource = effectiveScriptSource(projectId)
      if (currentSource && scriptDocumentVersion(currentSource) === revisionVersion) {
        for (const listener of revisionListeners) listener(projectId, modelId)
      }
    })
    return revised
  })()
}
