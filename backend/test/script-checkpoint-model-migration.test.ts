import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createHash } from 'node:crypto'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-model-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { withScriptCheckpointModelMigration, currentScriptCheckpointModelMigration } = await import('../src/modules/script/script-checkpoint-model-migration.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
assert.ok(db.name.startsWith(dataDir))
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const from = { model: { id: 'old', remote_id: 'old-remote', protocol: 'chat', settings: '{}' }, provider: { id: 'p', adapter: 'openai', base_url: 'https://old.invalid', auth_header: 'Authorization', auth_prefix: 'Bearer ' } }
const to = { model: { id: 'new', remote_id: 'new-remote', protocol: 'responses', settings: '{"context_window":16000}' }, provider: { ...from.provider, base_url: 'https://new.invalid' } }
const workflow = { stage: 'outline', scope: 'project', episode_number: 0, artifact_types: ['outline'] }
const identity = { strategy: 'whole-source-v1', prompt: '完整创作要求', messages: ['原始说明'], workflow, source: { version: 'source-v1' }, ...from }
const target = { ...identity, ...to }
const migration = { from, to, sourceVersion: 'source-v1' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const draft = { ...workflow, artifacts: [{ artifact_type: 'outline', title: '原始标题', content: '\n完整原创正文，尾部空白保持。\n' }], scenes: [] }
function seed(id: string) {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, 'migration test', now(), now())
  const store = generationCheckpointStore(id, identity)
  store.save({ prompt: '固定全文提示词', steps: {
    'progress:source': { input_hash: hash(null), value: { source_version: 'source-v1', task_id: 'old-task' }, duration_ms: 0 },
    'work:outline:story/draft': { input_hash: hash({ input: 'same business input' }), value: draft, duration_ms: 55 },
    'draft:stream:state': { input_hash: hash('stream'), value: { artifacts: [{ content: 'HALF_JSON' }], remote_response_id: 'resp_old', encrypted_reasoning: 'opaque_old' }, duration_ms: 0 },
    'repair:tools:batches': { input_hash: hash('tools'), value: { remote_response_id: 'remote' }, duration_ms: 1 },
  } })
  return store
}
test('only explicit switching migrates complete exact-contract drafts and preserves the old identity independently', async () => {
  seed('explicit')
  const original = structuredClone(generationCheckpointStore('explicit', identity).checkpoint)
  assert.deepEqual(generationCheckpointStore('explicit', target).checkpoint.steps, {})
  const moved = await withScriptCheckpointModelMigration(migration, async () => {
    await Promise.resolve()
    assert.equal(currentScriptCheckpointModelMigration()?.to.model.id, 'new')
    return generationCheckpointStore('explicit', target)
  })
  assert.deepEqual(Object.keys(moved.checkpoint.steps), ['work:outline:story/draft'])
  assert.deepEqual(moved.checkpoint.steps['work:outline:story/draft'].value, draft)
  assert.ok(!JSON.stringify(moved.checkpoint).includes('opaque_old'))
  assert.equal(moved.checkpoint.prompt, '固定全文提示词')
  let dispatches = 0
  const result = await createGenerationSteps(moved).run('work:outline:story/draft', '复用', { input: 'same business input' }, async () => { dispatches++; return draft }, value => value)
  assert.deepEqual(result, draft); assert.equal(dispatches, 0)
  assert.deepEqual(generationCheckpointStore('explicit', identity).checkpoint, original)
  assert.equal(Object.keys(generationCheckpointStore('explicit', identity).checkpoint.steps).length, 4)
  assert.equal(currentScriptCheckpointModelMigration(), undefined)
})
test('changed source, requirement, runtime or source binding rejects migration without touching old results', () => {
  seed('mismatch')
  for (const changed of [{ ...target, source: { version: 'source-v2' } }, { ...target, prompt: 'changed' }, { ...target, model: { ...to.model, remote_id: 'unexpected' } }]) {
    assert.throws(() => withScriptCheckpointModelMigration(migration, () => generationCheckpointStore('mismatch', changed)), /已变化|配置不一致/)
  }
  assert.throws(() => withScriptCheckpointModelMigration({ ...migration, sourceVersion: 'source-v2' }, () => generationCheckpointStore('mismatch', target)), /来源/)
  assert.equal(Object.keys(generationCheckpointStore('mismatch', identity).checkpoint.steps).length, 4)
})
test('partial results, invalid complete drafts and opaque extra fields cannot be migrated', () => {
  const store = seed('invalid')
  const state = generationCheckpointStore('invalid', identity).checkpoint
  state.steps['work:outline:story/draft'].value = { ...draft, remote_response_id: 'opaque' }
  store.save(state)
  assert.throws(() => withScriptCheckpointModelMigration(migration, () => generationCheckpointStore('invalid', target)), /尚无可迁移/)
  state.steps['work:outline:story/draft'].value = { ...draft, artifacts: [] }
  store.save(state)
  assert.throws(() => withScriptCheckpointModelMigration(migration, () => generationCheckpointStore('invalid', target)), /尚无可迁移/)
  assert.deepEqual(generationCheckpointStore('invalid', target).checkpoint.steps, {})
})
test('independent source history remains isolated and clearing only removes the active identity', () => {
  seed('history')
  const changed = { ...identity, source: { version: 'another-source' } }
  const other = generationCheckpointStore('history', changed)
  other.save({ steps: { another: { input_hash: hash('another'), value: 'separate', duration_ms: 0 } } })
  assert.equal(Object.keys(generationCheckpointStore('history', identity).checkpoint.steps).length, 4)
  assert.deepEqual(generationCheckpointStore('history', changed).checkpoint.steps.another.value, 'separate')
  clearGenerationCheckpoint('history')
  assert.equal(Object.keys(generationCheckpointStore('history', identity).checkpoint.steps).length, 4, 'unrelated historical work remains recoverable')
  assert.deepEqual(generationCheckpointStore('history', changed).checkpoint.steps, {})
})


test('historical workflow key ordering can be proven by the full old identity hash, without relaxing any source or prompt bytes', async () => {
  const id = 'legacy-order'
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, 'legacy migration', now(), now())
  const oldWorkflow = { stage: 'outline', artifact_types: ['outline'], scope: 'project', episode_number: 0, intent: 'stage_design' }
  const newWorkflow = { stage: 'outline', intent: 'stage_design', artifact_types: ['outline'], scope: 'project', episode_number: 0 }
  const oldPrompt = '完整固定规则\n' + JSON.stringify({ task_scope: oldWorkflow, project: { name: 'original' } }) + '\n相同原文约束'
  const newPrompt = '完整固定规则\n' + JSON.stringify({ task_scope: newWorkflow, project: { name: 'original' } }) + '\n相同原文约束'
  const oldIdentity = { ...identity, workflow: oldWorkflow, prompt: oldPrompt }
  const newIdentity = { ...identity, workflow: newWorkflow, prompt: newPrompt }
  generationCheckpointStore(id, oldIdentity).save({ prompt: oldPrompt, steps: {
    'progress:source': { input_hash: hash(null), value: { source_version: 'source-v1' }, duration_ms: 0 },
    'work:outline:story/draft': { input_hash: hash({ version: 1, request: oldWorkflow, prompt: oldPrompt, dependencies: [] }), value: { ...draft, ...oldWorkflow }, duration_ms: 1 },
  } })
  const restored = generationCheckpointStore(id, newIdentity)
  assert.equal(restored.reusedCompatibleIdentity, true)
  assert.equal(Object.keys(restored.checkpoint.steps).length, 2)
  assert.throws(() => withScriptCheckpointModelMigration(migration, () => generationCheckpointStore(id, { ...newIdentity, ...to, prompt: newPrompt + 'changed' })), /已变化/)
  const moved = withScriptCheckpointModelMigration(migration, () => generationCheckpointStore(id, { ...newIdentity, ...to }))
  assert.deepEqual(Object.keys(moved.checkpoint.steps), ['work:outline:story/draft'])
  assert.equal(moved.checkpoint.prompt, oldPrompt)
  const restoredSteps = createGenerationSteps(moved), nextInput = { version: 1, request: newWorkflow, prompt: oldPrompt, dependencies: [] }
  const result = await restoredSteps.run('work:outline:story/draft', '复用旧版完整成果', nextInput, async () => assert.fail('equivalent workflow ordering must never regenerate completed prose'), value => value)
  assert.deepEqual(result, { ...draft, ...oldWorkflow })
  assert.equal(generationCheckpointStore(id, { ...newIdentity, ...to }).checkpoint.steps['work:outline:story/draft'].input_hash, hash(nextInput))
})
