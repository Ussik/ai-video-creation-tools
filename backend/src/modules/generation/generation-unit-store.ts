import { createHash } from 'node:crypto'
import { db, now } from '../../infrastructure/database/db.js'
import type { GenerationCheckpoint } from '../script/script-generation-steps.js'

function valid(value: unknown): value is GenerationCheckpoint {
  if (!value || typeof value !== 'object' || !('steps' in value)) return false
  const steps = (value as GenerationCheckpoint).steps
  return !!steps && typeof steps === 'object' && !Array.isArray(steps) && Object.values(steps).every(step =>
    step && typeof step.input_hash === 'string' && /^[a-f0-9]{64}$/.test(step.input_hash) && Object.hasOwn(step, 'value') && typeof step.duration_ms === 'number' && Number.isFinite(step.duration_ms) && step.duration_ms >= 0)
}
/** Identity rows coexist: one design/range cannot overwrite another task's
 * recoverable progress. No formal document is changed by checkpoint saves. */
export function generationUnitStore(projectId: string, namespace: string, identity: unknown) {
  if (!namespace.trim() || namespace.length > 500) throw new Error('生成任务命名空间无效')
  db.exec(`CREATE TABLE IF NOT EXISTS model_unit_checkpoints (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, namespace, identity_hash))`)
  const hash = createHash('sha256').update(JSON.stringify({ version: 1, identity })).digest('hex')
  const read = (): GenerationCheckpoint => {
    const row = db.prepare('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=? AND identity_hash=?').get(projectId, namespace, hash) as { payload: string } | undefined
    if (!row) return { steps: {} }
    let state: unknown
    try { state = JSON.parse(row.payload) } catch { /* Report the intact damaged record below; never regenerate silently. */ }
    if (!valid(state)) throw Object.assign(new Error('已保留生成进度的检查点已损坏，已停止自动重生成；记录与正式文档均保留，请明确重新生成后重试'), { statusCode: 409, code: 'generation_checkpoint_corrupt' })
    return structuredClone(state)
  }
  return {
    get checkpoint() { return read() }, read,
    save(state: GenerationCheckpoint) {
      if (!valid(state)) throw new Error('不能保存未经验证的生成检查点')
      db.prepare(`INSERT INTO model_unit_checkpoints (project_id,namespace,identity_hash,payload,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(project_id,namespace,identity_hash) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
        .run(projectId, namespace, hash, JSON.stringify(state), now())
    },
    clear() { db.prepare('DELETE FROM model_unit_checkpoints WHERE project_id=? AND namespace=? AND identity_hash=?').run(projectId, namespace, hash) },
  }
}
