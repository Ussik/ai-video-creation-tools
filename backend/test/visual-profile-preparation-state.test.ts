import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { after, test } from 'node:test'

const dir = await mkdtemp(join(tmpdir(), 'visual-preparation-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { buildApp } = await import('../src/app.js')
const { db, run, all } = await import('../src/infrastructure/database/db.js')
const { visualProfilePreparationState } = await import('../src/modules/visuals/visual-profile-preparation-state.js')
const { skillContext } = await import('../src/modules/skills/skills.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }) })
const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '匿名技能持久复用回归' } })
assert.equal(response.statusCode, 200)
const input = { projectId: response.json().id, namespace: 'visual-profiles:fixture', source: 'source-v1', task: '只整理当前镜头', model: 'channel-v1' }
const rules = () => ({ ...skillContext('visual_assets', input.task, [], input.projectId, { purpose: 'create' }),
  assignment: { ids: [], source: 'manual' as const, reason: '隔离测试使用基础规则' } })

test('preparation choices survive a fresh process without a provider request', async () => {
  let calls = 0
  await visualProfilePreparationState(input).rules(async () => { calls++; return rules() })
  await visualProfilePreparationState(input).rules(async () => { throw new Error('cached selection must reconstruct locally') })
  assert.equal(calls, 1)
  const module = new URL('../src/modules/visuals/visual-profile-preparation-state.ts', import.meta.url).href
  const dbModule = new URL('../src/infrastructure/database/db.ts', import.meta.url).href
  const source = `const {visualProfilePreparationState}=await import(${JSON.stringify(module)}); const {db}=await import(${JSON.stringify(dbModule)}); const value=await visualProfilePreparationState(${JSON.stringify(input)}).rules(async()=>{throw new Error('no new selection')}); if(value.text!=='')throw new Error('rules changed'); db.close(); console.log('reused');`
  assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: { ...process.env, VIDEO_STUDIO_DATA_DIR: dir }, encoding: 'utf8' }), /reused/)
})

test('preparation binding invalidates source, task, channel, explicit empty/manual choices and registry changes', async () => {
  let calls = 0
  for (const change of [{ source: 'source-v2' }, { task: '另一任务' }, { model: 'channel-v2' }, { selectedIds: [] }]) {
    await visualProfilePreparationState({ ...input, ...change }).rules(async () => { calls++; return rules() })
  }
  assert.equal(calls, 4)
  const before = all('SELECT * FROM skill_stage_defaults WHERE stage=?', 'visual_assets')
  run(`INSERT INTO skill_stage_defaults (stage,primary_id,auxiliary_ids) VALUES ('visual_assets',NULL,'["fixture-revision-change"]')
    ON CONFLICT(stage) DO UPDATE SET auxiliary_ids=excluded.auxiliary_ids`)
  try {
    await visualProfilePreparationState(input).rules(async () => { calls++; return rules() })
    assert.equal(calls, 5)
  } finally {
    if (before[0]) run('UPDATE skill_stage_defaults SET auxiliary_ids=? WHERE stage=?', (before[0] as any).auxiliary_ids, 'visual_assets')
    else run('DELETE FROM skill_stage_defaults WHERE stage=?', 'visual_assets')
  }
})

test('scoped resume requires cached choices and never reselects after a context change', async () => {
  let selected = 0
  const resolve = async () => { selected++; return rules() }
  await visualProfilePreparationState(input).rules(resolve, true)
  assert.equal(selected, 0)
  await assert.rejects(() => visualProfilePreparationState({ ...input, source: 'resume-with-changed-source' }).rules(resolve, true),
    (error: any) => error.code === 'visual_profile_resume_context_missing')
  assert.equal(selected, 0)
})

test('unchanged deterministic history stops before selection; checkpoint or source changes reopen validation', async () => {
  const state = visualProfilePreparationState(input)
  state.rememberFailure(Object.assign(new Error('LOOK 的锁定事实冲突'), { code: 'visual_profile_locked_field_changed', diagnostics: '{"unit":"LOOK"}' }))
  assert.throws(() => visualProfilePreparationState(input).assertUnblocked(), (error: any) => error.code === 'visual_profile_history_action_required' && error.retryable === false && error.recovery.kind === 'review_candidate' && error.diagnostics.includes('LOOK'))
  assert.doesNotThrow(() => visualProfilePreparationState({ ...input, model: 'new-model' }).assertUnblocked())
  const main = generationUnitStore(input.projectId, input.namespace, { fixture: true })
  main.save({ steps: {} })
  assert.doesNotThrow(() => visualProfilePreparationState(input).assertUnblocked())
  // Transient provider failures must not turn into a durable history block.
  const transient = visualProfilePreparationState({ ...input, source: 'transient' })
  transient.rememberFailure(Object.assign(new Error('network'), { code: 'upstream_timeout' }))
  assert.doesNotThrow(() => transient.assertUnblocked())
})
