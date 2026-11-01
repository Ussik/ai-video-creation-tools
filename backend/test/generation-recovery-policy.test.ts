import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'generation-recovery-policy-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { all, db, initDb, newId, now, one, required, run } = await import('../src/infrastructure/database/db.js')
const { generationAttempt, generationRecoveryInfo, prepareGenerationExecution, validExternalTaskId } = await import('../src/modules/jobs/job-generation-recovery.js')
type Job = import('../src/infrastructure/database/db.js').Job
type Model = import('../src/infrastructure/database/db.js').Model
type Provider = import('../src/infrastructure/database/db.js').Provider
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
beforeEach(() => { run('DELETE FROM projects'); run('DELETE FROM providers') })

function fixture(modality: 'image' | 'video' | 'text' = 'video', externalId: string | null = 'accepted-task', asyncImage = true) {
  const projectId = newId(), providerId = newId(), modelId = newId(), jobId = newId(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '隔离恢复策略', timestamp, timestamp)
  run(`INSERT INTO providers (id,name,adapter,base_url,auth_header,auth_prefix,key_ciphertext,created_at)
    VALUES (?,?,'http','https://provider.invalid/v1','Authorization','Bearer ',?,?)`, providerId, 'mock', 'key-before-rotation', timestamp)
  const settings = modality === 'video'
    ? { create_path: 'tasks', get_path: 'tasks/{id}', request_template: { prompt: '{{prompt}}', model: '{{model}}' } }
    : { async_image: asyncImage, request_path: 'images', get_path: 'images/tasks/{id}', image_url_path: 'data.0.url', request_template: { prompt: '{{prompt}}' } }
  run('INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings) VALUES (?,?,?,?,?,?,?)',
    modelId, providerId, 'mock', 'remote-before', modality, modality === 'video' ? 'async_video' : modality === 'image' ? 'image_generations' : 'responses', JSON.stringify(settings))
  run(`INSERT INTO jobs (id,project_id,model_id,job_type,request,status,external_id,error,created_at,updated_at)
    VALUES (?,?,?,'generation',?,'failed',?,'mock interrupted',?,?)`, jobId, projectId, modelId, JSON.stringify({ prompt: '冻结的生成正文' }), externalId, timestamp, timestamp)
  return { projectId, providerId, modelId, jobId,
    job: () => required<Job>('jobs', jobId), model: () => required<Model>('models', modelId), provider: () => required<Provider>('providers', providerId),
    prepare() { prepareGenerationExecution(this.job(), this.model(), this.provider()) },
    info() { return generationRecoveryInfo(this.job(), this.model()) } }
}

test('first execution freezes the original image/video modality and immutable model/provider fingerprints', () => {
  for (const modality of ['video', 'image'] as const) {
    const state = fixture(modality)
    assert.equal(generationAttempt(state.jobId), undefined)
    state.prepare()
    const attempt = generationAttempt(state.jobId)!
    assert.equal(attempt.modality, modality)
    assert.match(attempt.model_signature, /^[a-f0-9]{64}$/)
    assert.match(attempt.provider_signature, /^[a-f0-9]{64}$/)
    const snapshot = JSON.stringify(all('SELECT * FROM job_generation_attempts WHERE job_id=?', state.jobId))
    state.prepare()
    assert.equal(JSON.stringify(all('SELECT * FROM job_generation_attempts WHERE job_id=?', state.jobId)), snapshot)
    assert.deepEqual(state.info(), { recovery_available: false, task_resume_available: true, recovery_action: 'query', recovery_modality: modality })
  }
})

test('remote ID, protocol, modality, request settings and model/provider identity drift all block query and execution preparation', () => {
  const changes: Array<{ name: string; apply: (state: ReturnType<typeof fixture>) => void }> = [
    { name: 'remote model ID', apply: state => run('UPDATE models SET remote_id=? WHERE id=?', 'remote-after', state.modelId) },
    { name: 'protocol', apply: state => run('UPDATE models SET protocol=? WHERE id=?', 'responses', state.modelId) },
    { name: 'modality', apply: state => run('UPDATE models SET modality=? WHERE id=?', 'text', state.modelId) },
    { name: 'settings', apply: state => run('UPDATE models SET settings=? WHERE id=?', JSON.stringify({ ...JSON.parse(state.model().settings), get_path: 'other/tasks/{id}' }), state.modelId) },
    { name: 'provider identity', apply: state => {
      const providerId = newId()
      run(`INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://provider.invalid/v1',?)`, providerId, 'same endpoint, distinct provider', now())
      run('UPDATE models SET provider_id=? WHERE id=?', providerId, state.modelId)
    } },
  ]
  for (const change of changes) {
    const state = fixture()
    state.prepare()
    const original = generationAttempt(state.jobId)
    change.apply(state)
    const model = state.model(), provider = required<Provider>('providers', model.provider_id)
    const info = generationRecoveryInfo(state.job(), model)
    assert.equal(info.task_resume_available, false, change.name)
    assert.equal(info.recovery_action, 'verify', change.name)
    assert.equal(info.recovery_modality, 'video', change.name)
    assert.throws(() => prepareGenerationExecution(state.job(), model, provider), /配置已变化/, change.name)
    assert.deepEqual(generationAttempt(state.jobId), original)
  }
  const state = fixture()
  state.prepare()
  assert.throws(() => prepareGenerationExecution(state.job(), { ...state.model(), id: 'another-model' }, state.provider()), /配置已变化/)
})

test('provider endpoint, adapter, auth header and auth prefix drift block existing task queries and preparation', () => {
  const changes = { base_url: 'https://other-provider.invalid/v1', adapter: 'demo', auth_header: 'x-api-key', auth_prefix: 'Token ' }
  for (const [column, value] of Object.entries(changes)) {
    const state = fixture()
    state.prepare()
    const before = generationAttempt(state.jobId)
    run(`UPDATE providers SET ${column}=? WHERE id=?`, value, state.providerId)
    assert.equal(state.info().task_resume_available, false, column)
    assert.equal(state.info().recovery_action, 'verify', column)
    assert.throws(() => state.prepare(), /配置已变化/, column)
    assert.deepEqual(generationAttempt(state.jobId), before)
  }
})

test('API key rotation and display-only edits allow recovery without rewriting the frozen identity', () => {
  const state = fixture()
  state.prepare()
  const snapshot = JSON.stringify(all('SELECT * FROM job_generation_attempts WHERE job_id=?', state.jobId))
  run('UPDATE providers SET key_ciphertext=?,name=?,model_catalog=? WHERE id=?', 'key-after-rotation', '新显示名称', '{"display":"changed"}', state.providerId)
  run('UPDATE models SET name=? WHERE id=?', '新模型显示名称', state.modelId)
  assert.equal(state.info().recovery_action, 'query')
  state.prepare()
  assert.equal(JSON.stringify(all('SELECT * FROM job_generation_attempts WHERE job_id=?', state.jobId)), snapshot)
})

test('equivalent JSON settings with different property order preserve recovery identity', () => {
  const state = fixture()
  state.prepare()
  const settings = JSON.parse(state.model().settings)
  run('UPDATE models SET settings=? WHERE id=?', JSON.stringify({ request_template: { model: '{{model}}', prompt: '{{prompt}}' }, get_path: settings.get_path, create_path: settings.create_path }), state.modelId)
  assert.equal(state.info().recovery_action, 'query')
  assert.doesNotThrow(() => state.prepare())
})

test('legacy known task IDs can establish their first snapshot and subsequent configuration drift is refused', () => {
  for (const modality of ['video', 'image'] as const) {
    const state = fixture(modality)
    assert.equal(generationAttempt(state.jobId), undefined)
    assert.equal(state.info().recovery_action, 'query')
    state.prepare()
    assert.equal(generationAttempt(state.jobId)!.modality, modality)
    run('UPDATE models SET remote_id=? WHERE id=?', 'changed-after-legacy-adoption', state.modelId)
    assert.equal(state.info().recovery_action, 'verify')
    assert.throws(() => state.prepare(), /配置已变化/)
  }
})

test('an attempt without a confirmed task ID authorizes only the first execution and never a second paid attempt', () => {
  for (const modality of ['video', 'image'] as const) {
    const state = fixture(modality, null)
    assert.doesNotThrow(() => state.prepare())
    const snapshot = generationAttempt(state.jobId)
    assert.equal(state.info().recovery_action, 'verify')
    assert.equal(state.info().task_resume_available, false)
    assert.throws(() => state.prepare(), /曾开始执行.*没有可确认的厂商任务编号/)
    assert.deepEqual(generationAttempt(state.jobId), snapshot)
  }
})

test('an old task ID can never execute as a text task, with or without an existing media snapshot', () => {
  for (const frozen of [false, true]) {
    const state = fixture()
    if (frozen) state.prepare()
    run("UPDATE models SET modality='text',protocol='responses' WHERE id=?", state.modelId)
    const before = generationAttempt(state.jobId)
    assert.equal(state.info().task_resume_available, false)
    assert.equal(state.info().recovery_action, 'verify', 'legacy and snapshotted IDs require verification after a modality change')
    assert.throws(() => state.prepare(), /不会重新提交生成/)
    assert.deepEqual(generationAttempt(state.jobId), before)
  }
})

test('invalid task IDs and synchronous-image configuration cannot authorize legacy task recovery', () => {
  for (const value of ['', ' ', '\n\t', 'undefined', 'null']) {
    const state = fixture('video', value)
    assert.equal(validExternalTaskId(value), false)
    assert.equal(state.info().recovery_action, 'verify')
    assert.throws(() => state.prepare(), /编号或查询配置不可用/)
    assert.equal(generationAttempt(state.jobId), undefined)
  }
  const image = fixture('image', 'image-task', false)
  assert.equal(image.info().recovery_action, 'verify')
  assert.throws(() => image.prepare(), /编号或查询配置不可用/)
  assert.equal(generationAttempt(image.jobId), undefined)
})

test('disabled and archived models/providers cannot offer a task query retry', () => {
  for (const [table, column] of [['models', 'enabled'], ['models', 'archived'], ['providers', 'enabled'], ['providers', 'archived']] as const) {
    const state = fixture()
    state.prepare()
    run(`UPDATE ${table} SET ${column}=? WHERE id=?`, column === 'enabled' ? 0 : 1, table === 'models' ? state.modelId : state.providerId)
    assert.equal(state.info().task_resume_available, false, `${table}.${column}`)
    assert.equal(state.info().recovery_action, 'verify', `${table}.${column}`)
  }
})

test('saved result links authorize download without model/provider access and retain original modality', () => {
  for (const modality of ['video', 'image'] as const) {
    const state = fixture(modality)
    state.prepare()
    run(`INSERT INTO job_${modality}_recovery (job_id,result_url_ciphertext,created_at) VALUES (?,?,?)`, state.jobId, 'opaque-ciphertext', now())
    run("UPDATE models SET modality='text',enabled=0,archived=1 WHERE id=?", state.modelId)
    run('UPDATE providers SET enabled=0,archived=1 WHERE id=?', state.providerId)
    assert.deepEqual(state.info(), { recovery_available: true, task_resume_available: false, recovery_action: 'download', recovery_modality: modality })
    run('DELETE FROM models WHERE id=?', state.modelId)
    assert.deepEqual(generationRecoveryInfo(state.job()), { recovery_available: true, task_resume_available: false, recovery_action: 'download', recovery_modality: modality })
  }
})

test('recovery actions are read-only and restricted to failed non-speech generation jobs', () => {
  const state = fixture()
  state.prepare()
  const snapshot = JSON.stringify(all('SELECT * FROM job_generation_attempts'))
  for (const status of ['queued', 'running', 'succeeded'] as const) assert.equal(generationRecoveryInfo({ ...state.job(), status }, state.model()).recovery_action, null)
  assert.equal(generationRecoveryInfo({ ...state.job(), job_type: 'export' }, state.model()).recovery_action, null)
  assert.equal(generationRecoveryInfo({ ...state.job(), request: JSON.stringify({ tts: { take_id: 'speech-take' } }) }, state.model()).recovery_action, null)
  assert.equal(JSON.stringify(all('SELECT * FROM job_generation_attempts')), snapshot)
  assert.equal(one<{ status: string }>('SELECT status FROM jobs WHERE id=?', state.jobId)!.status, 'failed')
})
