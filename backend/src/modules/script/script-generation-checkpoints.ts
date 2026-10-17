import { createHash } from 'node:crypto'
import { z } from 'zod'
import { now, one, run } from '../../infrastructure/database/db.js'
import type { GenerationCheckpoint } from './script-generation-steps.js'

const checkpointSchema = z.object({ prompt: z.string().optional(), steps: z.record(z.string(), z.object({
  input_hash: z.string(), value: z.unknown(), duration_ms: z.number().nonnegative(),
}).strict()) }).strict()

/** One bounded workspace per project. Formal documents and the immutable
 * uploaded source are never changed by intermediate generation checkpoints. */
export function generationCheckpointStore(projectId: string, identity: unknown, namespace = 'generation') {
  const key = createHash('sha256').update(JSON.stringify({ version: 1, identity })).digest('hex')
  const row = namespace === 'generation'
    ? one<{ cache_key: string; payload: string }>('SELECT cache_key, payload FROM script_generation_checkpoints WHERE project_id=?', projectId)
    : one<{ cache_key: string; payload: string }>('SELECT cache_key, payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, namespace)
  let checkpoint: GenerationCheckpoint = { steps: {} }
  if (row?.cache_key === key) {
    try { checkpoint = checkpointSchema.parse(JSON.parse(row.payload)) as GenerationCheckpoint }
    catch { /* A damaged intermediate workspace can be regenerated safely. */ }
  }
  return {
    checkpoint,
    save(state: GenerationCheckpoint) {
      if (namespace !== 'generation') {
        run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at', projectId, namespace, key, JSON.stringify(state), now())
        return
      }
      run('INSERT INTO script_generation_checkpoints (project_id, cache_key, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET cache_key=excluded.cache_key, payload=excluded.payload, updated_at=excluded.updated_at',
        projectId, key, JSON.stringify(state), now())
    },
  }
}

export function clearGenerationCheckpoint(projectId: string) {
  run('DELETE FROM script_generation_checkpoints WHERE project_id=?', projectId)
  // A reviewed source proposal remains private until its stage draft is saved.
  // Keep its validated analysis so publishing the candidate cannot force an
  // identical manuscript through another full read after confirmation.
  run("DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace!='source-proposal'", projectId)
}
