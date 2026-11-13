import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, now, one, run } from '../../infrastructure/database/db.js'
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
  const row = namespace === 'generation'
    ? one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_generation_checkpoints WHERE project_id=?', projectId)
    : one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, namespace)
  let checkpoint: GenerationCheckpoint = { steps: {} }
  let reusedCompatibleIdentity = false
  let compatibleSourceKey: string | undefined
  // Callers may name exact historical identities when only their prompt
  // serialization changed. Preserve the validated workspace verbatim; the
  // next ordinary save moves its outer key without rewriting step hashes.
  const acceptedKeys = [...new Set([key, ...compatibleIdentities.map(identityKey)])]
  for (const acceptedKey of acceptedKeys) {
    const candidate = row?.cache_key === acceptedKey ? row : namespace === 'generation'
      ? one<CheckpointRow>('SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?',
        projectId, historyNamespace(acceptedKey), acceptedKey)
      : undefined
    if (!candidate) continue
    try {
      checkpoint = checkpointSchema.parse(JSON.parse(candidate.payload)) as GenerationCheckpoint
      reusedCompatibleIdentity = candidate.cache_key !== key
      compatibleSourceKey = reusedCompatibleIdentity ? candidate.cache_key : undefined
      break
    }
    catch { /* A damaged intermediate workspace can be regenerated safely. */ }
  }
  return {
    checkpoint,
    reusedCompatibleIdentity,
    save(state: GenerationCheckpoint) {
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
        if (compatibleSourceKey) run('DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?',
          projectId, historyNamespace(compatibleSourceKey), compatibleSourceKey)
      })()
      compatibleSourceKey = undefined
    },
  }
}

export function clearGenerationCheckpoint(projectId: string, options: { keepReview?: boolean } = {}) {
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
    if (current) run('DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, historyNamespace(current.cache_key))
    run('DELETE FROM script_generation_checkpoints WHERE project_id=?', projectId)
    // Only generated, exact hash namespaces receive history protection.
    run(`DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace NOT IN (${kept.map(() => '?').join(',')})
      AND namespace NOT LIKE 'storyboard-planning-task:%'
      AND NOT (namespace GLOB ? AND length(namespace)=? AND substr(namespace,?) NOT GLOB '*[^0-9a-f]*')`,
    projectId, ...kept, `${historyPrefix}*`, historyPrefix.length + 64, historyPrefix.length + 1)
  })()
}
