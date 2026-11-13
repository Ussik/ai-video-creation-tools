import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, now, one, run } from '../../infrastructure/database/db.js'
import { currentScriptCheckpointModelMigration, migrateCompleteScriptDrafts, legacyScriptCheckpointIdentity } from './script-checkpoint-model-migration.js'
import type { GenerationCheckpoint } from './script-generation-steps.js'

const checkpointSchema = z.object({ prompt: z.string().optional(), steps: z.record(z.string(), z.object({
  input_hash: z.string(), value: z.unknown(), duration_ms: z.number().nonnegative().optional(),
}).strict()) }).strict()

const historyPrefix = 'generation-history:'
const historyNamespace = (key: string) => `${historyPrefix}${key}`
type CheckpointRow = { cache_key: string; payload: string; updated_at: string }

/** One active workspace per project, with replaced generation identities kept
 * privately for exact-input recovery. Formal documents and the immutable
 * uploaded source are never changed by intermediate generation checkpoints. */
export function generationCheckpointStore(projectId: string, identity: unknown, namespace = 'generation', compatibleIdentities: readonly unknown[] = []) {
  if (namespace.startsWith(historyPrefix)) throw new Error('生成历史命名空间仅供断点归档使用')
  const identityKey = (value: unknown) => createHash('sha256').update(JSON.stringify({ version: 1, identity: value })).digest('hex')
  const key = identityKey(identity)
  db.exec(`CREATE TABLE IF NOT EXISTS script_checkpoint_versions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,namespace TEXT NOT NULL,cache_key TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,namespace,cache_key))`)
  const historicalRow = (cacheKey: string) => one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?', projectId, historyNamespace(cacheKey), cacheKey)
    || one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_checkpoint_versions WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, cacheKey)
  const row = namespace === 'generation'
    ? one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
    : one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, namespace)
  let checkpoint: GenerationCheckpoint = { steps: {} }
  let reusedCompatibleIdentity = false
  let compatibleSourceKey: string | undefined
  let migratedStepIds: string[] = []
  let historicalSerialization = false
  if (row) {
    try {
      const original = checkpointSchema.parse(JSON.parse(row.payload)) as GenerationCheckpoint
      const previousIdentity = legacyScriptCheckpointIdentity(identity, original)
      historicalSerialization = previousIdentity !== undefined && identityKey(previousIdentity) === row.cache_key
    } catch { /* Exact historical identity proof is required. */ }
  }
  // Callers may name exact historical identities when only their prompt
  // serialization changed. Preserve the validated workspace verbatim; the
  // next ordinary save moves its outer key without rewriting step hashes.
  const acceptedKeys = [...new Set([key, ...compatibleIdentities.map(identityKey), ...(historicalSerialization && row ? [row.cache_key] : [])])]
  for (const acceptedKey of acceptedKeys) {
    const candidate = row?.cache_key === acceptedKey ? row : namespace === 'generation'
      ? historicalRow(acceptedKey)
      : undefined
    if (!candidate) continue
    try {
      checkpoint = checkpointSchema.parse(JSON.parse(candidate.payload)) as GenerationCheckpoint
      reusedCompatibleIdentity = candidate.cache_key !== key
      compatibleSourceKey = reusedCompatibleIdentity ? candidate.cache_key : undefined
      if (historicalSerialization && candidate === row) migratedStepIds = Object.keys(checkpoint.steps).filter(id => /^(?:draft(?::whole)?|work(?::document)?:[^/]+\/draft)$/.test(id))
      break
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
    let previous = row?.cache_key === previousKey ? row : historicalRow(previousKey)
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
      run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, historyNamespace(previousKey), previousKey, JSON.stringify(original), previous.updated_at)
      run('INSERT INTO script_generation_checkpoints (project_id,cache_key,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, key, JSON.stringify(checkpoint), now())
    })()
  }
  return {
    checkpoint,
    reusedCompatibleIdentity, migratedStepIds,
    save(state: GenerationCheckpoint) {
      checkpointSchema.parse(state)
      if (namespace !== 'generation') {
        run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, namespace, key, JSON.stringify(state), now())
        return
      }
      db.transaction(() => {
        // Read at save time: another identity may have become active since this
        // store was opened. Archive that exact durable snapshot before replacing it.
        const previous = one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
        if (previous && previous.cache_key !== key && /^[a-f0-9]{64}$/.test(previous.cache_key)) {
          run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at',
            projectId, historyNamespace(previous.cache_key), previous.cache_key, previous.payload, previous.updated_at)
        }
        run('INSERT INTO script_generation_checkpoints (project_id, cache_key, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET cache_key=excluded.cache_key, payload=excluded.payload, updated_at=excluded.updated_at',
          projectId, key, JSON.stringify(state), now())
        // A compatible identity is the same workspace under a new serializer,
        // not another task. Consume only the validated source actually reused,
        // so clearing the migrated task cannot revive its pre-migration copy.
        if (compatibleSourceKey) {
          run('DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?', projectId, historyNamespace(compatibleSourceKey), compatibleSourceKey)
          run('DELETE FROM script_checkpoint_versions WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, compatibleSourceKey)
        }
      })()
      compatibleSourceKey = undefined
    },
  }
}

export function clearGenerationCheckpoint(projectId: string, options: { keepReview?: boolean } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS script_checkpoint_versions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,namespace TEXT NOT NULL,cache_key TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,namespace,cache_key))`)
  // A reviewed source proposal remains private until its stage draft is saved.
  // Keep its validated analysis so publishing the candidate cannot force an
  // identical manuscript through another full read after confirmation.
  // When a candidate pauses for the creator's answer, its completed review groups
  // stay: each step is keyed by the hash of its complete prompt, so a group whose
  // candidate text, manuscript and creator context did not change is reused, and
  // one whose input did change is simply reviewed again.
  const kept = ['source-proposal', 'source-proposal-base', 'source-proposal-usage', 'source-revision-base', 'storyboard-planning-preview', ...(options.keepReview ? ['draft-review'] : [])]
  db.transaction(() => {
    const current = one<{ cache_key: string }>('SELECT cache_key FROM script_generation_checkpoints WHERE project_id=?', projectId)
    // Saving or discarding the active task clears that identity, including a
    // previously archived snapshot. Other tasks remain recoverable by exact input.
    if (current) {
      run('DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, historyNamespace(current.cache_key))
      run('DELETE FROM script_checkpoint_versions WHERE project_id=? AND namespace=? AND cache_key=?', projectId, 'generation', current.cache_key)
    }
    run('DELETE FROM script_generation_checkpoints WHERE project_id=?', projectId)
    // Only generated, exact hash namespaces receive history protection.
    run(`DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace NOT IN (${kept.map(() => '?').join(',')})
      AND namespace NOT LIKE 'storyboard-planning-task:%'
      AND NOT (namespace GLOB ? AND length(namespace)=? AND substr(namespace,?) NOT GLOB '*[^0-9a-f]*')`,
    projectId, ...kept, `${historyPrefix}*`, historyPrefix.length + 64, historyPrefix.length + 1)
  })()
}
