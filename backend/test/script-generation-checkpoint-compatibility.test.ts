import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-checkpoint-compatibility-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, one, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore } = await import('../src/modules/script/script-generation-checkpoints.js')
assert.ok(db.name.startsWith(dataDir), 'compatibility tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

const oldIdentity = { source: 'source-v1', model: 'model-a', workflow: { stage: 'props' }, prompt: '只读资料：type、status' }
const newIdentity = { ...oldIdentity, prompt: '只读资料：artifact_type，保存状态独立列出' }
const key = (identity: unknown) => createHash('sha256').update(JSON.stringify({ version: 1, identity })).digest('hex')
const checkpoint: GenerationCheckpoint = {
  prompt: '旧的完整创作任务与原稿，重试仍沿用此前授权。',
  steps: {
    'draft:stream:state': { input_hash: 'retained-stream-input-hash', duration_ms: 0, value: {
      version: 1, round: 4, initialEnded: true, target: 'prop_visuals', mode: 'document',
      artifacts: [{ artifact_type: 'props', title: '道具清单', content: '# 钥匙\n林舟持有，结局交还。' }],
      scenes: [], blocks: [
        { id: 'prop_visual:钥匙', title: '外观与辨识', content: '旧铜钥匙，柄端有一道完整月纹。', scenes: [] },
        { id: 'prop_visual:木匣', title: '外观与辨识', content: '木匣左下角有缺口，始终保持这一辨识细节。', scenes: [] },
      ], noProgress: 0, focused: false,
    } },
    draft: { input_hash: 'retained-draft-input-hash', duration_ms: 37, value: {
      artifacts: [{ artifact_type: 'props', title: '待确认道具草稿', content: '已完成正文保持原样。' }], scenes: [],
    } },
  },
}

function project(id: string) {
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', id, 'checkpoint compatibility', now(), now())
}

test('an exact compatible identity loads preserved content without writing, then ordinary save adopts the current key', () => {
  project('compatible')
  generationCheckpointStore('compatible', oldIdentity).save(checkpoint)
  const originalPayload = one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', 'compatible')!.payload
  assert.deepEqual(generationCheckpointStore('compatible', newIdentity).checkpoint.steps, {})

  const resumed = generationCheckpointStore('compatible', newIdentity, 'generation', [oldIdentity])
  assert.equal(resumed.reusedCompatibleIdentity, true)
  assert.deepEqual(resumed.checkpoint, checkpoint, 'stream blocks, complete documents, draft text and inner hashes remain unchanged')
  assert.deepEqual(one('SELECT cache_key, payload FROM script_generation_checkpoints WHERE project_id=?', 'compatible'), {
    cache_key: key(oldIdentity), payload: originalPayload,
  }, 'loading compatibility does not write or change the legacy key')

  resumed.save(resumed.checkpoint)
  const migrated = one<{ cache_key: string; payload: string }>('SELECT cache_key, payload FROM script_generation_checkpoints WHERE project_id=?', 'compatible')!
  assert.equal(migrated.cache_key, key(newIdentity))
  assert.deepEqual(JSON.parse(migrated.payload), checkpoint)
  const reopened = generationCheckpointStore('compatible', newIdentity)
  assert.equal(reopened.reusedCompatibleIdentity, false)
  assert.deepEqual(reopened.checkpoint, checkpoint)
  assert.deepEqual(generationCheckpointStore('compatible', oldIdentity).checkpoint, checkpoint, 'exact historical identities keep their original validated work privately resumable')
  assert.deepEqual(one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_generation_checkpoints WHERE project_id=?', 'compatible'), migrated, 'reading archived work does not replace the current display slot')
})

test('compatible formatting identities do not match changed source or model inputs', () => {
  project('isolated')
  generationCheckpointStore('isolated', oldIdentity).save(checkpoint)
  for (const change of [{ source: 'source-v2' }, { model: 'model-b' }]) {
    const resumed = generationCheckpointStore('isolated', { ...newIdentity, ...change }, 'generation', [{ ...oldIdentity, ...change }])
    assert.equal(resumed.reusedCompatibleIdentity, false)
    assert.deepEqual(resumed.checkpoint.steps, {})
  }
  assert.deepEqual(generationCheckpointStore('isolated', oldIdentity).checkpoint, checkpoint)
})

test('compatibility stays inside the requested namespace and does not reuse a damaged payload', () => {
  project('namespaced')
  generationCheckpointStore('namespaced', oldIdentity, 'source-proposal').save(checkpoint)
  assert.deepEqual(generationCheckpointStore('namespaced', newIdentity, 'generation', [oldIdentity]).checkpoint.steps, {})
  const resumed = generationCheckpointStore('namespaced', newIdentity, 'source-proposal', [oldIdentity])
  assert.equal(resumed.reusedCompatibleIdentity, true)
  resumed.save(resumed.checkpoint)
  assert.deepEqual(generationCheckpointStore('namespaced', newIdentity, 'source-proposal').checkpoint, checkpoint)
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', 'namespaced'), undefined)

  run('UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace=?', 'invalid', 'namespaced', 'source-proposal')
  const damaged = generationCheckpointStore('namespaced', { ...newIdentity, prompt: 'next format' }, 'source-proposal', [newIdentity])
  assert.equal(damaged.reusedCompatibleIdentity, false)
  assert.deepEqual(damaged.checkpoint.steps, {})
})
