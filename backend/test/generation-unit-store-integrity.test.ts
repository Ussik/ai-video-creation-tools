import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const directory = await mkdtemp(join(tmpdir(), 'unit-store-integrity-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, now, one } = await import('../src/infrastructure/database/db.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const { creativeGenerationSteps } = await import('../src/modules/skills/creative-model-state.js')
assert.ok(db.name.startsWith(directory)); initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', 'p', 'checkpoint integrity', now(), now())

test('corrupt JSON or invalid saved unit structure fails closed without silently erasing progress', () => {
  const store = generationUnitStore('p', 'test', 'same-identity')
  store.save({ steps: { complete: { input_hash: 'a'.repeat(64), value: '完成正文', duration_ms: 1 } } })
  for (const payload of ['{broken', JSON.stringify({ steps: null }), JSON.stringify({ steps: { complete: { input_hash: 'wrong', value: '完成正文', duration_ms: 1 } } }), JSON.stringify({ steps: { complete: { input_hash: 'a'.repeat(64), value: '完成正文', duration_ms: -1 } } })]) {
    run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=?', payload, 'p', 'test')
    const reopened = generationUnitStore('p', 'test', 'same-identity')
    assert.throws(() => reopened.checkpoint, (error: unknown) => error instanceof Error && (error as Error & { statusCode: number }).statusCode === 409)
    assert.equal(one<{payload:string}>('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=?', 'p', 'test')!.payload, payload)
  }
})
test('an explicit restart can clear a corrupt checkpoint before reading it, while ordinary resume is blocked', async () => {
  let calls = 0
  assert.throws(() => creativeGenerationSteps('p', 'test', 'same-identity'), /检查点已损坏/)
  const restarted = creativeGenerationSteps('p', 'test', 'same-identity', undefined, true)
  const result = await restarted.run('new', '明确重新生成', 'new-input', async () => { calls++; return '新结果' }, value => value)
  assert.equal(calls, 1); assert.equal(result, '新结果')
  assert.equal(generationUnitStore('p', 'test', 'same-identity').checkpoint.steps.new.value, '新结果')
})
