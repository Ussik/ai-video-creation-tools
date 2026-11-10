import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, now, one, run } from '../../infrastructure/database/db.js'
import { currentScriptCheckpointModelMigration, migrateCompleteScriptDrafts, legacyScriptCheckpointIdentity } from './script-checkpoint-model-migration.js'
import type { GenerationCheckpoint } from './script-generation-steps.js'

const checkpointSchema = z.object({ prompt: z.string().optional(), steps: z.record(z.string(), z.object({
  input_hash: z.string(), value: z.unknown(), duration_ms: z.number().nonnegative(),
}).strict()) }).strict()

/** One active display slot per project; exact historical identities remain
 * privately resumable. Formal documents and the uploaded source are untouched. */
export function generationCheckpointStore(projectId: string, identity: unknown, namespace = 'generation', compatibleIdentities: readonly unknown[] = []) {
  const identityKey = (value: unknown) => createHash('sha256').update(JSON.stringify({ version: 1, identity: value })).digest('hex')
  const key = identityKey(identity)
  // Exact identities coexist privately, so moving one active display slot does
  // not destroy a prior model/source's validated work.
  db.exec(`CREATE TABLE IF NOT EXISTS script_checkpoint_versions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id,namespace,cache_key))`)
  const archive = (cacheKey: string, state: GenerationCheckpoint) => namespace !== 'generation' ? undefined : run(`INSERT INTO script_checkpoint_versions
    (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace,cache_key)
    DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`, projectId, namespace, cacheKey, JSON.stringify(state), now())
  const row = namespace === 'generation'
    ? one<{ cache_key: string; payload: string }>('SELECT cache_key, payload FROM script_generation_checkpoints WHERE project_id=?', projectId)
    : one<{ cache_key: string; payload: string }>('SELECT cache_key, payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, namespace)
  const exact = row?.cache_key === key ? row : namespace !== 'generation' ? undefined : one<{ cache_key: string; payload: string }>(
    'SELECT cache_key,payload FROM script_checkpoint_versions WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, key)
  let checkpoint: GenerationCheckpoint = { steps: {} }
  let reusedCompatibleIdentity = false
  let migratedStepIds: string[] = []
  // Callers may name exact historical identities when only their prompt
  // serialization changed. Preserve the validated workspace verbatim; the
  // next ordinary save moves its outer key without rewriting step hashes.
  let historicalSerialization = false
  if (!exact && row) {
    try {
      const original = checkpointSchema.parse(JSON.parse(row.payload)) as GenerationCheckpoint
      const previousIdentity = legacyScriptCheckpointIdentity(identity, original)
      historicalSerialization = previousIdentity !== undefined && identityKey(previousIdentity) === row.cache_key
    } catch { /* Damaged rows remain ineligible. */ }
  }
  const reusable = exact || (row && (historicalSerialization || compatibleIdentities.some(value => identityKey(value) === row.cache_key)) ? row : undefined)
  if (reusable) {
    try {
      checkpoint = checkpointSchema.parse(JSON.parse(reusable.payload)) as GenerationCheckpoint
      reusedCompatibleIdentity = reusable.cache_key !== key
      if (historicalSerialization) migratedStepIds = Object.keys(checkpoint.steps).filter(id => /^(?:draft(?::whole)?|work:[^/]+\/draft)$/.test(id))
    }
    catch { /* A damaged intermediate workspace can be regenerated safely. */ }
  }
  const migration = currentScriptCheckpointModelMigration()
  if (namespace === 'generation' && migration && !Object.keys(checkpoint.steps).length) {
    const target = identity as { model?: unknown; provider?: unknown }
    if (JSON.stringify({ model: target.model, provider: target.provider }) !== JSON.stringify(migration.to)) {
      throw Object.assign(new Error('换模型请求与本次执行配置不一致，成果没有迁移'), { statusCode: 409 })
    }
    const previousIdentity = { ...(identity as object), ...migration.from }
    let previousKey = identityKey(previousIdentity)
    let previous = row?.cache_key === previousKey ? row : one<{ cache_key: string; payload: string }>(
      'SELECT cache_key,payload FROM script_checkpoint_versions WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, previousKey)
    if (!previous && row) {
      try {
        const original = checkpointSchema.parse(JSON.parse(row.payload)) as GenerationCheckpoint
        const historical = legacyScriptCheckpointIdentity(previousIdentity, original)
        if (historical !== undefined && identityKey(historical) === row.cache_key) { previous = row; previousKey = row.cache_key }
      } catch { /* Exact historical identity proof is required. */ }
    }
    if (!previous) throw Object.assign(new Error('项目资料、创作要求或合同已变化，不能换模型续用旧任务'), { statusCode: 409 })
    const original = checkpointSchema.parse(JSON.parse(previous.payload)) as GenerationCheckpoint
    checkpoint = migrateCompleteScriptDrafts(original, identity, migration.sourceVersion)
    migratedStepIds = Object.keys(checkpoint.steps)
    db.transaction(() => {
      archive(previousKey, original)
      archive(key, checkpoint)
      run('INSERT INTO script_generation_checkpoints (project_id,cache_key,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, key, JSON.stringify(checkpoint), now())
    })()
  }
  return {
    checkpoint,
    reusedCompatibleIdentity, migratedStepIds,
    save(state: GenerationCheckpoint) {
      checkpointSchema.parse(state)
      if (row && row.cache_key !== key) {
        try { archive(row.cache_key, checkpointSchema.parse(JSON.parse(row.payload)) as GenerationCheckpoint) } catch { /* Preserve only valid legacy rows. */ }
      }
      archive(key, state)
      if (namespace !== 'generation') {
        run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, namespace, key, JSON.stringify(state), now())
        return
      }
      run('INSERT INTO script_generation_checkpoints (project_id, cache_key, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET cache_key=excluded.cache_key, payload=excluded.payload, updated_at=excluded.updated_at',
        projectId, key, JSON.stringify(state), now())
    },
  }
}

export function clearGenerationCheckpoint(projectId: string, options: { keepReview?: boolean } = {}) {
  run('DELETE FROM script_generation_checkpoints WHERE project_id=?', projectId)
  db.exec(`CREATE TABLE IF NOT EXISTS script_checkpoint_versions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,namespace TEXT NOT NULL,cache_key TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,namespace,cache_key))`)
  // A reviewed source proposal remains private until its stage draft is saved.
  // Keep its validated analysis so publishing the candidate cannot force an
  // identical manuscript through another full read after confirmation.
  // When a candidate pauses for the creator's answer, its completed review groups
  // stay: each step is keyed by the hash of its complete prompt, so a group whose
  // candidate text, manuscript and creator context did not change is reused, and
  // one whose input did change is simply reviewed again.
  const kept = ['source-proposal', 'source-proposal-base', 'source-proposal-usage', 'source-revision-base', ...(options.keepReview ? ['draft-review'] : [])]
  run(`DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace NOT IN (${kept.map(() => '?').join(',')})`, projectId, ...kept)
  run(`DELETE FROM script_checkpoint_versions WHERE project_id=? AND namespace NOT IN (${kept.map(() => '?').join(',')})`, projectId, ...kept)
}
