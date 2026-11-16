import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-generation-attempt-isolation-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore } = await import('../src/modules/script/script-generation-checkpoints.js')
const { scriptGenerationCheckpointAttempt } = await import('../src/modules/script/script-generation-attempt.js')
assert.ok(db.name.startsWith(dataDir), 'attempt-isolation tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

test('fresh props attempts are isolated and explicit continuation retains its own checkpoint', () => {
  const projectId = 'props-attempt-isolation'
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, 'attempt isolation', now(), now())
  const identity = { source: 'props-source-v1', model: 'model-a', workflow: { stage: 'props', artifact_types: ['prop_visuals'] }, prompt: '道具外观与辨识' }
  const failed: GenerationCheckpoint = { prompt: '原道具创作任务', steps: {
    'draft:stream:state': { input_hash: 'a'.repeat(64), value: { pendingArtifacts: ['PRIVATE_UNREPAIRED_PROP_CANDIDATE'] } },
  } }
  generationCheckpointStore(projectId, identity).save(failed)

  const fresh = scriptGenerationCheckpointAttempt(identity, 'task-fresh', false)
  assert.deepEqual(fresh.compatibleIdentities, [])
  const freshStore = generationCheckpointStore(projectId, fresh.identity, 'generation', fresh.compatibleIdentities)
  assert.deepEqual(freshStore.checkpoint.steps, {})
  const freshCheckpoint: GenerationCheckpoint = { steps: {
    'draft:stream:state': { input_hash: 'b'.repeat(64), value: { pendingArtifacts: ['FRESH_RETRY_CANDIDATE'] } },
  } }
  freshStore.save(freshCheckpoint)

  const resumedFresh = scriptGenerationCheckpointAttempt(identity, 'task-fresh', true)
  assert.deepEqual(generationCheckpointStore(projectId, resumedFresh.identity, 'generation', resumedFresh.compatibleIdentities).checkpoint, freshCheckpoint)
  const resumedOriginal = scriptGenerationCheckpointAttempt(identity, 'task-original', true)
  const originalStore = generationCheckpointStore(projectId, resumedOriginal.identity, 'generation', resumedOriginal.compatibleIdentities)
  assert.equal(originalStore.reusedCompatibleIdentity, true)
  assert.match(JSON.stringify(originalStore.checkpoint), /PRIVATE_UNREPAIRED_PROP_CANDIDATE/)
})
