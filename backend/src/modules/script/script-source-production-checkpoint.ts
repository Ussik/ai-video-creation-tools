import { all, one } from '../../infrastructure/database/db.js'
import { generationCheckpointStore } from './script-generation-checkpoints.js'

/** A different prompt/config is a new purchase, not a recovery of an unknown
 * response. Reject before changing the active workspace; other episodes and
 * local scene import are independent. Exact-input retries use normal guards. */
export function sourceProductionGenerationStore(projectId: string, episode: number, identity: unknown) {
  const namespace = `source-production:episode:${episode}`
  const current = one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, namespace)
  const next = generationCheckpointStore(projectId, identity, namespace)
  const retained = all<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_checkpoint_versions WHERE project_id=? AND namespace=?', projectId, namespace)
  for (const row of [...(current ? [current] : []), ...retained]) {
    let entries: Array<[string, { value?: unknown }]>
    try { entries = Object.entries(JSON.parse(row.payload).steps) } catch { throw Object.assign(new Error('本集制作断点损坏，已保留原记录，请先核对'), { statusCode: 409 }) }
    if (row.cache_key !== next.key && entries.some(([key, record]) => {
      if (!key.startsWith('response:') || !record.value || typeof record.value !== 'object') return false
      const value = record.value as { initial_started?: unknown; raw?: string; correction_started?: unknown; correction?: { raw?: string } }
      return value.initial_started && !value.raw || value.correction_started && !value.correction?.raw
    })) throw Object.assign(new Error('本集有受理状态未知的制作请求，不能通过更换提示、原稿或模型重发；请核对该请求后继续。其他集和原文导入不受影响。'), {
      statusCode: 409, code: 'source_production_request_unknown', delivery: 'not_sent', retryable: false, sourceOutputRecoveryBlocked: true,
    })
  }
  return next
}
