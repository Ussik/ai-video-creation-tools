import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ScriptGenerationProgress } from '@video-studio/shared/api/contracts'
import { scriptArtifactTypes } from '@video-studio/shared/script/script-stage-content'
import { all, db, now, one, run } from '../../infrastructure/database/db.js'
import type { GenerationSteps } from './script-generation-steps.js'
import { effectiveScriptSource, scriptDocumentVersion } from './script-source-versions.js'
import { workflowGenerationDraftSchema } from './script-workflow.js'

const sourceStep = 'progress:source'
const progressSource = z.object({ source_version: z.string().min(1).nullable(), task_id: z.string().min(1).optional(), hidden: z.boolean().optional() }).strict()
const checkpointSchema = z.object({ prompt: z.string().optional(), steps: z.record(z.string(), z.object({ value: z.unknown() }).passthrough()) }).strict()
type Document = ScriptGenerationProgress['documents'][number]

/** Display metadata does not participate in generation identity or step reuse. */
export function bindScriptGenerationProgressSource(steps: GenerationSteps, sourceVersion: string | null, taskId?: string) {
  const previous = progressSource.safeParse(steps.checkpoint.steps[sourceStep]?.value)
  const value = { source_version: sourceVersion, ...(taskId ? { task_id: taskId } : {}) }
  if (previous.success && JSON.stringify(previous.data) === JSON.stringify(value)) return
  steps.retain(sourceStep, '记录已保留草稿的来源', null, value, value => progressSource.parse(value))
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return undefined }
}

function completeDocuments(value: unknown): Document[] {
  const parsed = workflowGenerationDraftSchema.safeParse(value)
  if (!parsed.success) return []
  // Validation may trim strings. The displayed draft must retain the exact
  // accepted bytes, including program-injected historical documents.
  const original = (value as { artifacts: Array<{ artifact_type: string; title: string; content: string }> }).artifacts
  return parsed.data.artifacts.map(artifact => {
    const document = original.find(item => item.artifact_type === artifact.artifact_type)!
    return { artifact_type: artifact.artifact_type, title: document.title, content: document.content, episode_number: parsed.data.episode_number }
  })
}

/** Read-only projection: candidates never become accepted script data here. */
export function scriptGenerationProgress(projectId: string, resolutionVersion?: string): ScriptGenerationProgress | null {
  const source = effectiveScriptSource(projectId)
  const sourceVersion = source ? scriptDocumentVersion(source) : null
  const accepted = all<Document & { updated_at: string }>('SELECT artifact_type,title,content,episode_number,updated_at FROM script_artifacts WHERE project_id=?', projectId)
  const retained = (updated_at: string, documents: Document[], checkpoint_key?: string): ScriptGenerationProgress | null => {
    const pending = documents.filter(document => !accepted.some(saved => saved.artifact_type === document.artifact_type &&
      saved.episode_number === document.episode_number && (saved.title === document.title && saved.content === document.content ||
        checkpoint_key && saved.updated_at >= updated_at)))
    pending.sort((a, b) => a.episode_number - b.episode_number || scriptArtifactTypes.indexOf(a.artifact_type) - scriptArtifactTypes.indexOf(b.artifact_type))
    return pending.length ? { updated_at, ...(checkpoint_key ? { checkpoint_key } : {}), documents: pending } : null
  }
  const resolution = one<{ payload: string; updated_at: string }>('SELECT payload,updated_at FROM script_draft_resolutions WHERE project_id=?', projectId)
  if (resolution) {
    const value = parseJson(resolution.payload) as { source_version?: unknown; draft?: unknown } | undefined
    // This version includes project settings and accepted documents as well as
    // the manuscript. The owner supplies its existing canonical identity.
    if (!value || !resolutionVersion || value.source_version !== resolutionVersion) return null
    return retained(resolution.updated_at, completeDocuments(value.draft))
  }
  const pending = one<{ payload: string; updated_at: string }>("SELECT payload,updated_at FROM script_tool_drafts WHERE project_id=? AND status='pending'", projectId)
  if (pending) {
    const value = parseJson(pending.payload)
    if (!value || typeof value !== 'object') return null
    const draft = value as { kind?: unknown; source_version?: unknown; workflow?: unknown; documents?: unknown }
    if (draft.kind !== 'create' || draft.source_version !== sourceVersion || !draft.workflow || typeof draft.workflow !== 'object' || !Array.isArray(draft.documents)) return null
    const documents = draft.documents.map(document => document && typeof document === 'object'
      ? { artifact_type: document.artifact_type, title: document.title, content: document.content } : document)
    return retained(pending.updated_at, completeDocuments({ ...draft.workflow, artifacts: documents }))
  }

  const row = one<{ cache_key: string; payload: string; updated_at: string }>('SELECT cache_key,payload,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
  if (!row) return null
  const checkpoint = checkpointSchema.safeParse(parseJson(row.payload))
  if (!checkpoint.success) return null
  const metadata = checkpoint.data.steps[sourceStep]
  if (metadata) {
    const binding = progressSource.safeParse(metadata.value)
    if (!binding.success || binding.data.hidden || binding.data.source_version !== sourceVersion) return null
    if (binding.data.task_id) {
      const task = one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE project_id=? AND id=?', projectId, binding.data.task_id)
      const snapshot = task && parseJson(task.snapshot) as { execution?: { outcome?: { kind?: string } } } | undefined
      if (snapshot?.execution?.outcome?.kind === 'saved' || snapshot?.execution?.outcome?.kind === 'discarded') return null
    }
  } else {
    // Historical checkpoints predate source metadata. Their original prompt
    // contains the complete effective manuscript and, in newer versions, its
    // precise document identity. Do not publish a different manuscript's work.
    const prompt = checkpoint.data.prompt || ''
    if (source ? !prompt.includes(sourceVersion!) && !(source.updated_at <= row.updated_at && prompt.includes(JSON.stringify(source.content)))
      : prompt.includes('"source_kind":"effective"')) return null
  }
  const documents = new Map<string, Document>()
  const entries = Object.entries(checkpoint.data.steps).sort(([a], [b]) => Number(a.startsWith('work:document:')) - Number(b.startsWith('work:document:')))
  for (const [key, entry] of entries) {
    if (key !== 'draft' && key !== 'draft:whole' && !/^work:(?:document:)?[^/]+\/draft$/.test(key)) continue
    for (const document of completeDocuments(entry.value)) documents.set(`${document.artifact_type}:${document.episode_number}`, document)
  }
  return retained(row.updated_at, [...documents.values()], row.cache_key)
}

/** Tokens belong to the exact persisted candidate returned by a JSON run. */
export function scriptGenerationProgressCheckpoint(projectId: string) {
  return one<{ checkpoint_key: string; updated_at: string }>('SELECT cache_key AS checkpoint_key,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
}

/** Discard only the reviewed display version; retain every resumable step. */
export function discardScriptGenerationProgress(projectId: string, checkpointKey: string, updatedAt: string) {
  db.transaction(() => {
    const row = one<{ cache_key: string; payload: string; updated_at: string }>('SELECT cache_key,payload,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
    const visible = scriptGenerationProgress(projectId)
    if (!row || row.cache_key !== checkpointKey || row.updated_at !== updatedAt || visible?.checkpoint_key !== checkpointKey || visible.updated_at !== updatedAt) {
      throw Object.assign(new Error('已保留草稿已更新，请刷新后查看当前版本'), { statusCode: 409 })
    }
    const checkpoint = checkpointSchema.parse(parseJson(row.payload))
    const previous = checkpoint.steps[sourceStep]
    const source = effectiveScriptSource(projectId)
    const binding = previous ? progressSource.parse(previous.value) : { source_version: source ? scriptDocumentVersion(source) : null }
    checkpoint.steps[sourceStep] = { ...(previous || { input_hash: createHash('sha256').update('null').digest('hex') }), value: { ...binding, hidden: true } }
    run('UPDATE script_generation_checkpoints SET payload=?,updated_at=? WHERE project_id=?', JSON.stringify(checkpoint), now(), projectId)
  })()
}
