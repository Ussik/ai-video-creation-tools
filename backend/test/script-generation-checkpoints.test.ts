import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-generation-checkpoints-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, one, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
assert.ok(db.name.startsWith(dataDir), 'checkpoint tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

test('validated progress survives reopening; changed source, request or model cannot reuse it', async () => {
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'p', 'checkpoint', now(), now())
  const identity = { source: 'v1', prompt: '水墨', model: 'a' }
  const store = generationCheckpointStore('p', identity)
  await createGenerationSteps(store).run('a', '栏目', identity, async () => ({ content: '完成正文' }), value => value)
  assert.deepEqual(generationCheckpointStore('p', identity).checkpoint.steps.a.value, { content: '完成正文' })
  for (const changed of [{ ...identity, source: 'v2' }, { ...identity, prompt: '写实' }, { ...identity, model: 'b' }]) {
    assert.deepEqual(generationCheckpointStore('p', changed).checkpoint.steps, {})
  }
  assert.equal(one<{ count: number }>('SELECT COUNT(*) count FROM script_generation_checkpoints')!.count, 1)
  run("UPDATE script_generation_checkpoints SET payload='invalid' WHERE project_id='p'")
  assert.deepEqual(generationCheckpointStore('p', identity).checkpoint.steps, {})
  store.save(store.checkpoint)
  clearGenerationCheckpoint('p')
  assert.deepEqual(generationCheckpointStore('p', identity).checkpoint.steps, {})
  store.save(store.checkpoint)
  run("DELETE FROM projects WHERE id='p'")
  assert.equal(one('SELECT * FROM script_generation_checkpoints'), undefined)
})
