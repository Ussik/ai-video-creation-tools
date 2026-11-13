import { createHash } from 'node:crypto'
import { now, one, run, type Model, type Provider } from '../../infrastructure/database/db.js'

type PreviewInput = {
  signature: string; scene_ids: string[]; document_ids: string[]; model_id: string; skill_ids?: string[]
  mode: 'update' | 'redesign'; duration_mode: 'preserve' | 'reestimate'; instructions: string
  target_video_model_id?: string; target_duration?: number; shots_per_scene?: number | null
}
const namespace = 'storyboard-planning-preview'
const lifetimeMs = 24 * 60 * 60_000

/** Completed previews stay private until the creator commits the accepted draft. */
export function storyboardPlanningPreviewKey(input: PreviewInput, defaultSkillIds: string[], targetSignature?: string): string {
  const model = one<Model>('SELECT * FROM models WHERE id=?', input.model_id)
  const provider = model ? one<Provider>('SELECT * FROM providers WHERE id=?', model.provider_id) : null
  const modelSignature = model ? createHash('sha256').update(JSON.stringify({ model: {
    id: model.id, remote_id: model.remote_id, protocol: model.protocol, settings: model.settings, enabled: model.enabled, archived: model.archived,
  }, provider: provider && { id: provider.id, adapter: provider.adapter, base_url: provider.base_url, protocol: provider.protocol,
    auth_header: provider.auth_header, auth_prefix: provider.auth_prefix, key_ciphertext: provider.key_ciphertext,
    enabled: provider.enabled, archived: provider.archived } })).digest('hex') : null
  return createHash('sha256').update(JSON.stringify({ version: 1, signature: input.signature,
    scene_ids: [...input.scene_ids].sort(), document_ids: [...input.document_ids].sort(),
    model_id: input.model_id, model_signature: modelSignature, skill_ids: input.skill_ids ?? defaultSkillIds, mode: input.mode,
    duration_mode: input.duration_mode, instructions: input.instructions, target_duration: input.target_duration ?? null,
    shots_per_scene: input.shots_per_scene ?? null, target_video_model_id: input.target_video_model_id ?? null,
    target_signature: targetSignature ?? null,
  })).digest('hex')
}

export function readStoryboardPlanningPreview(projectId: string, key: string): unknown {
  const row = one<{ payload: string; updated_at: string }>(
    'SELECT payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, key)
  if (!row || !Number.isFinite(Date.parse(row.updated_at)) || Date.now() - Date.parse(row.updated_at) > lifetimeMs) return null
  try { return JSON.parse(row.payload) } catch { return null }
}

export function saveStoryboardPlanningPreview(projectId: string, key: string, preview: unknown): void {
  run(`INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at`,
  projectId, namespace, key, JSON.stringify(preview), now())
}
