import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, test } from 'node:test'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'restore-source-analysis-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
process.env.LANGFUSE_TRACING = 'false'
const { buildApp } = await import('../src/app.js')
const { db, one, run } = await import('../src/infrastructure/database/db.js')
const { scriptSourceContext, scriptSourceIndex } = await import('../src/modules/script/script-source-documents.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function post(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function upload(id: string, model: string | undefined, content: string, filename = 'story.md') {
  const boundary = 'restore-source-analysis'
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source${model ? '?model_id=' + model : ''}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function read(id: string) { return (await app.inject({ method: 'GET', url: `/api/projects/${id}/script/source` })).json() }
async function ready(id: string) {
  for (let i = 0; i < 200; i++) {
    const s = await read(id)
    if (s.analysis?.status === 'ready') return s
    if (s.analysis?.status === 'failed') assert.fail(JSON.stringify(s.analysis))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('analysis did not finish')
}

test('upload restores durable analysis, progress and reusable story/settings/index without any quality loop', async t => {
  const project = await post('/api/projects', { name: '原稿资料提取' })
  const provider = await post('/api/providers', { name: 'offline-analysis', base_url: 'https://restore-analysis.invalid/v1' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let release!: () => void, began!: () => void, calls = 0
  const entered = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/restore-analysis\.invalid\//)
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.doesNotMatch(prompt, /【原稿分析核对资料】|【原稿分析修补资料】/, 'analysis must finish without quality review or repair')
    const raw = sourceAnalysisFixture(prompt)
    assert.ok(raw, 'only source-map and story-extraction requests are allowed')
    const value = JSON.parse(raw)
    if (value.sections) { value.sections[0].episode_number = 1; began(); await gate }
    if (value.story) value.story.settings = [{ description: '铜钥匙只能开锁，不能改变记忆。', section_ids: [0] }]
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
  })
  const text = '# 第1集 回家\n林舟回到故乡。铜钥匙只能开锁，不能改变记忆。\n主角最后回家。'
  const uploaded = await upload(project.id, model.id, text)
  assert.ok(uploaded.analysis, 'upload must schedule analysis with the selected model')
  assert.equal(uploaded.analysis.analysis_mode, 'extract')
  await entered
  const running = await read(project.id)
  assert.equal(running.analysis.status, 'running')
  assert.equal(running.analysis.progress.stage, 'reading')
  const sameRunning = await upload(project.id, model.id, text)
  assert.equal(sameRunning.updated_at, uploaded.updated_at)
  assert.equal(sameRunning.analysis.id, uploaded.analysis.id)
  const live = await post(`/api/projects/${project.id}/script/source/analysis`, { model_id: 'another-model', source_updated_at: uploaded.updated_at })
  assert.equal(live.id, uploaded.analysis.id)
  assert.equal(calls, 1)
  release()
  const completed = await ready(project.id)
  assert.equal(calls, 2, 'one map and one synthesis, no quality request')
  assert.equal(completed.analysis.quality, undefined, 'do not fabricate a passed review')
  assert.equal(completed.analysis.story.settings[0].description, '铜钥匙只能开锁，不能改变记忆。')
  assert.equal(completed.analysis.sections[0].episode_number, 1)
  const snapshot = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot)
  assert.deepEqual(snapshot.story, completed.analysis.story)
  const sameReady = await upload(project.id, 'another-model', text, 'renamed.md')
  assert.equal(sameReady.updated_at, uploaded.updated_at)
  assert.equal(sameReady.analysis.id, completed.analysis.id)
  assert.equal(calls, 2, 'same text reupload and model switching reuse completed analysis')
  const retried = await post(`/api/projects/${project.id}/script/source/analysis`, { model_id: 'another-model', source_updated_at: sameReady.updated_at })
  assert.equal(retried.id, completed.analysis.id)
  assert.equal(calls, 2)
  const index = scriptSourceIndex(project.id)!
  assert.equal(index.story_map![0]!.episode_number, 1)
  assert.deepEqual(index.story!.settings, snapshot.story.settings)
  assert.match(scriptSourceContext(project.id), /铜钥匙只能开锁/)
  const scoped = scriptSourceContext(project.id, true, true, true, { stage: 'characters', artifact_types: ['characters'] })
  assert.ok(scoped.includes(JSON.stringify(text)), 'stage context retains the complete original literally')
  assert.match(scoped, /铜钥匙只能开锁/)
  assert.match(scoped, /context_scope/)
  assert.deepEqual(JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot).story, snapshot.story)

  const { sourceEpisodeProductionContext } = await import('../src/modules/script/script-source-production.js')
  assert.match(sourceEpisodeProductionContext(project.id, 1), /saved_story/)
  assert.doesNotMatch(scriptSourceContext(project.id), /quality_findings|quality_summary/)
  const feedback = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source/analysis`, payload: {
    model_id: model.id, source_updated_at: completed.updated_at, review_feedback: '启动审核修补复核' } })
  assert.equal(feedback.statusCode, 409)
  assert.equal(calls, 2)

  // Existing valid extraction remains reusable even if an old independent review failed.
  snapshot.analysis_mode = undefined; snapshot.status = 'failed'; snapshot.phase = 'synthesis'; snapshot.error = '历史审核未通过'
  snapshot.quality = { input_hash: 'history', status: 'issues', findings: [{ kind: 'omission', explanation: '历史意见', unit_ids: [0] }] }
  run('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?', 'failed', JSON.stringify(snapshot), project.id)
  const legacy = await read(project.id)
  assert.equal(legacy.analysis.status, 'ready', 'extraction readiness does not require review approval')
  assert.equal(legacy.analysis.quality.status, 'issues', 'retain historical findings without claiming they passed')
  await post(`/api/projects/${project.id}/script/source/analysis`, { model_id: model.id, source_updated_at: legacy.updated_at })
  assert.equal(calls, 2)
  assert.equal(JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot).error, '历史审核未通过', 'read/reuse never overwrites legacy records')

  // Changed text is a new source, while the old source/results are archived locally.
  const changed = await upload(project.id, undefined, text + '\n新结尾。')
  assert.notEqual(changed.updated_at, completed.updated_at)
  assert.equal(changed.analysis, null)
  const archived = one<{ payload: string }>("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace LIKE 'source-history:%'", project.id)
  assert.ok(archived)
  assert.match(archived.payload, /历史审核未通过/)
  assert.equal(calls, 2)
})

test('long manuscript settings share the existing overview task and persist through partitioned synthesis', async () => {
  const { synthesizeSourceStory, validateSourceStory } = await import('../src/modules/script/script-source-story.js')
  const content = '第1集\n铜钥匙只能开锁。\n' + '原文叙事。'.repeat(7000) + '\n主角最后回家。'
  const state: import('@video-studio/shared/script/script-source-document').ScriptSourceAnalysis = {
    id: 'long-extraction', analysis_mode: 'extract', source_version: 'long-source', model_id: 'offline', status: 'running', phase: 'synthesis',
    total_chunks: 1, completed_chunks: 1, completed_characters: content.length, error: null, updated_at: 'now',
    sections: [{ offset: 0, length: content.length, title: '第1集', episode_number: 1, summary: '主角回家。', characters: [],
      events: [{ summary: '主角最后回家。', evidence: { offset: content.lastIndexOf('主角最后回家。'), quote: '主角最后回家。' } }] }] }
  const tasks: string[] = []
  const story = await synthesizeSourceStory(state, async prompt => {
    const marker = '【全剧整合资料】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    tasks.push(input.part.kind)
    const value = JSON.parse(sourceAnalysisFixture(prompt)!)
    if (input.part.kind === 'overview') {
      assert.match(prompt, /settings/)
      value.settings = [{ description: '铜钥匙只能开锁。', section_ids: [0] }]
    }
    return JSON.stringify(value)
  }, () => {}, new AbortController().signal, undefined, undefined, { filename: 'long.md', content })
  assert.deepEqual(tasks.sort(), ['overview', 'characters', 'timeline', 'threads', 'uncertainties'].sort(), 'no added settings or quality-review request')
  assert.deepEqual(state.story?.settings, story.settings)
  assert.equal(story.settings![0]!.description, '铜钥匙只能开锁。')
  const invalid = structuredClone(story); invalid.settings![0]!.section_ids = [999]
  assert.throws(() => validateSourceStory(state, invalid, { content }), /不存在的章节/)
})

test('an unfinished unknown extraction request cannot be resent by a different model or same-text reupload', async () => {
  const Fastify = (await import('fastify')).default
  const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
  const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
  const project = await post('/api/projects', { name: '未知请求保护' })
  const saved = await upload(project.id, undefined, '第1集\n主角归乡。')
  let calls = 0
  const isolated = Fastify()
  registerScriptSourceRoutes(isolated, { generateText: async () => {
    calls++
    const request_id = 'offline-unknown-request'
    notifyTextRequest('dispatch', { request_id, delivery: 'unknown' })
    notifyTextRequest('metrics', { request_id, upstream_request_id: 'offline-provider', delivery: 'accepted' })
    throw new Error('offline accepted response lost')
  } })
  await isolated.ready()
  try {
    const start = await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source/analysis`, payload: { model_id: 'model-one', source_updated_at: saved.updated_at } })
    assert.equal(start.statusCode, 200)
    let stopped
    for (let i = 0; i < 200; i++) {
      stopped = await read(project.id)
      if (stopped.analysis?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(stopped.analysis.status, 'failed')
    assert.equal(stopped.analysis.resume.action, 'reconcile_request')
    assert.equal(calls, 1)
    const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(project.id)
    const switched = await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source/analysis`, payload: { model_id: 'model-two', source_updated_at: saved.updated_at } })
    assert.equal(switched.statusCode, 409)
    const same = await upload(project.id, 'model-two', saved.content, 'renamed.txt')
    assert.equal(same.updated_at, saved.updated_at)
    assert.equal(same.analysis.id, stopped.analysis.id)
    assert.equal(calls, 1)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(project.id), original)
  } finally { await isolated.close() }
})

test('native schema ignored by a gateway uses zero-request deterministic syntax recovery before saving validated extraction', async t => {
  const { createHash } = await import('node:crypto')
  const project = await post('/api/projects', { name: '原生结构化未执行的离线回归' })
  const provider = await post('/api/providers', { name: 'syntax-native', base_url: 'https://syntax-native.invalid/v1' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'syntax-fixture', remote_id: 'syntax-fixture', modality: 'text',
    protocol: 'anthropic_messages', settings: { text_api: { mode: 'standard', max_output_tokens: 65536 } } })
  let calls = 0, patches = 0, raw = ''
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/syntax-native\.invalid\//)
    calls++
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    assert.equal(body.output_config.format.type, 'json_schema', 'actual request carries native format')
    const prompt = body.messages[0].content as string
    let result: string
    if (body.output_config.format.schema.properties.approve) {
      patches++; assert.fail('deterministic recovery must not ask for approval')
      result = JSON.stringify({ candidate_hash: createHash('sha256').update(raw).digest('hex'), approve: true })
    } else {
      const fixture = sourceAnalysisFixture(prompt); assert.ok(fixture, 'no quality workflow is allowed')
      const value = JSON.parse(fixture)
      if (value.sections) {
        value.sections[0].summary = '计划"回家"，但尚未执行。'
        raw = JSON.stringify(value, null, 2).replace('计划\\"回家\\"', '计划"回家"')
        result = raw
      } else result = fixture
    }
    return Response.json({ type: 'message', id: `msg_offline_${calls}`, content: [{ type: 'text', text: result }], stop_reason: 'end_turn' })
  })
  await upload(project.id, model.id, '# 第1集\n林舟计划回家，但尚未执行。\n主角最后回家。')
  const result = await ready(project.id)
  assert.equal(result.analysis.status, 'ready'); assert.equal(calls, 2); assert.equal(patches, 0)
  const saved = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot)
  assert.equal(saved.syntax_repairs[0].syntax.original_hash, createHash('sha256').update(raw).digest('hex'))
  assert.equal(saved.syntax_repairs[0].syntax.escape_offsets.length, 2)
  assert.equal(saved.syntax_repairs[0].syntax.policy, 'quoted-lines-v2-deterministic')
  assert.equal(saved.syntax_repairs[0].correction_input_hash, undefined)
  assert.equal(result.analysis.syntax_repairs, undefined, 'private syntax evidence does not leak into UI')
  const originals = db.prepare('SELECT result FROM source_model_requests WHERE project_id=? AND run_id=?').all(project.id, saved.id) as Array<{ result: string }>
  assert.ok(originals.some(row => row.result === raw), 'original bytes survive completed analysis')
  const attempts = db.prepare('SELECT metrics FROM model_request_attempts WHERE task_id=? ORDER BY updated_at').all(`source:${saved.id}`) as Array<{ metrics: string }>
  assert.equal(attempts.length, 2)
  assert.equal(JSON.parse(attempts[0]!.metrics).response_json_valid, false, 'HTTP 200 does not imply format was enforced')
  assert.equal(JSON.parse(attempts[1]!.metrics).response_json_valid, true)
  assert.notEqual(JSON.parse(attempts[0]!.metrics).response_text_hash, JSON.parse(attempts[1]!.metrics).response_text_hash)
  const previous = calls
  await upload(project.id, 'different-model', result.content)
  assert.equal(calls, previous, 'completed extraction remains reusable')
})

test('auxiliary knowledge issues retain a valid map and do not trigger another model review, repair or map request', async t => {
  const project = await post('/api/projects', { name: '辅助知识不阻断目录' })
  const provider = await post('/api/providers', { name: 'knowledge-boundary', base_url: 'https://knowledge-boundary.invalid/v1' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'knowledge-fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let calls = 0; let originalClaims: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/knowledge-boundary\.invalid\//)
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const fixture = sourceAnalysisFixture(prompt); assert.ok(fixture, 'only map and story extraction are allowed')
    const value = JSON.parse(fixture)
    if (value.sections) {
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('【原文片段】\n') + '【原文片段】\n'.length))
      const units = packet.passages.flatMap((p: any) => p.units).filter((u: any) => u.text.trim())
      const at = units[0].id, last = units.at(-1).id
      originalClaims = [
        { category: 'world_rule', statement: '规则跨多句，但尚未定位完整成立时点。', kind: 'fact', holder: null, status: 'confirmed', at_unit_id: at, unit_ids: [at, last] },
        { category: 'ending', statement: '主角找到父母遗物。', kind: 'plan', holder: null, status: 'unconfirmed', at_unit_id: last, unit_ids: [last] },
      ]
      value.sections[0].knowledge = originalClaims
    } else {
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('【全剧整合资料】\n') + '【全剧整合资料】\n'.length))
      assert.equal(packet.knowledge.claims.length, 0)
      assert.equal(packet.knowledge.pending.length, 2)
      assert.ok(packet.knowledge.pending.every((p: any) => p.usage === 'not_accepted_do_not_use_as_fact'))
      assert.match(prompt, /作者在分集梗概明确叙述/)
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
  })
  const text = '# 规则\n铜锣需要持印。\n每夜只能一次。\n# 第60集\n主角找到父母遗物。\n主角最后回家。'
  await upload(project.id, model.id, text)
  const completed = await ready(project.id)
  assert.equal(calls, 2, 'knowledge never adds a repair/review round')
  const section = completed.analysis.sections[0]
  assert.deepEqual(section.knowledge, [])
  assert.deepEqual(section.knowledge_pending.map((p: any) => p.candidate), originalClaims)
  assert.ok(section.events.length > 0)
  assert.match(scriptSourceContext(project.id), /not_accepted_do_not_use_as_fact/)
  const index = scriptSourceIndex(project.id)!
  assert.equal(index.knowledge!.claims.length, 0)
  assert.equal(index.knowledge!.pending.length, 2)
  await upload(project.id, 'another-model', text)
  assert.equal(calls, 2, 'unchanged original never reruns for pending knowledge')
  const snapshot = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot)
  assert.deepEqual(snapshot.sections[0].knowledge_pending.map((p: any) => p.candidate), originalClaims)
})

test('explicit continuation reuses the saved valid page with unresolved knowledge instead of requesting the map again', async t => {
  const { createScriptSourceAnalyzer, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
  const { scriptSourcePassages, sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
  const project = await post('/api/projects', { name: '已保存目录本地续接' })
  const text = '# 规则\n铜锣需要持印。\n每夜只能一次。\n主角最后回家。'
  const source = await upload(project.id, undefined, text)
  const units = scriptSourcePassages(text).flatMap(p => p.units).filter(u => u.text.trim())
  const result = { sections: [{ start_unit: 0, title: '规则及结尾', episode_number: null, summary: '规则与结尾。', characters: [],
    events: [{ summary: '主角最后回家。', evidence: { unit_id: units.at(-1)!.id } }], continues_previous: false, open_threads: [],
    knowledge: [{ category: 'world_rule', statement: '铜锣需要持印且每夜一次。', kind: 'fact', holder: null, status: 'confirmed',
      at_unit_id: units[0]!.id, unit_ids: [units[0]!.id, units.at(-1)!.id] }] }] }
  const state = { id: 'saved-knowledge-page', source_version: scriptSourceVersion(source), model_id: 'offline-saved', pipeline_version: sourceAnalysisPipelineVersion,
    status: 'failed', analysis_mode: 'extract', phase: 'reading', completed_chunks: 0, total_chunks: 1, completed_characters: 0, sections: [],
    work: [{ offset: 0, length: text.length, depth: 0, result }], updated_at: 'now', error: 'knowledge.unit_ids晚于本次披露时点' }
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, state.id, state.source_version, state.status, JSON.stringify(state), 'now')
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    calls++
    assert.ok(!prompt.includes('【原文片段】'), 'saved map must not be bought again')
    const fixture = sourceAnalysisFixture(prompt); assert.ok(fixture, 'only remaining synthesis is allowed')
    return fixture
  })
  try {
    analyzer.start(project.id, 'offline-saved', { extractionOnly: true, explicitDispatch: true })
    const completed = await ready(project.id)
    assert.equal(calls, 1, 'only previously unfinished synthesis, never a map or annotation repair')
    assert.equal(completed.analysis.sections.length, 1)
    assert.equal(completed.analysis.sections[0].knowledge_pending.length, 1)
    assert.deepEqual(completed.analysis.sections[0].knowledge_pending[0].candidate, result.sections[0]!.knowledge[0])
  } finally { await analyzer.close() }
})

test('dense manuscript upload bounds output windows and completes without syntax approvals or redundant event repairs', async t => {
  const project = await post('/api/projects', { name: '密集原稿端到端格式回归' })
  const provider = await post('/api/providers', { name: 'dense-recorded-shape', base_url: 'https://dense-source.invalid/v1' })
  const model = await post('/api/models', { provider_id: provider.id, name: 'dense-fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const content = '# 世界规则\n铜锣不能改命。\n' + Array.from({ length: 60 }, (_, index) => `## 第${index + 1}集\n` + '人物找到遗物，但尚不知其来历。'.repeat(10) + '\n').join('') + '主角最后回家。'
  let calls = 0, synthesis = 0
  const windows: Array<{ offset: number; length: number }> = [], rawOutputs: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/dense-source\.invalid\//)
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.ok(!prompt.includes('【冻结引号语法补丁】'), 'fresh syntax must not ask for a vote')
    assert.ok(!prompt.includes('【局部证据修复】'), 'equal event occurrence alias must not buy repair calls')
    const fixture = sourceAnalysisFixture(prompt); assert.ok(fixture, 'only initial map windows and remaining synthesis are allowed')
    const value = JSON.parse(fixture)
    let raw: string
    if (value.sections) {
      const marker = '【原文片段】\n', packet = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.equal(packet.complete_source, false, 'new pages read current and adjacent source')
      assert.ok(content.includes(packet.passages.flatMap((p: any) => p.units.map((u: any) => u.text)).join('')))
      windows.push(packet.output_window)
      value.sections[0].summary = '遇到"乱葬岗站"并听到"笃"，保留否定与前提。'
      for (const event of value.sections[0].events) event.evidence.occurrence_unit_id = event.evidence.unit_id
      raw = '```json\n' + JSON.stringify(value, null, 2).replace('遇到\\"乱葬岗站\\"并听到\\"笃\\"', '遇到"乱葬岗站"并听到"笃"') + '\n```'
      rawOutputs.push(raw)
    } else { synthesis++; raw = fixture }
    return Response.json({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] })
  })
  await upload(project.id, model.id, content)
  const final = await ready(project.id)
  assert.ok(windows.length >= 3)
  assert.ok(windows.every(window => window.length <= 4500))
  assert.equal(windows.map(window => content.slice(window.offset, window.offset + window.length)).join(''), content)
  assert.equal(calls, windows.length + synthesis)
  assert.ok(final.analysis.story); assert.equal(final.analysis.position_index.episodes.length, 60)
  const snapshot = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', project.id)!.snapshot)
  assert.equal(snapshot.map_output_policy, 'dense-v1'); assert.equal(snapshot.syntax_repairs.length, windows.length)
  assert.ok(snapshot.syntax_repairs.every((item: any) => item.syntax.policy === 'quoted-lines-v2-deterministic' && !item.correction_input_hash))
  const rows = db.prepare('SELECT result FROM source_model_requests WHERE project_id=?').all(project.id) as Array<{ result: string }>
  assert.ok(rawOutputs.every(raw => rows.some(row => row.result === raw)))
  const before = calls
  await upload(project.id, 'another-model', content)
  assert.equal(calls, before)
})
