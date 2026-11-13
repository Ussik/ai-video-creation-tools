import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-generation-checkpoints-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, one, all, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
assert.ok(db.name.startsWith(dataDir), 'checkpoint tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const key = (identity: unknown) => createHash('sha256').update(JSON.stringify({ version: 1, identity })).digest('hex')
const history = (identity: unknown) => `generation-history:${key(identity)}`
const project = (id: string) => run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now())
const state = (label: string) => ({ prompt: `原任务 ${label}\n  原稿空白保持  `, steps: { 'draft:stream:state': {
  input_hash: `${label}:step-identity`, value: { version: 1, target: 'location_layouts', blocks: [
    { id: `${label}:accepted`, title: '空间与动线', content: `  ${label} 已保留正文。\n`, scenes: [] },
  ], pendingBlockResponse: { value: { blocks: [{ id: `${label}:pending`, title: '空间与动线', content: `${label}待修正文。`, scenes: null }], complete: true },
    diagnostics: ['blocks[0].scenes: null'] } },
} } })

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

test('retained work without a measured duration survives durable checkpoint reload', async () => {
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'unmeasured', 'retained', now(), now())
  const identity = { prompt: '导入已完成正文' }
  createGenerationSteps(generationCheckpointStore('unmeasured', identity)).retain('draft', '已有栏目', identity, { content: '旧正文' }, value => value)
  const restored = generationCheckpointStore('unmeasured', identity)
  assert.deepEqual(restored.checkpoint.steps.draft?.value, { content: '旧正文' })
  assert.equal(restored.checkpoint.steps.draft?.duration_ms, undefined)
  const events: Array<{ reused?: boolean; duration_ms?: number }> = []
  await createGenerationSteps({ ...restored, onStep: event => events.push(event) }).run('draft', '已有栏目', identity,
    async () => { throw new Error('must reuse saved prose') }, value => value)
  assert.equal(events[0]?.reused, true)
  assert.equal(events[0]?.duration_ms, undefined)
})

test('switching generation identities archives exact bytes and preserves pending prose across alternating saves', () => {
  project('alternating')
  const a = { source: 'v1', task: '空间', model: 'a' }, b = { source: 'v1', task: '氛围', model: 'a' }
  const original = state('A'), other = state('B')
  generationCheckpointStore('alternating', a).save(original)
  const raw = JSON.stringify(original, null, 2) + '\n'
  run('UPDATE script_generation_checkpoints SET payload=?,updated_at=? WHERE project_id=?', raw, '2026-11-09T10:00:00.000Z', 'alternating')
  generationCheckpointStore('alternating', b).save(other)
  assert.deepEqual(one('SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace=?', 'alternating', history(a)),
    { cache_key: key(a), payload: raw, updated_at: '2026-11-09T10:00:00.000Z' })
  assert.deepEqual(generationCheckpointStore('alternating', a).checkpoint, original)
  const restored = generationCheckpointStore('alternating', a)
  restored.save(restored.checkpoint)
  assert.deepEqual(generationCheckpointStore('alternating', b).checkpoint, other)
  assert.deepEqual(generationCheckpointStore('alternating', a).checkpoint, original)
  assert.equal(one<{ cache_key: string }>('SELECT cache_key FROM script_generation_checkpoints WHERE project_id=?', 'alternating')!.cache_key, key(a))
  assert.equal(all('SELECT * FROM script_generation_checkpoints WHERE project_id=?', 'alternating').length, 1)
  assert.equal(all('SELECT * FROM script_step_checkpoints WHERE project_id=?', 'alternating').length, 2)
})

test('save archives the durable active identity even when this store opened before another task saved', () => {
  project('concurrent-open')
  const a = { task: 'A' }, b = { task: 'B' }, c = { task: 'C' }
  generationCheckpointStore('concurrent-open', a).save(state('A'))
  const waiting = generationCheckpointStore('concurrent-open', b)
  generationCheckpointStore('concurrent-open', c).save(state('C'))
  waiting.save(state('B'))
  assert.deepEqual(generationCheckpointStore('concurrent-open', c).checkpoint, state('C'))
  assert.deepEqual(generationCheckpointStore('concurrent-open', a).checkpoint, state('A'))
})

test('history requires exact identity or an explicit compatible identity and preserves compatible step hashes', () => {
  project('compatible-history')
  const oldIdentity = { source: 'v1', prompt: '旧序列化', config: 'x' }, newIdentity = { ...oldIdentity, prompt: '新序列化' }, other = { task: 'other' }
  const original = state('compatible')
  generationCheckpointStore('compatible-history', oldIdentity).save(original)
  generationCheckpointStore('compatible-history', other).save(state('other'))
  for (const changed of [{ ...oldIdentity, source: 'v2' }, { ...oldIdentity, config: 'y' }, newIdentity]) {
    assert.deepEqual(generationCheckpointStore('compatible-history', changed).checkpoint, { steps: {} })
  }
  const compatible = generationCheckpointStore('compatible-history', newIdentity, 'generation', [oldIdentity])
  assert.equal(compatible.reusedCompatibleIdentity, true)
  assert.deepEqual(compatible.checkpoint, original)
  compatible.save(compatible.checkpoint)
  assert.deepEqual(generationCheckpointStore('compatible-history', newIdentity).checkpoint, original)
  assert.deepEqual(generationCheckpointStore('compatible-history', oldIdentity).checkpoint, { steps: {} }, 'a compatible migration consumes only its actually reused source identity')
  assert.deepEqual(generationCheckpointStore('compatible-history', other).checkpoint, state('other'))
  assert.equal(one<{ cache_key: string }>('SELECT cache_key FROM script_generation_checkpoints WHERE project_id=?', 'compatible-history')!.cache_key, key(newIdentity))
  clearGenerationCheckpoint('compatible-history')
  assert.deepEqual(generationCheckpointStore('compatible-history', oldIdentity).checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('compatible-history', newIdentity, 'generation', [oldIdentity]).checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('compatible-history', other).checkpoint, state('other'))
})

test('compatible migration from the active row cannot leave a stale alias and does not consume other supplied identities', () => {
  project('active-compatible')
  const unrelated = { task: 'unrelated' }, a = { task: 'A', serialization: 1 }, b = { ...a, serialization: 2 }
  generationCheckpointStore('active-compatible', unrelated).save(state('unrelated'))
  generationCheckpointStore('active-compatible', a).save(state('A'))
  const migrated = generationCheckpointStore('active-compatible', b, 'generation', [a, unrelated])
  assert.equal(migrated.reusedCompatibleIdentity, true)
  migrated.save(migrated.checkpoint)
  clearGenerationCheckpoint('active-compatible')
  assert.deepEqual(generationCheckpointStore('active-compatible', a).checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('active-compatible', b, 'generation', [a]).checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('active-compatible', unrelated).checkpoint, state('unrelated'))
})

test('archive failures roll back the active workspace replacement', () => {
  project('archive-atomic')
  const a = { task: 'A' }, b = { task: 'B' }
  generationCheckpointStore('archive-atomic', a).save(state('A'))
  const previous = one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', 'archive-atomic')
  run("CREATE TRIGGER reject_generation_archive BEFORE INSERT ON script_step_checkpoints WHEN NEW.project_id='archive-atomic' BEGIN SELECT RAISE(ABORT,'archive unavailable'); END")
  try {
    assert.throws(() => generationCheckpointStore('archive-atomic', b).save(state('B')), /archive unavailable/)
    assert.deepEqual(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', 'archive-atomic'), previous)
    assert.equal(one('SELECT * FROM script_step_checkpoints WHERE project_id=?', 'archive-atomic'), undefined)
  } finally { run('DROP TRIGGER reject_generation_archive') }
})

test('malformed history and a mismatched archive cache key cannot be reused', () => {
  project('damaged-history')
  const a = { task: 'A' }, b = { task: 'B' }
  generationCheckpointStore('damaged-history', a).save(state('A'))
  generationCheckpointStore('damaged-history', b).save(state('B'))
  const update = (payload: string, cacheKey = key(a)) => run('UPDATE script_step_checkpoints SET payload=?,cache_key=? WHERE project_id=? AND namespace=?',
    payload, cacheKey, 'damaged-history', history(a))
  for (const damaged of ['invalid', JSON.stringify({ steps: { bad: { input_hash: 5, value: 'damaged' } } }), JSON.stringify({ steps: {}, unexpected: true })]) {
    update(damaged)
    assert.deepEqual(generationCheckpointStore('damaged-history', a).checkpoint, { steps: {} })
  }
  update(JSON.stringify(state('A')), key(b))
  assert.deepEqual(generationCheckpointStore('damaged-history', a).checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('damaged-history', b).checkpoint, state('B'))
})

test('clearing the active task removes its own archived identity while retaining other task histories', () => {
  project('clear-history')
  const a = { task: 'A' }, b = { task: 'B' }
  generationCheckpointStore('clear-history', a).save(state('A'))
  generationCheckpointStore('clear-history', b).save(state('B'))
  const restored = generationCheckpointStore('clear-history', a)
  restored.save(restored.checkpoint)
  clearGenerationCheckpoint('clear-history')
  assert.deepEqual(generationCheckpointStore('clear-history', a).checkpoint, { steps: {} }, 'a saved or discarded active task must not revive its stale archive')
  assert.deepEqual(generationCheckpointStore('clear-history', b).checkpoint, state('B'))
  assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', 'clear-history'), undefined)
  clearGenerationCheckpoint('clear-history')
  assert.deepEqual(generationCheckpointStore('clear-history', b).checkpoint, state('B'), 'clearing with no active task does not erase unrelated history')
  run('DELETE FROM projects WHERE id=?', 'clear-history')
  assert.equal(one('SELECT * FROM script_step_checkpoints WHERE project_id=?', 'clear-history'), undefined)
})

test('reserved and malformed history namespaces cannot overwrite archives or bypass ordinary cleanup', () => {
  project('safe-namespace')
  const a = { task: 'A' }, b = { task: 'B' }
  generationCheckpointStore('safe-namespace', a).save(state('A'))
  generationCheckpointStore('safe-namespace', b).save(state('B'))
  assert.throws(() => generationCheckpointStore('safe-namespace', a, history(a)), /仅供断点归档/)
  for (const namespace of ['generation-history:short', `generation-history:${'G'.repeat(64)}`, `generation-history:${key(a)}extra`]) {
    run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)',
      'safe-namespace', namespace, key(a), JSON.stringify(state('bad')), now())
  }
  clearGenerationCheckpoint('safe-namespace')
  const rows = all<{ namespace: string }>('SELECT namespace FROM script_step_checkpoints WHERE project_id=?', 'safe-namespace')
  assert.deepEqual(rows.map(row => row.namespace), [history(a)])
  assert.deepEqual(generationCheckpointStore('safe-namespace', a).checkpoint, state('A'))
})

test('non-generation namespaces keep their single identity workspace and review cleanup behavior', () => {
  project('other-namespace')
  const a = { task: 'A' }, b = { task: 'B' }
  generationCheckpointStore('other-namespace', a, 'draft-review').save(state('A'))
  generationCheckpointStore('other-namespace', b, 'draft-review').save(state('B'))
  assert.deepEqual(generationCheckpointStore('other-namespace', a, 'draft-review').checkpoint, { steps: {} })
  assert.deepEqual(generationCheckpointStore('other-namespace', a, 'draft-review', [b]).checkpoint, state('B'))
  assert.equal(all('SELECT * FROM script_step_checkpoints WHERE project_id=?', 'other-namespace').length, 1)
  clearGenerationCheckpoint('other-namespace', { keepReview: true })
  assert.deepEqual(generationCheckpointStore('other-namespace', b, 'draft-review').checkpoint, state('B'))
  clearGenerationCheckpoint('other-namespace')
  assert.deepEqual(generationCheckpointStore('other-namespace', b, 'draft-review').checkpoint, { steps: {} })
})
