import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceStoryReplayVersion } from '../src/modules/script/script-source-story-progress.js'
import { sourceAnalysisPipelineVersion } from '../src/modules/script/script-source-map.js'

const directory = await mkdtemp(join(tmpdir(), 'source-story-progress-routes-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

test('public source routes show truthful saved-story progress and recovery actions without exposing or mutating private responses', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('GET status must not call a provider or tracing endpoint'))
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'isolated story progress' } })).json()
  const content = '甲辰归还信物；是谁修好钟楼，原稿仍未说明。'
  const boundary = 'story-progress-fixture'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const state: ScriptSourceAnalysis = { id: 'failed-progress', source_version: scriptSourceVersion({ filename: 'story.txt', content }), model_id: 'fixture',
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, pipeline_version: sourceAnalysisPipelineVersion,
    error: '保存回答仍需校验', updated_at: 'now', ordinary_story_dispatch: { run_id: 'failed-progress', binding: 'PRIVATE_GRANT', work_hash: 'private-context', protected_task_keys: ['uncertainties:0'], authorized_at: 'now' }, sections: [{ offset: 0, length: content.length, title: '第一章', summary: '甲辰归还信物。',
      characters: [], events: [{ summary: '甲辰归还信物。', evidence: { offset: 0, quote: content } }] }],
    story_work: { input_hash: 'private-context', tasks: [
      ...Array.from({ length: 14 }, (_, i) => ({ key: `completed:${i}`, result: { private: 'PRIVATE_RESULT_BODY' } })),
      { key: 'uncertainties:0', failure: { message: '待校验原回答' }, output_candidate: { context_hash: 'private-zero', checkpoint: {
        input_hash: 'private-input', raw: 'PRIVATE_RAW_RESPONSE', original_raw: 'PRIVATE_ORIGINAL_RESPONSE', correction_started: { input_hash: 'private-correction' },
        correction_request: { base_input_hash: 'private-input', input_hash: 'private-correction', prompt: 'PRIVATE_FROZEN_PROMPT', contract: { name: 'fixture', schema: {} } },
      } } },
      { key: 'uncertainties:2', failure: { message: '待查找已完成回答' }, output_candidate: { context_hash: 'private-two', checkpoint: {} } },
    ] } }
  const save = () => db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(project.id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  const privateRow = () => db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(project.id)
  const ledger = () => ({
    requests: db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(project.id),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(project.id),
  })
  save()
  const emptyLedger = ledger()
  for (const recovered of [false, true]) {
    if (recovered) {
      const [zero, two] = state.story_work!.tasks.slice(14)
      zero!.result = { uncertainties: [{ description: '原稿未说明修钟人。', section_ids: [0] }] }
      two!.output_candidate!.replay_version = sourceStoryReplayVersion
      two!.output_candidate!.checkpoint = { input_hash: 'private-two', raw: 'PRIVATE_INVALID_ORIGINAL',
        correction: { input_hash: 'private-two-correction', raw: 'PRIVATE_INVALID_CORRECTION' } }
      two!.failure = { code: 'model_json_syntax', message: 'JSON 语法错误：位置 78，第 4 行第 50 列' }
      save()
    }
    const before = privateRow()
    for (let attempt = 0; attempt < 2; attempt++) for (const suffix of ['/analysis', '']) {
      const response = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source${suffix}` })
      assert.equal(response.statusCode, 200, response.body)
      const snapshot = suffix ? response.json() : response.json().analysis
      assert.equal(snapshot.story_progress.completed, recovered ? 15 : 14)
      assert.equal(snapshot.story_progress.total, 16)
      assert.deepEqual(snapshot.story_progress.pending.map((item: { key: string }) => item.key), recovered ? ['uncertainties:2'] : ['uncertainties:0', 'uncertainties:2'])
      assert.equal(snapshot.resume.action, recovered ? 'blocked' : 'reconcile_request')
      assert.equal(snapshot.resume.available, false)
      assert.equal(snapshot.story, undefined)
      for (const field of ['story_work', 'story_candidate', 'configuration_hash', 'ordinary_story_dispatch']) assert.equal(field in snapshot, false)
      assert.doesNotMatch(response.body, /PRIVATE_|correction_request|original_raw|context_hash|private-correction/)
      assert.deepEqual(privateRow(), before, 'GET must not apply the local replay to the business checkpoint')
      assert.deepEqual(ledger(), emptyLedger, 'GET must not create, consume, or change a request allowance')
    }
  }
})

test('a saved new-task answer offers local revalidation without exposing inherited correction authority or touching an old sibling permit', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('status checks must not call models'))
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'saved new correction progress' } })).json()
  const content = '同一个人物拥有姓名与别称，原始回答仍需本地校验。', boundary = 'saved-correction-boundary'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const raw = 'PRIVATE_COMPLETE_NEW_INITIAL', prompt = 'PRIVATE_UNUSED_CORRECTION_PROMPT'
  const contract = { name: 'script_source_story_characters_merge', schema: { type: 'object' } }
  const taskKey = 'characters_merge:new', candidate = hash('private-new-candidate'), base = hash('private-initial-input')
  const state: ScriptSourceAnalysis = { id: 'saved-new-current', source_version: scriptSourceVersion({ filename: 'story.txt', content }), model_id: 'fixture',
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, pipeline_version: sourceAnalysisPipelineVersion,
    error: '当前回答已保存，等待本地复核', updated_at: 'now', sections: [{ offset: 0, length: content.length, title: '人物资料',
      episode_number: null, summary: '人物拥有姓名与别称。', characters: [], events: [], open_threads: [] }],
    ordinary_story_dispatch: { run_id: 'saved-new-current', binding: 'PRIVATE_GRANT', work_hash: 'private-work',
      protected_task_keys: [...Array.from({ length: 19 }, (_, i) => `saved:${i}`), taskKey], authorized_at: 'now',
      correction_tasks: [{ task_key: taskKey, candidate_hash: candidate, base_input_hash: base,
        initial_run_id: 'PRIVATE_PRIOR_INITIAL_RUN', initial_response_hash: hash(raw) }] },
    story_work: { input_hash: 'private-work', tasks: [
      ...Array.from({ length: 19 }, (_, i) => ({ key: `saved:${i}`, result: { retained: i } })),
      { key: taskKey, failure: { code: 'source_request_sibling_pending', message: '首次纠正尚未派发' },
        output_candidate: { context_hash: candidate, replay_version: sourceStoryReplayVersion, checkpoint: {
          input_hash: base, raw, original_raw: raw, correction_request: { base_input_hash: base,
            input_hash: hash(JSON.stringify([prompt, contract])), prompt, contract },
        } } },
    ] } }
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(project.id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume','now')`)
    .run('saved-new-action', project.id, 'saved-new-client', state.id)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
    VALUES (?,'private-old-scope','private-old-key','private-old-run','dispatched','unknown',NULL,NULL,'now')`).run(project.id)
  db.prepare(`INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES ('saved-new-epoch','saved-new-action',?,'private-old-scope','private-old-key',?,'prepared','not_sent','now')`).run(project.id, state.id)
  const evidence = () => ({
    analysis: db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(project.id),
    requests: db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(project.id),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(project.id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(project.id),
  })
  const before = evidence()
  for (const suffix of ['/analysis', '']) {
    const response = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source${suffix}` })
    assert.equal(response.statusCode, 200, response.body)
    const current = suffix ? response.json() : response.json().analysis
    assert.equal(current.story_progress.completed, 19)
    assert.equal(current.story_progress.total, 20)
    assert.equal(current.resume.action, 'revalidate')
    assert.equal(current.resume.available, true)
    assert.match(current.resume.message, /先在本地重新校验/)
    assert.match(current.resume.message, /不发送模型请求/)
    assert.doesNotMatch(response.body, /PRIVATE_|correction_tasks|initial_response_hash|correction_request|original_raw/)
    assert.deepEqual(evidence(), before)
  }
})
