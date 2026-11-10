import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import { scriptArtifactTypes, scriptStageForArtifact } from '@video-studio/shared/script/script-stage-content'

const testData = await mkdtemp(join(tmpdir(), 'controlled-storyboard-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { registerStoryboardPlanningRoutes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { registerScriptCanvasRoutes } = await import('../src/modules/canvas/script-canvas-preparation.js')
const { installSkillBundle, configureSkill, removeInstalledSkill } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, 200, response.body); return response.json()
}

async function upstreamPlanning(protocol: 'responses' | 'chat_completions' = 'responses', settings: Record<string, unknown> = {}) {
  const project = await call('POST', '/api/projects', { name: '分镜流式测试' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', duration: 20 })
  const provider = await call('POST', '/api/providers', { name: '流式测试', base_url: 'https://gateway.invalid/v1', api_key: 'storyboard-test-key' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本模型', remote_id: 'gpt-6.1-sol', modality: 'text', protocol,
    settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
      request_template: protocol === 'responses' ? { model: '{{model}}', input: '{{prompt}}' } : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content', ...settings } })
  const context = await call('POST', `/api/projects/${project.id}/script/storyboard/context`, { scene_ids: [scene.id] })
  const draft = { scenes: [{ scene_id: scene.id, scene_duration: 20, shots: [shot(null, 10), shot(null, 10, '反应镜头')] }] }
  return { project, scene, model, context, draft, plan: () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/plan`,
    payload: { signature: context.signature, scene_ids: [scene.id], model_id: model.id, skill_ids: [] } }) }
}

function planningStream(draft: unknown, protocol: 'responses' | 'chat_completions' = 'responses', complete = true) {
  const raw = JSON.stringify(draft), events: unknown[] = []
  for (let offset = 0; offset < raw.length; offset += 53) {
    const text = raw.slice(offset, offset + 53)
    events.push(protocol === 'responses' ? { type: 'response.output_text.delta', delta: text } : { choices: [{ delta: { content: text } }] })
  }
  if (complete) events.push(protocol === 'responses' ? { type: 'response.completed', response: { status: 'completed' } } : { choices: [{ delta: {}, finish_reason: 'stop' }] })
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return }
    const next = Math.min(bytes.length, offset + 23)
    controller.enqueue(bytes.slice(offset, next)); offset = next
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}

test('storyboard planning requests streams and validates the collected result for both text protocols', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    const f = await upstreamPlanning(protocol, { structured_output_mode: 'json_schema' })
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body)), headers = new Headers(init.headers)
      assert.equal(String(url), `https://gateway.invalid/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
      assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.stream, true)
      assert.equal(headers.get('Authorization'), 'Bearer storyboard-test-key')
      assert.match(headers.get('Accept') || '', /text\/event-stream/)
      const format = protocol === 'responses' ? body.text.format : body.response_format.json_schema
      assert.equal(format.name, 'controlled_storyboard'); assert.equal(format.strict, true)
      const scenes = format.schema.properties.scenes
      assert.equal(scenes.minItems, 1); assert.equal(scenes.maxItems, 1)
      assert.deepEqual(scenes.items.properties.scene_id.enum || [scenes.items.properties.scene_id.const], [f.scene.id])
      assert.match(protocol === 'responses' ? body.input : body.messages[0].content, /本次结构化返回契约/)
      return planningStream(f.draft, protocol)
    })
    const response = await f.plan()
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().scenes, [{ ...f.draft.scenes[0], scene_heading: f.scene.heading }])
    assert.equal(calls, 1)
    assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  })
})

test('storyboard planning preserves an explicit non-streaming template and accepts ordinary JSON', async t => {
  const f = await upstreamPlanning('responses', { request_template: { model: '{{model}}', input: '{{prompt}}', stream: false } })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).stream, false)
    return Response.json({ output: [
      { type: 'reasoning', content: [{ type: 'summary_text', text: '这段不是分镜方案正文' }] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(f.draft) }] },
    ] })
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().scenes, [{ ...f.draft.scenes[0], scene_heading: f.scene.heading }])
})

test('storyboard planning rejects a stream without completion even when its JSON is complete and does not retry', async t => {
  const f = await upstreamPlanning()
  let calls = 0
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () => { calls++; return planningStream(f.draft, 'responses', false) })
  const response = await f.plan()
  assert.equal(response.statusCode, 502)
  assert.match(response.json().detail, /连接提前结束/)
  assert.equal(calls, 1)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.equal((await call('POST', `/api/projects/${f.project.id}/script/storyboard/context`, { scene_ids: [f.scene.id] })).signature, f.context.signature)
})

test('storyboard planning still checks timing and requests one correction after a completed stream', async t => {
  const f = await upstreamPlanning()
  const invalid = structuredClone(f.draft); invalid.scenes[0]!.shots[0]!.duration = 9
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.stream, true)
    if (++calls === 2) assert.match(body.input, /一次格式修正[\s\S]*镜头时长总和必须等于本场规划时长/)
    return planningStream(calls === 1 ? invalid : f.draft)
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().scenes, [{ ...f.draft.scenes[0], scene_heading: f.scene.heading }])
  assert.equal(calls, 2)
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('storyboard scope contracts retain only selected internal IDs even with a full episode reference', async t => {
  const f = await upstreamPlanning('chat_completions', { structured_output_mode: 'json_schema' })
  await call('PATCH', `/api/script-scenes/${f.scene.id}`, { heading: 'EP001-SC001 外 · 试灯街 · 夜', episode_number: 1 })
  const other = await call('POST', `/api/projects/${f.project.id}/script/scenes`, { heading: 'EP001-SC002 外 · 照水门 · 夜', duration: 20, episode_number: 1 })
  const unselected = await call('POST', `/api/projects/${f.project.id}/script/scenes`, { heading: 'EP001-SC003 内 · 灯台 · 夜', duration: 20, episode_number: 1 })
  await call('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'episode_script', episode_number: 1,
    title: '第一集正式正文', content: 'EP001-SC001 外 · 试灯街 · 夜\n举灯查验。\nEP001-SC002 外 · 照水门 · 夜\n追查灯印。\nEP001-SC003 内 · 灯台 · 夜\n未选场次仍在完整正文中。', status: 'ready' }] })
  const selectedIds = [f.scene.id, other.id]
  const context = await call('POST', `/api/projects/${f.project.id}/script/storyboard/context`, { scene_ids: selectedIds })
  const before = storyboardFormalState(f.project.id)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const body = JSON.parse(String(init.body)), schema = body.response_format.json_schema.schema.properties.scenes
    assert.equal(schema.minItems, 2); assert.equal(schema.maxItems, 2)
    assert.deepEqual(schema.items.properties.scene_id.enum, selectedIds)
    assert.ok(!schema.items.properties.scene_id.enum.includes(unselected.id))
    const prompt = body.messages[0].content
    assert.match(prompt, /未选场次仍在完整正文中/)
    assert.match(prompt, /scene_id[\s\S]*内部|内部[\s\S]*scene_id/)
    assert.match(prompt, /逐字/)
    const source = JSON.parse(prompt.split('选中场次：')[1].split('\n')[0])
    assert.deepEqual(source.map((scene: { scene_id: string }) => scene.scene_id), selectedIds)
    assert.deepEqual(source.map((scene: { heading: string }) => scene.heading), ['EP001-SC001 外 · 试灯街 · 夜', other.heading])
    return planningStream({ scenes: [...selectedIds].reverse().map(scene_id => ({ scene_id, scene_duration: 20, shots: [shot(null, 20)] })) }, 'chat_completions')
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/plan`, payload: {
    signature: context.signature, scene_ids: selectedIds, model_id: f.model.id, skill_ids: [],
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().scenes.map((scene: { scene_id: string }) => scene.scene_id), selectedIds, 'valid model ordering is mapped by ID without changing scope')
  assert.equal(calls, 1)
  assert.deepEqual(storyboardFormalState(f.project.id), before, 'a validated preview never writes accepted scene, shot or canvas data')
})

function storyboardFormalState(projectId: string) {
  return Object.fromEntries(['script_scenes', 'script_artifacts', 'shots', 'storyboard_designs', 'storyboard_scene_plans', 'shot_plan_requests', 'canvas_nodes', 'visual_profiles']
    .map(table => [table, all(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`, projectId)]))
}

for (const problem of ['readable scene code', 'unselected extra scene', 'missing selected scene', 'duplicate selected scene'] as const) {
  test(`storyboard planning repairs ${problem} against the selected scope without committing`, async t => {
    const f = await upstreamPlanning('responses', { structured_output_mode: 'json_schema' })
    await call('PATCH', `/api/script-scenes/${f.scene.id}`, { heading: 'EP001-SC001 外 · 试灯街 · 夜' })
    const other = await call('POST', `/api/projects/${f.project.id}/script/scenes`, { heading: 'EP001-SC002 外 · 照水门 · 夜', duration: 20 })
    const multiple = problem === 'missing selected scene' || problem === 'duplicate selected scene'
    const selectedIds = multiple ? [f.scene.id, other.id] : [f.scene.id]
    const context = await call('POST', `/api/projects/${f.project.id}/script/storyboard/context`, { scene_ids: selectedIds })
    const before = storyboardFormalState(f.project.id)
    const scene = (scene_id: string) => ({ scene_id, scene_duration: 20, shots: [shot(null, 20)] })
    const invalid = { scenes: problem === 'readable scene code' ? [scene('EP001-SC001')]
      : problem === 'unselected extra scene' ? [scene(f.scene.id), scene(other.id)]
      : problem === 'missing selected scene' ? [scene(f.scene.id)] : [scene(f.scene.id), scene(f.scene.id)] }
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls++
      if (calls === 2) {
        const correction = body.input.split('【一次格式修正】')[1]?.split('【原始任务与资料】')[0]
        assert.ok(correction, 'invalid scene mapping triggers the one correction request')
        assert.match(correction, /scene_id/)
        assert.match(correction, /逐字|内部/)
        for (const id of selectedIds) assert.ok(correction.includes(id), 'correction contains every selected internal scene ID')
        assert.match(correction, /EP001-SC001/)
        if (multiple) assert.match(correction, /EP001-SC002/)
        if (problem === 'duplicate selected scene') assert.match(correction, /重复/)
      }
      return planningStream(calls === 1 ? invalid : { scenes: selectedIds.map(scene) })
    })
    const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/storyboard/plan`, payload: {
      signature: context.signature, scene_ids: selectedIds, model_id: f.model.id, skill_ids: [],
    } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().scenes.map((scene: { scene_id: string }) => scene.scene_id), selectedIds)
    assert.equal(calls, 2)
    assert.deepEqual(storyboardFormalState(f.project.id), before)
  })
}

test('an uncorrected scene alias is rejected after one correction and cannot save a guessed mapping', async t => {
  const f = await upstreamPlanning('responses')
  const before = storyboardFormalState(f.project.id)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return planningStream({ scenes: [{ ...f.draft.scenes[0], scene_id: 'EP001-SC001' }] })
  })
  const response = await f.plan()
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.json().detail, /已修正一次/)
  assert.match(response.json().detail, /scene_id/)
  assert.match(response.json().raw_output, /EP001-SC001/)
  assert.equal(calls, 2)
  assert.deepEqual(storyboardFormalState(f.project.id), before)
})

test('storyboard upstream failures reach the client and diagnostic log without changing project shots', async t => {
  const project = await call('POST', '/api/projects', { name: '分镜网关失败测试' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', duration: 20 })
  const provider = await call('POST', '/api/providers', { name: '网关测试', base_url: 'https://gateway.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本模型', remote_id: 'gpt-6-astra', modality: 'text', protocol: 'responses',
    settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
  const context = await call('POST', `/api/projects/${project.id}/script/storyboard/context`, { scene_ids: [scene.id] })
  const logs: unknown[] = []
  t.mock.method(console, 'error', (...values: unknown[]) => { logs.push(values) })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 502, statusText: 'Bad Gateway', headers: { 'x-request-id': 'storyboard-upstream-502' } }) })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/plan`, payload: {
    signature: context.signature, scene_ids: [scene.id], model_id: model.id,
  } })
  assert.equal(response.statusCode, 502)
  assert.match(response.json().detail, /文本模型生成失败.*模型接口返回 502/)
  assert.match(response.json().detail, /空响应体/)
  assert.match(response.json().detail, /storyboard-upstream-502/)
  assert.match(response.json().diagnostics, /gpt-6-astra/)
  assert.match(JSON.stringify(logs), /storyboard-upstream-502/)
  assert.equal(calls, 2, 'read-only transient upstream errors have one bounded retry')
  assert.equal(all('SELECT id FROM shots WHERE project_id=?', project.id).length, 0)
  assert.equal((await call('POST', `/api/projects/${project.id}/script/storyboard/context`, { scene_ids: [scene.id] })).signature, context.signature)
})

async function setup(t: { after: (fn: () => Promise<unknown>) => void },
  generate: (prompt: string) => Promise<string> = async () => { throw new Error('Unexpected model call') },
  generateVisual: (prompt: string) => Promise<string> = async () => JSON.stringify({ profiles: [] })) {
  const project = await call('POST', '/api/projects', { name: '分镜控制测试', brief: '沿海车站救援' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站场次', duration: 30, dialogue: '快走', episode_number: 1 })
  const other = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '码头场次', duration: 30, action: '隐藏场次动作', episode_number: 2 })
  run('INSERT INTO scripts (project_id, outline, characters, updated_at) VALUES (?, ?, ?, ?)', project.id, '大纲选中内容', '人物未选择内容', now())
  const routes = Fastify(); t.after(() => routes.close()); let calls = 0, visualCalls = 0
  const context = {
    selectSkills: async (_id: string, _model: string, input: import('../src/modules/skills/model-skill-selection.js').CreationSkillSelectionInput) =>
      ({ skill_ids: input.default_ids, reason: '模型根据当前分镜任务选择技能。' }),
    script: (id: string) => ({ ...one<{ outline: string; characters: string }>('SELECT * FROM scripts WHERE project_id=?', id)!, generation_options: {},
      scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', id), artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', id) }),
    scenePrompt: (scene: ScriptScene) => `${scene.heading}\n${scene.action}\n${scene.dialogue}`,
    generateText: async (_id: string, model: string, prompt: string, contract?: import('../src/modules/generation/model-output.js').OutputContract) => {
      assert.equal(model, 'mock-text')
      if (contract?.name === 'visual_profiles') { visualCalls++; return generateVisual(prompt) }
      assert.equal(contract?.name, 'controlled_storyboard'); calls++; return generate(prompt)
    },
  }
  registerStoryboardPlanningRoutes(routes, context)
  registerScriptCanvasRoutes(routes, context)
  const invoke = async (action: string, payload: object, status = 200) => {
    const response = await routes.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/${action}`, payload })
    assert.equal(response.statusCode, status, response.body); return response.json()
  }
  const reference = async (action: string, payload: object, status = 200) => {
    const response = await routes.inject({ method: 'POST', url: `/api/projects/${project.id}/script/canvas/${action}`, payload })
    assert.equal(response.statusCode, status, response.body); return response.json()
  }
  const prepareReferences = async (sceneIds = [scene.id]) => {
    const checked = await reference('check', { scene_ids: sceneIds })
    const prepared = await reference('prepare', { signature: checked.signature, scene_ids: sceneIds, model_id: 'mock-text' })
    return reference('commit', { signature: prepared.signature, scene_ids: sceneIds, profiles: prepared.profiles })
  }
  return { project, scene, other, invoke, reference, prepareReferences,
    context: () => invoke('context', { scene_ids: [scene.id] }), calls: () => calls, visualCalls: () => visualCalls }
}
function shot(shotId: string | null, duration: number, title = '推近镜头') {
  return { shot_id: shotId, title, duration, prompt: '人物沿通道移动', image_prompt: '日漫，人物站在通道左侧，近景', video_prompt: '人物向前移动，镜头跟随', start_state: '在通道左侧', end_state: '走到出口', cut_note: '接前一镜' }
}

test('updating an empty redesigned scene keeps its design instead of returning to legacy references', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] }))
  sceneId = f.scene.id
  const originalContext = await f.context()
  const plan = await f.invoke('plan', { scene_ids: [sceneId], signature: originalContext.signature, model_id: 'mock-text', mode: 'redesign' })
  const redesigned = await f.invoke('commit', { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
    scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) })
  run('DELETE FROM shots WHERE project_id=? AND design_id=?', f.project.id, redesigned.design_id)
  const timestamp = now(), legacyProfile = `legacy-empty-${sceneId}`, currentProfile = `current-empty-${sceneId}`
  for (const [profileId, designId] of [[legacyProfile, null], [currentProfile, redesigned.design_id]]) {
    run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,design_id,created_at,updated_at)
      VALUES (?,?,'character',?,'蓝色外套','正侧背',?,?,?)`, profileId, f.project.id, profileId, designId, timestamp, timestamp)
    run('INSERT INTO scene_visual_bindings VALUES (?,?,1)', sceneId, profileId)
  }
  const context = await f.context()
  const updated = await f.invoke('commit', { signature: context.signature, request_id: crypto.randomUUID(), scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] })
  assert.equal(updated.design_id, redesigned.design_id)
  assert.equal(updated.target_canvas_id, redesigned.target_canvas_id)
  assert.equal(updated.shots[0].design_id, redesigned.design_id)
  assert.deepEqual(all<any>('SELECT profile_id FROM shot_visual_bindings WHERE shot_id=?', updated.shots[0].id).map(binding => binding.profile_id), [currentProfile])
  assert.ok(one('SELECT 1 FROM scene_visual_bindings WHERE scene_id=? AND profile_id=?', sceneId, legacyProfile))
})

test('an independent redesign excludes old shots, preserves their complete history and creates one isolated canvas idempotently', async t => {
  let sceneId = '', oldShotId = '', calls = 0
  const instructions = '重新设计为俯视全景，人物与场景也独立设计'
  const f = await setup(t, async prompt => {
    calls++
    assert.match(prompt, /创建独立新方案/)
    assert.ok(prompt.includes(instructions))
    assert.ok(!prompt.includes(oldShotId), 'old shot IDs must never reach the redesign request')
    assert.doesNotMatch(prompt, /旧镜头专属提示词/)
    assert.match(prompt, /"existing_shots":\[\]/)
    return JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30, '全新俯视镜头')] }] })
  })
  sceneId = f.scene.id
  const before = await f.invoke('context', { scene_ids: [sceneId, f.other.id] })
  const original = await f.invoke('commit', { signature: before.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: sceneId, scene_duration: 30, shots: [{ ...shot(null, 15), prompt: '旧镜头专属提示词' }, shot(null, 15, '旧反应镜头')] },
    { scene_id: f.other.id, scene_duration: 30, shots: [shot(null, 30, '其他场次保留')] },
  ] })
  oldShotId = original.shots[0].id
  const oldOther = original.shots.find((item: any) => item.source_scene_id === f.other.id)
  const profileId = `old-profile-${sceneId}`, assetId = `old-video-${sceneId}`, jobId = `old-job-${sceneId}`, timestamp = now()
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES (?,?,'character','旧人物','蓝色外套','正侧背',?,?)`, profileId, f.project.id, timestamp, timestamp)
  run('INSERT INTO scene_visual_bindings VALUES (?,?,1)', sceneId, profileId)
  run(`INSERT INTO shot_visual_bindings (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements)
    VALUES (?,?,1,1,'character','旧人物','默认','蓝色外套','正侧背')`, oldShotId, profileId)
  run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at)
    VALUES (?,?,?,'video','old.mp4','/tmp/old.mp4','generated',?)`, assetId, f.project.id, oldShotId, timestamp)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, oldShotId)
  run(`INSERT INTO jobs (id,project_id,shot_id,job_type,request,status,result_asset_id,created_at,updated_at)
    VALUES (?,?,?,'generation','{}','succeeded',?,?,?)`, jobId, f.project.id, oldShotId, assetId, timestamp, timestamp)
  run(`INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms,source_duration_ms)
    VALUES (?,?,?,?,0,15000,15000)`, `old-clip-${sceneId}`, f.project.id, oldShotId, assetId)
  const canvases = await call('GET', `/api/projects/${f.project.id}/canvases`), oldCanvas = canvases[0]
  run(`INSERT INTO canvas_nodes (id,project_id,canvas_id,position,type,x,y,width,height,shot_id,asset_id,job_id,prompt,settings)
    VALUES (?,?,?,0,'generation',80,80,320,240,?,?,?,'旧画布提示词','{"modality":"video"}')`,
    `old-node-${sceneId}`, f.project.id, oldCanvas.id, oldShotId, assetId, jobId)
  run('INSERT INTO production_ranges (project_id,start_shot_id,end_shot_id) VALUES (?,?,?)', f.project.id, oldShotId, oldOther.id)
  const historical = {
    shots: all<any>('SELECT * FROM shots WHERE project_id=? AND source_scene_id=? ORDER BY position', f.project.id, sceneId),
    assets: all('SELECT * FROM assets WHERE project_id=?', f.project.id),
    jobs: all('SELECT * FROM jobs WHERE project_id=?', f.project.id),
    clips: all('SELECT * FROM timeline_clips WHERE project_id=?', f.project.id),
    nodes: all('SELECT * FROM canvas_nodes WHERE project_id=?', f.project.id),
    bindings: all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', oldShotId),
    profile: one('SELECT * FROM visual_profiles WHERE id=?', profileId),
  }
  const context = await f.context()
  const plan = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text', mode: 'redesign', instructions })
  assert.equal(plan.mode, 'redesign'); assert.equal(plan.instructions, instructions)
  assert.notEqual(plan.signature, context.signature)
  const request = { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
    scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) }
  const saved = await f.invoke('commit', request)
  assert.equal(saved.design_id, request.request_id)
  assert.ok(saved.target_canvas_id && saved.target_canvas_id !== oldCanvas.id)
  assert.equal(saved.created_shots, 1); assert.deepEqual(saved.updated_shot_ids, [])
  assert.equal(saved.shots.length, 1); assert.ok(!historical.shots.some(shot => shot.id === saved.shots[0].id))
  assert.equal(saved.shots[0].design_id, saved.design_id)
  assert.equal(saved.shots[0].selected_asset_id, null)
  assert.deepEqual(saved.shot_visual_bindings, []); assert.deepEqual(saved.visual_profiles, [])
  const design = one<any>('SELECT * FROM storyboard_designs WHERE id=?', saved.design_id)!
  assert.equal(design.instructions, instructions); assert.deepEqual(JSON.parse(design.scene_ids), [sceneId])
  assert.equal(design.name, '分镜方案 2')
  const oldShots = all<any>('SELECT * FROM shots WHERE project_id=? AND source_scene_id=? AND superseded_by IS NOT NULL ORDER BY position', f.project.id, sceneId)
  assert.deepEqual(oldShots, historical.shots.map(shot => ({ ...shot, superseded_by: saved.design_id })))
  for (const [table, expected] of [['assets', historical.assets], ['jobs', historical.jobs], ['timeline_clips', historical.clips], ['canvas_nodes', historical.nodes]] as const) {
    assert.deepEqual(all(`SELECT * FROM ${table} WHERE project_id=?`, f.project.id), expected, `${table} history remains unchanged`)
  }
  assert.deepEqual(one('SELECT * FROM visual_profiles WHERE id=?', profileId), historical.profile)
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', oldShotId), historical.bindings)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', oldOther.id)!.superseded_by, null)
  assert.deepEqual(one('SELECT * FROM production_ranges WHERE project_id=?', f.project.id), {
    project_id: f.project.id, start_shot_id: saved.shots[0].id, end_shot_id: oldOther.id,
  })
  const oldCut = await call('GET', `/api/projects/${f.project.id}?canvas_id=${oldCanvas.id}`)
  assert.deepEqual(oldCut.production_range, { start_shot_id: oldShotId, end_shot_id: oldOther.id })
  assert.equal(oldCut.timeline_clips[0].shot_id, oldShotId)
  assert.deepEqual(one('SELECT * FROM canvas_production_ranges WHERE canvas_id=?', oldCanvas.id), {
    canvas_id: oldCanvas.id, project_id: f.project.id, start_shot_id: oldShotId, end_shot_id: oldOther.id,
  })
  const next = await f.context()
  assert.deepEqual(next.existing_shots.map((item: any) => item.shot_id), saved.shots.map((item: any) => item.id))
  assert.equal(next.scenes[0].shot_count, 1); assert.equal(next.scenes[0].material_count, 0); assert.equal(next.scenes[0].canvas_shot_count, 0)
  const repeated = await f.invoke('commit', request)
  assert.equal(repeated.replayed, true); assert.equal(repeated.design_id, saved.design_id); assert.equal(repeated.target_canvas_id, saved.target_canvas_id)
  assert.deepEqual(repeated.shots, saved.shots)
  assert.equal(all('SELECT * FROM storyboard_designs WHERE project_id=?', f.project.id).length, 1)
  assert.equal((await call('GET', `/api/projects/${f.project.id}/canvases`)).length, 2)
  assert.equal(calls, 1)
  await f.invoke('commit', { ...request, mode: 'update' }, 409)
  await f.invoke('commit', { ...request, instructions: '改掉要求' }, 409)
  const mixed = await f.invoke('canvas', { scene_ids: [sceneId, f.other.id], mode: 'existing' }, 422)
  assert.match(mixed.message, /不同方案/)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('redesign rejects old shot IDs, stale sources and changed mode or instructions before writing any design', async t => {
  let sceneId = '', outputShotId: string | null = null
  const f = await setup(t, async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(outputShotId, 30)] }] }))
  sceneId = f.scene.id
  const initial = await f.context()
  const old = await f.invoke('commit', { signature: initial.signature, request_id: crypto.randomUUID(), scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] })
  outputShotId = old.shots[0].id
  const context = await f.context(), input = { signature: context.signature, scene_ids: [sceneId], model_id: 'mock-text', mode: 'redesign', instructions: '换一种设计' }
  const invalid = await f.invoke('plan', input, 422)
  assert.match(invalid.message, /不能复用已有镜头/)
  assert.equal(f.calls(), 2)
  outputShotId = null
  const plan = await f.invoke('plan', input)
  const request = { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
    scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) }
  await f.invoke('commit', { ...request, mode: 'update' }, 409)
  await f.invoke('commit', { ...request, instructions: '另一要求' }, 409)
  await f.invoke('commit', { ...request, scenes: [{ ...request.scenes[0], shots: [shot(old.shots[0].id, 30)] }] }, 422)
  run('UPDATE script_scenes SET action=? WHERE id=?', '规划后修改了动作', sceneId)
  await f.invoke('commit', request, 409)
  assert.equal(all('SELECT * FROM storyboard_designs WHERE project_id=?', f.project.id).length, 0)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', old.shots[0].id)!.superseded_by, null)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 1)
})

test('a new redesign can combine selected scenes from different previous designs without modifying unselected history', async t => {
  let scenes: any[] = []
  const f = await setup(t, async () => JSON.stringify({ scenes }))
  const redesign = async (sceneIds: string[]) => {
    const context = await f.invoke('context', { scene_ids: sceneIds })
    scenes = sceneIds.map(scene_id => ({ scene_id, scene_duration: 30, shots: [shot(null, 30)] }))
    const plan = await f.invoke('plan', { scene_ids: sceneIds, signature: context.signature, model_id: 'mock-text', mode: 'redesign' })
    return f.invoke('commit', { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
      scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) })
  }
  const first = await redesign([f.scene.id]), second = await redesign([f.other.id])
  const combined = await redesign([f.scene.id, f.other.id])
  assert.equal(combined.shots.length, 2)
  assert.ok(combined.shots.every((shot: any) => shot.design_id === combined.design_id))
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', first.shots[0].id)!.superseded_by, combined.design_id)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', second.shots[0].id)!.superseded_by, combined.design_id)
  assert.equal(all('SELECT * FROM storyboard_designs WHERE project_id=?', f.project.id).length, 3)
  assert.notEqual(first.target_canvas_id, combined.target_canvas_id)
  assert.notEqual(second.target_canvas_id, combined.target_canvas_id)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('canvas import includes same-design base profiles even without their own shot binding and rejects cross-design ancestry', async t => {
  let sceneId = '', shotId = ''
  const f = await setup(t,
    async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] }),
    async () => JSON.stringify({ profiles: [
      { draft_key: 'base', kind: 'character', name: '林晚', variant: '基础', definition: '基础人物黑发蓝衣', view_requirements: '正侧背',
        scene_ids: [sceneId], shot_usage: [{ shot_id: shotId, usage: 'none' }] },
      { draft_key: 'wet', base_draft_key: 'base', state_delta: '右袖湿润', kind: 'character', name: '林晚', variant: '湿袖', definition: '基础人物右袖湿润', view_requirements: '正侧背与右袖局部',
        scene_ids: [sceneId], shot_usage: [{ shot_id: shotId, usage: 'both' }] },
    ] }))
  sceneId = f.scene.id
  const context = await f.context()
  const plan = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text', mode: 'redesign' })
  const saved = await f.invoke('commit', { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
    scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) })
  shotId = saved.shots[0].id
  const prepared = await f.prepareReferences()
  const child = prepared.visual_profiles.find((profile: any) => profile.base_profile_id), baseId = child.base_profile_id
  run('DELETE FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', shotId, baseId)
  const result = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' })
  assert.deepEqual(new Set(result.visual_profiles.map((profile: any) => profile.id)), new Set([child.id, baseId]))
  assert.ok(result.visual_profiles.every((profile: any) => profile.design_id === saved.design_id))
  assert.deepEqual(result.shot_visual_bindings.map((binding: any) => binding.profile_id), [child.id])
  const timestamp = now(), legacyId = `legacy-base-${sceneId}`
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES (?,?,'character','旧基础人物','旧版','正侧背',?,?)`, legacyId, f.project.id, timestamp, timestamp)
  run('UPDATE visual_profiles SET base_profile_id=? WHERE id=?', legacyId, child.id)
  const invalid = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' }, 422)
  assert.match(invalid.message, /同一设计方案/)
})

test('deleted design canvases cannot silently fall back on import or commit replay', async t => {
  let sceneId = ''
  const f = await setup(t, async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] }))
  sceneId = f.scene.id
  const context = await f.context()
  const plan = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text', mode: 'redesign' })
  const request = { signature: plan.signature, mode: plan.mode, instructions: plan.instructions, request_id: crypto.randomUUID(),
    scenes: plan.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) }
  const saved = await f.invoke('commit', request)
  await f.prepareReferences()
  run('DELETE FROM project_canvases WHERE id=? AND project_id=?', saved.target_canvas_id, f.project.id)
  assert.equal(one<any>('SELECT * FROM storyboard_designs WHERE id=?', saved.design_id)!.canvas_id, null)
  const count = all('SELECT * FROM project_canvases WHERE project_id=?', f.project.id).length
  const missing = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' }, 409)
  assert.match(missing.message, /专属画布已删除/)
  const replay = await f.invoke('commit', request, 409)
  assert.match(replay.message, /专属画布已删除/)
  assert.equal(all('SELECT * FROM project_canvases WHERE project_id=?', f.project.id).length, count)
  assert.equal(all('SELECT * FROM storyboard_designs WHERE project_id=?', f.project.id).length, 1)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 1)
})
test('recycled shots retain replanning history and deleted design canvases recover through one new canvas', async t => {
  for (const recycle of [false, true]) await t.test(recycle ? 'recycled current shots' : 'retained current shots', async t => {
    let sceneId = ''
    const f = await setup(t, async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] }))
    sceneId = f.scene.id
    const initial = await f.context()
    assert.equal(initial.scenes[0].has_previous_plan, false)
    assert.equal(initial.scenes[0].requires_redesign, false)
    const first = await f.invoke('plan', { scene_ids: [sceneId], signature: initial.signature, model_id: 'mock-text', mode: 'redesign' })
    const original = await f.invoke('commit', { signature: first.signature, mode: first.mode, request_id: crypto.randomUUID(),
      scenes: first.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) })
    if (recycle) run('UPDATE shots SET deleted_at=? WHERE id=?', now(), original.shots[0].id)
    const beforeDeletion = await f.context()
    assert.equal(beforeDeletion.scenes[0].has_previous_plan, true)
    assert.equal(beforeDeletion.scenes[0].requires_redesign, false)
    assert.equal(beforeDeletion.scenes[0].shot_count, recycle ? 0 : 1)
    const unselectedBefore = one('SELECT * FROM script_scenes WHERE id=?', f.other.id)
    run('DELETE FROM project_canvases WHERE id=?', original.target_canvas_id)
    const context = await f.context()
    assert.equal(context.scenes[0].has_previous_plan, true)
    assert.equal(context.scenes[0].requires_redesign, true)
    assert.equal(context.existing_shots.length, recycle ? 0 : 1)
    const before = storyboardFormalState(f.project.id), calls = f.calls()
    const rejected = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text', mode: 'update' }, 409)
    assert.match(rejected.message, /重新设计/)
    assert.equal(f.calls(), calls, 'reject a deleted target before invoking the model')
    await f.invoke('commit', { signature: beforeDeletion.signature, mode: 'update', request_id: crypto.randomUUID(),
      scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(recycle ? null : original.shots[0].id, 30)] }] }, 409)
    assert.deepEqual(storyboardFormalState(f.project.id), before, 'a stale update must not partially write shots or designs')
    const fresh = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text', mode: 'redesign' })
    const request = { signature: fresh.signature, mode: fresh.mode, request_id: crypto.randomUUID(),
      scenes: fresh.scenes.map(({ scene_heading: _heading, ...scene }: any) => scene) }
    const saved = await f.invoke('commit', request)
    assert.notEqual(saved.design_id, original.design_id)
    assert.notEqual(saved.target_canvas_id, original.target_canvas_id)
    assert.ok(one('SELECT 1 FROM project_canvases WHERE id=?', saved.target_canvas_id))
    assert.equal(!!one<any>('SELECT deleted_at FROM shots WHERE id=?', original.shots[0].id)!.deleted_at, recycle)
    assert.deepEqual(one('SELECT * FROM script_scenes WHERE id=?', f.other.id), unselectedBefore)
    await f.prepareReferences()
    const imported = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' })
    assert.equal(imported.target_canvas_id, saved.target_canvas_id)
    const replay = await f.invoke('commit', request)
    assert.equal(replay.replayed, true)
    assert.equal(replay.target_canvas_id, saved.target_canvas_id)
    assert.equal(all('SELECT id FROM storyboard_designs WHERE project_id=?', f.project.id).length, 2)
    assert.equal((await f.context()).scenes[0].requires_redesign, false)
  })
})

function skill(name: string, rule: string) {
  const installed = installSkillBundle({ repo: 'qa/storyboard', path: name, name, description: name, license: 'MIT', revision: 'a'.repeat(40),
    tool_requirements: [], suggested_stages: ['storyboard'], url: '', files: [{ path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: 分镜规则\n---\n${rule}` }] })
  configureSkill(installed.id, true, ['storyboard']); return installed.id
}

test('planning accepts one primary and five auxiliaries and forwards every selected rule', async t => {
  let captured = ''
  const f = await setup(t, async prompt => {
    captured = prompt
    return JSON.stringify({ scenes: [{ scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] }] })
  })
  const selected = Array.from({ length: 6 }, (_value, index) => skill(`five-aux-planner-${index}`, `RULE_planner_${index}`))
  t.after(() => { for (const id of selected) removeInstalledSkill(id) })
  const context = await f.context()
  const result = await f.invoke('plan', { signature: context.signature, scene_ids: [f.scene.id], model_id: 'mock-text', skill_ids: selected })
  assert.deepEqual(result.used_skills.map((item: { id: string }) => item.id), selected)
  assert.deepEqual(result.used_skills.map((item: { role: string }) => item.role), ['primary', ...Array(5).fill('auxiliary')])
  for (let index = 0; index < 6; index++) assert.match(captured, new RegExp(`RULE_planner_${index}`))
  assert.equal(f.calls(), 1)
})

test('metadata is read-only and canvas import rejects both missing plans and direct scene conversion', async t => {
  const f = await setup(t), context = await f.context()
  assert.equal(context.scenes[0].duration, 30); assert.equal(context.documents.length, 2); assert.equal(f.calls(), 0)
  assert.equal(context.scenes[0].planned, false); assert.deepEqual(context.existing_shots, [])
  assert.deepEqual(context.reference_preparation.needs_analysis, [f.scene.id])
  assert.equal(context.reference_preparation.skill_policy.stage, 'visual_assets')
  assert.equal(f.visualCalls(), 0)
  await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' }, 422)
  await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'scene' }, 422)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.equal(f.calls(), 0); assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
})

test('planning versions follow creative project inputs without false conflicts from preparation timestamps', async t => {
  const f = await setup(t), before = await f.context()
  run('UPDATE projects SET updated_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', f.project.id)
  assert.equal((await f.context()).signature, before.signature)
  run('UPDATE projects SET brief=? WHERE id=?', '改为列车内救援', f.project.id)
  assert.notEqual((await f.context()).signature, before.signature)
  assert.equal(f.calls(), 0); assert.equal(f.visualCalls(), 0)
})

test('patching one scene field keeps its episode, timing and other creative source fields', async t => {
  const f = await setup(t)
  run('UPDATE script_scenes SET location=?, time_of_day=?, characters=?, narration=? WHERE id=?',
    '地下站台', '夜', '林晚、站长', '远处传来列车声', f.scene.id)
  const patched = await call('PATCH', `/api/script-scenes/${f.scene.id}`, { action: '林晚拉住站长，避开坍塌的横梁。' })
  assert.equal(patched.action, '林晚拉住站长，避开坍塌的横梁。')
  assert.equal(patched.episode_number, 1)
  assert.equal(patched.duration, 30)
  assert.equal(patched.location, '地下站台')
  assert.equal(patched.time_of_day, '夜')
  assert.equal(patched.characters, '林晚、站长')
  assert.equal(patched.dialogue, '快走')
  assert.equal(patched.narration, '远处传来列车声')
})

test('planning always reads the selected episodes latest saved body, even without selected reference documents', async t => {
  let sceneId = ''
  const f = await setup(t, async prompt => {
    assert.match(prompt, /最新正式正文/)
    assert.match(prompt, /EPISODE_ONE_CURRENT_BODY/)
    assert.doesNotMatch(prompt, /EPISODE_TWO_UNRELATED_BODY|人物未选择内容/)
    return JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] }] })
  })
  sceneId = f.scene.id
  await call('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集正文', content: 'EPISODE_ONE_OLD_BODY' },
    { artifact_type: 'episode_script', episode_number: 2, title: '第二集正文', content: 'EPISODE_TWO_UNRELATED_BODY' },
  ] })
  const body = one<{ id: string }>("SELECT id FROM script_artifacts WHERE project_id=? AND artifact_type='episode_script' AND episode_number=1", f.project.id)!
  const edited = await call('PATCH', `/api/script-artifacts/${body.id}`, { content: 'EPISODE_ONE_CURRENT_BODY' })
  assert.equal(edited.episode_number, 1, 'editing body must keep the episode association')
  const context = await f.context()
  assert.deepEqual(context.default_document_ids, [body.id])
  const planned = await f.invoke('plan', { signature: context.signature, scene_ids: [sceneId], model_id: 'mock-text', document_ids: [] })
  assert.deepEqual(planned.source_documents.map((document: { id: string }) => document.id), [body.id])
  assert.equal(f.calls(), 1)
})

test('saved source fingerprints ignore timestamps, canvas deletion and unrelated episodes but reject changed episode body', async t => {
  const f = await setup(t)
  await call('PUT', `/api/projects/${f.project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集', content: '林晚在车站救援。' },
    { artifact_type: 'episode_script', episode_number: 2, title: '第二集', content: '其他集原文。' },
  ] })
  const first = await f.context()
  await f.invoke('commit', { signature: first.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] },
  ] })
  const baseline = one<{ source_fingerprint: string }>('SELECT * FROM storyboard_scene_plans WHERE scene_id=? AND project_id=?', f.scene.id, f.project.id)!
  assert.match(baseline.source_fingerprint, /^[a-f0-9]{64}$/)
  run('UPDATE projects SET updated_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', f.project.id)
  run('UPDATE script_scenes SET updated_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', f.scene.id)
  run('UPDATE script_artifacts SET updated_at=? WHERE project_id=?', '2099-01-01T00:00:00.000Z', f.project.id)
  run("UPDATE script_artifacts SET content='其他集修改，与第一集无关。' WHERE project_id=? AND episode_number=2", f.project.id)
  run('DELETE FROM canvas_nodes WHERE project_id=?', f.project.id)
  const unchanged = await f.context()
  assert.equal(unchanged.scenes[0].planned, true)
  assert.equal(unchanged.scenes[0].needs_replan, false)
  run("UPDATE script_artifacts SET content='第一集改为林晚在车站追踪失踪者。' WHERE project_id=? AND episode_number=1", f.project.id)
  const changed = await f.context()
  assert.equal(changed.scenes[0].planned, false)
  assert.equal(changed.scenes[0].needs_replan, true)
  assert.match(changed.scenes[0].replan_reason, /已更新/)
  assert.match((await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' }, 422)).message, /重新规划/)
  assert.equal(one<{ source_fingerprint: string }>('SELECT * FROM storyboard_scene_plans WHERE scene_id=?', f.scene.id)!.source_fingerprint, baseline.source_fingerprint)
})

test('scene, shared documents and project style changes each make a confirmed plan require replanning', async t => {
  for (const kind of ['scene', 'document', 'style'] as const) await t.test(kind, async t => {
    const f = await setup(t), initial = await f.context()
    await f.invoke('commit', { signature: initial.signature, request_id: crypto.randomUUID(), scenes: [
      { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] },
    ] })
    if (kind === 'scene') run('UPDATE script_scenes SET action=? WHERE id=?', '新的救援动作', f.scene.id)
    else if (kind === 'document') run('UPDATE scripts SET characters=? WHERE project_id=?', '人物已改为银色长发', f.project.id)
    else run('UPDATE scripts SET generation_options=? WHERE project_id=?', JSON.stringify({ visual_style: '水彩动画' }), f.project.id)
    const changed = await f.context()
    assert.equal(changed.scenes[0].planned, false)
    assert.equal(changed.scenes[0].needs_replan, true)
  })
})

test('unchanged current plans keep selected media; stale sources reset it even when new shot wording is identical, once', async t => {
  const f = await setup(t), initial = await f.context()
  const saved = await f.invoke('commit', { signature: initial.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] },
  ] })
  const shotId = saved.shots[0].id, assetId = `freshness-${shotId}`
  assert.equal(saved.shots[0].storyboard_revision, 0)
  run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,'image','frame.png','/tmp/frame.png','upload',?)",
    assetId, f.project.id, shotId, now())
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, shotId)
  const current = await f.context()
  const same = await f.invoke('commit', { signature: current.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(shotId, 30)] },
  ] })
  assert.equal(same.shots[0].selected_asset_id, assetId)
  assert.equal(same.shots[0].storyboard_revision, 0)
  run('UPDATE script_scenes SET dialogue=? WHERE id=?', '本场改为另一个救援目标', f.scene.id)
  const changed = await f.context(), submission = { signature: changed.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(shotId, 30)] },
  ] }
  const reset = await f.invoke('commit', submission)
  assert.equal(reset.shots[0].selected_asset_id, null)
  assert.equal(reset.shots[0].storyboard_revision, 1)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?', assetId))
  assert.equal((await f.context()).scenes[0].planned, true)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, shotId)
  const replayed = await f.invoke('commit', submission)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.shots[0].storyboard_revision, 1)
  assert.equal(replayed.shots[0].selected_asset_id, assetId, 'a replay cannot clear media selected after the successful commit')
})

test('a changed replan refreshes image and video nodes across canvases while preserving independent nodes and media history', async t => {
  const f = await setup(t), initial = await f.context()
  const saved = await f.invoke('commit', { signature: initial.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] },
  ] })
  const shotId = saved.shots[0].id
  const other = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '无关镜头', source_scene_id: f.other.id })
  const imageId = `old-image-${shotId}`, videoId = `old-video-${shotId}`, otherAssetId = `unrelated-${shotId}`
  const imageJobId = `image-job-${shotId}`, videoJobId = `video-job-${shotId}`
  const providerId = `provider-${shotId}`, videoModelId = `video-model-${shotId}`
  run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://example.invalid',?)", providerId, '回归模型', now())
  run("INSERT INTO models (id,provider_id,name,remote_id,modality) VALUES (?,?,?,?,'video')", videoModelId, providerId, '视频模型', 'video-test')
  for (const [id, sourceShot, kind] of [[imageId, shotId, 'image'], [videoId, shotId, 'video'], [otherAssetId, other.id, 'image']]) {
    run('INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, f.project.id, sourceShot, kind, `${id}.png`, '/tmp/history.png', 'generated', now())
  }
  for (const [jobId, assetId] of [[imageJobId, imageId], [videoJobId, videoId]]) {
    run(`INSERT INTO jobs (id,project_id,shot_id,job_type,request,status,result_asset_id,created_at,updated_at)
      VALUES (?,?,?,'generation','{}','succeeded',?,?,?)`, jobId, f.project.id, shotId, assetId, now(), now())
  }
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', videoId, shotId)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', otherAssetId, other.id)
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms) VALUES (?,?,?,?,0,5000)',
    `old-clip-${shotId}`, f.project.id, shotId, videoId)
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms) VALUES (?,?,?,?,0,5000)',
    `other-clip-${shotId}`, f.project.id, other.id, otherAssetId)
  const defaultGraph = await call('GET', `/api/projects/${f.project.id}/canvas`)
  const second = await call('POST', `/api/projects/${f.project.id}/canvases`, {})
  const graphPaths = [`/api/projects/${f.project.id}/canvas`, `/api/projects/${f.project.id}/canvases/${second.id}`]
  const before = []
  for (const [index, path] of graphPaths.entries()) {
    const key = `c${index}`
    const generationNode = (modality: 'image' | 'video') => ({ id: `${key}-${modality}`, type: 'generation', shot_id: shotId,
      x: index * 1000, y: modality === 'image' ? 80 : 600, width: 440, height: 420,
      title: '旧标题', prompt: '旧提示词', text: '已整理旧提示词', asset_id: modality === 'image' ? imageId : videoId,
      job_id: modality === 'image' ? imageJobId : videoJobId,
      model_id: modality === 'video' ? videoModelId : null,
      // Legacy snapshots may retain image settings after switching to a video model.
      settings: { modality: 'image', mode: 'reference', duration: 30, ratio: '16:9', resolution: '1080p',
        storyboard_revision: 0, prompt_override: true, prompt_is_final: true, prompt_base: '旧原始提示词', prompt_template: '旧模板',
        generation_completed_job_id: modality === 'image' ? imageJobId : videoJobId,
        storyboard_reference_asset_id: imageId, reference_video_url: 'https://example.invalid/old.mp4',
        video_reference_usages: [{ asset_id: imageId, usage: 'composition' }], group_id: shotId, group_title: '旧镜头分组' } })
    const current = index === 0 ? defaultGraph : await call('GET', path)
    before.push(await call('PUT', path, { revision: current.revision, nodes: [
      generationNode('image'), generationNode('video'),
      { id: `${key}-history`, type: 'image', shot_id: shotId, asset_id: imageId, x: 100, y: 1200, width: 400, height: 272, title: '独立历史图片' },
      { id: `${key}-other`, type: 'generation', shot_id: other.id, asset_id: otherAssetId, x: 600, y: 1200, width: 440, height: 420,
        title: '无关生成节点', prompt: '独立提示词', settings: { modality: 'image', storyboard_revision: 0, prompt_override: true } },
    ], edges: [{ id: `${key}-old-reference`, source: `${key}-history`, target: `${key}-video`, reference_asset_id: imageId }] }))
  }
  const current = await f.context()
  const result = await f.invoke('commit', { signature: current.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 20, shots: [{ ...shot(shotId, 20, '全新镜头标题'),
      prompt: 'NEW_STORY', image_prompt: 'NEW_IMAGE_COMPOSITION', video_prompt: 'NEW_VIDEO_ACTION' }] },
  ] })
  assert.equal(result.shots[0].selected_asset_id, null)
  assert.equal(result.shots[0].storyboard_revision, 1)
  for (const [index, path] of graphPaths.entries()) {
    const refreshed = await call('GET', path), key = `c${index}`
    for (const modality of ['image', 'video']) {
      const node = refreshed.nodes.find((node: { id: string }) => node.id === `${key}-${modality}`)
      const previous = before[index].nodes.find((item: { id: string }) => item.id === node.id)
      assert.equal(node.title, '全新镜头标题')
      assert.equal(node.prompt, modality === 'image' ? 'NEW_IMAGE_COMPOSITION' : 'NEW_VIDEO_ACTION')
      assert.equal(node.text, ''); assert.equal(node.asset_id, null); assert.equal(node.job_id, null)
      assert.equal(node.settings.storyboard_revision, 1); assert.equal(node.settings.duration, 20)
      assert.equal(node.settings.modality, modality)
      assert.equal(node.settings.resolution, '1080p')
      assert.deepEqual([node.x, node.y, node.width, node.height], [previous.x, previous.y, previous.width, previous.height])
      for (const field of ['prompt_override', 'prompt_is_final', 'prompt_base', 'prompt_template', 'generation_completed_job_id',
        'storyboard_reference_asset_id', 'reference_video_url']) assert.equal(node.settings[field], undefined, field)
      assert.deepEqual(node.settings.video_reference_usages, [])
    }
    for (const id of [`${key}-history`, `${key}-other`]) assert.deepEqual(
      refreshed.nodes.find((node: { id: string }) => node.id === id), before[index].nodes.find((node: { id: string }) => node.id === id))
    assert.deepEqual(refreshed.edges, [])
  }
  assert.equal(one('SELECT 1 FROM timeline_clips WHERE shot_id=?', shotId), undefined)
  assert.ok(one('SELECT 1 FROM timeline_clips WHERE shot_id=?', other.id))
  assert.equal(one<{ selected_asset_id: string }>('SELECT selected_asset_id FROM shots WHERE id=?', other.id)!.selected_asset_id, otherAssetId)
  assert.equal(all('SELECT 1 FROM assets WHERE project_id=?', f.project.id).length, 3)
  assert.equal(all('SELECT 1 FROM jobs WHERE project_id=?', f.project.id).length, 2)
})

test('historical templates and authored shots need a confirmed source baseline before reuse', async t => {
  const f = await setup(t)
  const legacy = await call('POST', `/api/projects/${f.project.id}/script/convert-to-shots`, { scene_ids: [f.scene.id] })
  assert.equal((await f.context()).scenes[0].planned, false)
  await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' }, 422)
  await call('PATCH', `/api/script-scenes/${f.scene.id}`, { action: '修改剧本后仍未拆镜' })
  assert.equal((await f.context()).scenes[0].planned, false)
  const value = shot(legacy.shots[0].id, 30)
  run('UPDATE shots SET prompt=?, image_prompt=?, video_prompt=?, start_state=?, end_state=?, cut_note=? WHERE id=?',
    value.prompt, value.image_prompt, value.video_prompt, value.start_state, value.end_state, value.cut_note, legacy.shots[0].id)
  const context = await f.context()
  assert.equal(context.scenes[0].planned, false)
  assert.equal(context.scenes[0].needs_replan, true)
  assert.match(context.scenes[0].replan_reason, /缺少来源版本/)
  assert.deepEqual(context.existing_shots, [{ ...value, scene_id: f.scene.id, title: '车站场次' }])
  await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' }, 422)
  await f.invoke('commit', { signature: context.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [{ ...value, title: '车站场次' }] },
  ] })
  assert.equal((await f.context()).scenes[0].planned, true)
  await f.prepareReferences()
  const first = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  const second = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  assert.equal(first.created_shots, 0); assert.deepEqual(second.shots, first.shots)
  assert.equal(f.calls(), 0)
})

test('mixed selections require a saved plan for every scene and reuse the existing scene unchanged', async t => {
  const f = await setup(t), context = await f.context()
  const first = await f.invoke('commit', { signature: context.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 12), shot(null, 18)] },
  ] })
  const mixed = await f.invoke('context', { scene_ids: [f.scene.id, f.other.id] })
  assert.deepEqual(mixed.scenes.map((scene: { planned: boolean }) => scene.planned), [true, false])
  assert.equal(mixed.existing_shots.length, 2)
  await f.invoke('canvas', { scene_ids: [f.scene.id, f.other.id], mode: 'existing' }, 422)
  const secondContext = await f.invoke('context', { scene_ids: [f.other.id] })
  await f.invoke('commit', { signature: secondContext.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.other.id, scene_duration: 30, shots: [shot(null, 30)] },
  ] })
  await f.prepareReferences([f.scene.id, f.other.id])
  const imported = await f.invoke('canvas', { scene_ids: [f.scene.id, f.other.id], mode: 'existing' })
  assert.equal(imported.shots.length, 3); assert.equal(imported.created_shots, 0)
  assert.deepEqual(imported.shots.slice(0, 2), first.shots)
  assert.equal(f.calls(), 0)
})

test('deleted storyboard image nodes can be reimported with the same plan, assets and bindings', async t => {
  const f = await setup(t), timestamp = now(), profileId = 'profile-' + f.project.id
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES (?,?,'character','林晚','日漫蓝色夹克','正侧背三视图',?,?)`, profileId, f.project.id, timestamp, timestamp)
  run('INSERT INTO scene_visual_bindings VALUES (?,?,0)', f.scene.id, profileId)
  const before = await f.context()
  assert.equal(before.scenes[0].canvas_shot_count, 0)
  const saved = await f.invoke('commit', { signature: before.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 12), shot(null, 18)] },
  ] })
  const [firstShot, secondShot] = saved.shots, assetId = 'image-' + firstShot.id
  run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at)
    VALUES (?,?,?,'image','frame.png','/tmp/frame.png','generated',?)`, assetId, f.project.id, firstShot.id, timestamp)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, firstShot.id)
  await f.prepareReferences()
  const initial = await f.context(), imported = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  assert.equal(initial.scenes[0].planned, true)
  assert.equal(initial.scenes[0].canvas_shot_count, 0)
  assert.equal(imported.shots[0].selected_asset_id, assetId)
  assert.equal(imported.shot_visual_bindings.length, 2)
  const providerId = 'provider-' + f.project.id, imageModelId = 'image-model-' + f.project.id, videoModelId = 'video-model-' + f.project.id
  run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://example.invalid',?)", providerId, '画布计数模型', timestamp)
  for (const [modelId, modality] of [[imageModelId, 'image'], [videoModelId, 'video']]) {
    run('INSERT INTO models (id,provider_id,name,remote_id,modality) VALUES (?,?,?,?,?)', modelId, providerId, modelId, modelId, modality)
  }
  const node = (id: string, shotId: string, extra: object = {}) => ({ id, type: 'generation', x: 0, y: 0, width: 440, height: 420, shot_id: shotId, ...extra })
  const nodes = [
    node('image-primary', firstShot.id, { model_id: imageModelId, settings: { modality: 'video' }, asset_id: assetId }),
    node('image-duplicate', firstShot.id, { settings: { modality: 'image' } }),
    node('legacy-image', secondShot.id),
    node('video-model', secondShot.id, { model_id: videoModelId, settings: { modality: 'image' } }),
    node('video-settings', secondShot.id, { settings: { modality: 'video' } }),
    node('asset-only', secondShot.id, { type: 'image' }),
  ]
  let graph = await call('GET', `/api/projects/${f.project.id}/canvas`)
  const persist = async (retained: typeof nodes) => {
    graph = await call('PUT', `/api/projects/${f.project.id}/canvas`, { revision: graph.revision, nodes: retained, edges: [] })
  }
  const assertCoverage = async (expected: number) => {
    const value = await f.context()
    assert.equal(value.scenes[0].planned, true)
    assert.equal(value.scenes[0].shot_count, 2)
    assert.equal(value.scenes[0].canvas_shot_count, expected)
    assert.equal(value.signature, initial.signature, 'canvas presence must not invalidate a creative plan')
    assert.deepEqual(value.existing_shots, initial.existing_shots)
  }
  await persist(nodes)
  await assertCoverage(2)
  await persist(nodes.filter(node => node.id !== 'image-primary'))
  await assertCoverage(2)
  await persist(nodes.filter(node => !['image-primary', 'image-duplicate'].includes(node.id)))
  await assertCoverage(1)
  await persist(nodes.filter(node => ['video-model', 'video-settings', 'asset-only'].includes(node.id)))
  await assertCoverage(0)
  const partial = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  assert.deepEqual(partial, imported)
  await persist([])
  await assertCoverage(0)
  const restored = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  assert.deepEqual(restored, imported)
  assert.deepEqual(restored.shots.map((value: { id: string }) => value.id), saved.shots.map((value: { id: string }) => value.id))
  assert.equal(restored.created_shots, 0)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 2)
  assert.equal(f.calls(), 0)
  assert.equal(f.visualCalls(), 1, 'reimport must reuse prepared references without another model call')
})

test('planning rejects more than ten scenes before invoking the model while metadata accepts the full scope', async t => {
  const f = await setup(t)
  const sceneIds = [f.scene.id, f.other.id]
  for (let index = 0; index < 9; index++) {
    const scene = await call('POST', `/api/projects/${f.project.id}/script/scenes`, { heading: `后续场次 ${index}`, duration: 20 })
    sceneIds.push(scene.id)
  }
  const context = await f.invoke('context', { scene_ids: sceneIds })
  assert.equal(context.scenes.length, 11)
  await f.invoke('plan', { signature: context.signature, scene_ids: sceneIds, model_id: 'mock-text' }, 422)
  assert.equal(f.calls(), 0); assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('planning submits only selected documents, skills and scenes, supports no skills and stays read-only', async t => {
  const selected = skill('selected', 'SELECTED_SKILL_MARKER'), ignored = skill('ignored', 'IGNORED_SKILL_MARKER')
  t.after(async () => { removeInstalledSkill(selected); removeInstalledSkill(ignored) })
  let sceneId = '', selectedRules = true
  const f = await setup(t, async prompt => {
    assert.match(prompt, /大纲选中内容/); assert.doesNotMatch(prompt, /人物未选择内容|隐藏场次动作|IGNORED_SKILL_MARKER/)
    if (selectedRules) assert.match(prompt, /SELECTED_SKILL_MARKER/); else assert.doesNotMatch(prompt, /SELECTED_SKILL_MARKER/)
    return JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 12), shot(null, 18, '反应镜头')] }] })
  })
  sceneId = f.scene.id
  const context = await f.context(), input = { signature: context.signature, scene_ids: [sceneId], document_ids: ['legacy:outline'], skill_ids: [selected], model_id: 'mock-text' }
  const result = await f.invoke('plan', input)
  assert.deepEqual(result.used_skills.map((s: { id: string }) => s.id), [selected])
  assert.deepEqual(result.source_documents.map((d: { id: string }) => d.id), ['legacy:outline'])
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.deepEqual(context.default_skill_ids, [selected])
  assert.equal(context.skill_policy.source, 'global')
  const { skill_ids: _selectedIds, ...inherited } = input
  const automatic = await f.invoke('plan', inherited)
  assert.deepEqual(automatic.used_skills.map((item: { id: string }) => item.id), [selected])
  assert.deepEqual(automatic.skill_assignment, { ids: [selected], source: 'automatic', reason: '模型根据当前分镜任务选择技能。' })
  selectedRules = false
  assert.deepEqual((await f.invoke('plan', { ...input, skill_ids: [] })).used_skills, [])
  await f.invoke('plan', { ...input, document_ids: ['foreign'] }, 422)
  await f.invoke('plan', { ...input, skill_ids: ['foreign'] }, 422)
  assert.equal(f.calls(), 3)
})

test('an omitted or null shot count lets the model choose different counts for each scene without a default', async t => {
  const selected = skill('auto-count', 'AUTO_COUNT_SKILL_MARKER')
  t.after(async () => { removeInstalledSkill(selected) })
  let sceneId = '', otherId = ''
  const f = await setup(t, async prompt => {
    assert.match(prompt, /AUTO_COUNT_SKILL_MARKER/)
    assert.match(prompt, /创作者未指定镜头数/)
    assert.match(prompt, /独立分析并决定该场的合理镜头数/)
    assert.match(prompt, /场次时长/)
    assert.doesNotMatch(prompt, /每场建议 \d+ 个镜头/)
    return JSON.stringify({ scenes: [
      { scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] },
      { scene_id: otherId, scene_duration: 30, shots: Array.from({ length: 9 }, (_, index) => shot(null, index === 8 ? 6 : 3, `动作节拍${index + 1}`)) },
    ] })
  })
  sceneId = f.scene.id; otherId = f.other.id
  const context = await f.invoke('context', { scene_ids: [sceneId, otherId] })
  const input = { signature: context.signature, scene_ids: [sceneId, otherId], model_id: 'mock-text', skill_ids: [selected] }
  for (const payload of [input, { ...input, shots_per_scene: null }]) {
    const result = await f.invoke('plan', payload)
    assert.deepEqual(result.scenes.map((scene: { shots: unknown[] }) => scene.shots.length), [1, 9])
    assert.deepEqual(result.used_skills.map((skill: { id: string }) => skill.id), [selected])
  }
  assert.equal(f.calls(), 2)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('an explicit shot count remains a suggestion and does not force the output count', async t => {
  let sceneId = ''
  const f = await setup(t, async prompt => {
    assert.match(prompt, /每场建议 5 个镜头/)
    assert.match(prompt, /该数量作为参考/)
    assert.doesNotMatch(prompt, /创作者未指定镜头数/)
    return JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [shot(null, 10), shot(null, 20)] }] })
  })
  sceneId = f.scene.id
  const context = await f.context()
  const result = await f.invoke('plan', { signature: context.signature, scene_ids: [sceneId], model_id: 'mock-text', shots_per_scene: 5, skill_ids: [] })
  assert.equal(result.scenes[0].shots.length, 2)
  assert.equal(f.calls(), 1)
})

test('automatic counts still require a nonempty plan with valid per-scene timing', async t => {
  let sceneId = '', shots: ReturnType<typeof shot>[] = []
  const f = await setup(t, async () => JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots }] }))
  sceneId = f.scene.id
  const context = await f.context(), input = { signature: context.signature, scene_ids: [sceneId], model_id: 'mock-text', skill_ids: [] }
  await f.invoke('plan', input, 422)
  shots = [shot(null, 16), shot(null, 15)]
  const invalidDuration = await f.invoke('plan', input, 422)
  assert.match(invalidDuration.message, /镜头时长总和必须等于本场规划时长/)
  shots = Array.from({ length: 31 }, (_, index) => shot(null, 1, `镜头${index + 1}`))
  await f.invoke('plan', input, 422)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
})

test('a total duration is allocated across selected scenes; invalid allocation is rejected without writes', async t => {
  let sceneId = '', otherId = '', bad = false
  const f = await setup(t, async () => JSON.stringify({ scenes: [
    { scene_id: sceneId, scene_duration: 20, shots: [shot(null, 8), shot(null, 12)] },
    { scene_id: otherId, scene_duration: bad ? 30 : 25, shots: [shot(null, 10), shot(null, bad ? 20 : 15)] },
  ] }))
  sceneId = f.scene.id; otherId = f.other.id
  const context = await f.invoke('context', { scene_ids: [sceneId, otherId] })
  const input = { signature: context.signature, scene_ids: [sceneId, otherId], model_id: 'mock-text', target_duration: 45 }
  const result = await f.invoke('plan', input)
  assert.equal(result.scenes.reduce((sum: number, scene: { scene_duration: number }) => sum + scene.scene_duration, 0), 45)
  bad = true; await f.invoke('plan', input, 422)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 0)
  assert.equal(one<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', sceneId)!.duration, 30)
})

test('confirming a changed replan preserves shot IDs and history, detaches old media and timeline, and replays once', async t => {
  const f = await setup(t)
  const profileId = 'profile-' + f.scene.id, timestamp = now()
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES (?,?,'character','林晚','日漫风格，蓝色夹克','正侧背三视图',?,?)`, profileId, f.project.id, timestamp, timestamp)
  run('INSERT INTO scene_visual_bindings VALUES (?,?,0)', f.scene.id, profileId)
  const direct = await call('POST', `/api/projects/${f.project.id}/script/convert-to-shots`, { scene_ids: [f.scene.id] }), oldId = direct.shots[0].id
  const originalBinding = one('SELECT * FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', oldId, profileId)
  const assetId = 'asset-' + oldId
  run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,'video','clip.mp4','mock.mp4','import',?)`, assetId, f.project.id, oldId, timestamp)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, oldId)
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms,source_duration_ms) VALUES (?,?,?,?,0,5000,5000)', 'clip-' + oldId, f.project.id, oldId, assetId)
  const context = await f.context(), plan = { signature: context.signature, request_id: crypto.randomUUID(), scenes: [{ scene_id: f.scene.id, scene_duration: 15, shots: [shot(oldId, 6), shot(null, 9, '出口反应')] }] }
  const result = await f.invoke('commit', plan)
  assert.equal(result.shots.length, 2); assert.equal(result.shots[0].id, oldId); assert.equal(result.shots[0].selected_asset_id, null)
  assert.equal(result.shots[0].storyboard_revision, 1)
  assert.deepEqual(result.updated_shot_ids, [oldId]); assert.equal(result.created_shots, 1)
  assert.equal(one<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', f.scene.id)!.duration, 15)
  assert.equal(one('SELECT * FROM timeline_clips WHERE shot_id=?', oldId), undefined)
  assert.equal(one<{ shot_id: string }>('SELECT * FROM assets WHERE id=?', assetId)!.shot_id, oldId)
  assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', oldId, profileId), originalBinding)
  assert.equal(result.shot_visual_bindings.length, 2)
  assert.ok(result.shot_visual_bindings.every((binding: { profile_id: string; required: boolean }) => binding.profile_id === profileId && !binding.required))
  const retry = await f.invoke('commit', plan); assert.equal(retry.replayed, true); assert.equal(retry.shots.length, 2)
  assert.equal(retry.shots[0].storyboard_revision, 1)
  await f.invoke('commit', { ...plan, scenes: [{ ...plan.scenes[0], shots: [shot(oldId, 5), shot(null, 10)] }] }, 409)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 2)
  assert.equal((await f.context()).scenes[0].planned, true)
  await f.prepareReferences()
  const imported = await f.invoke('canvas', { scene_ids: [f.scene.id], mode: 'existing' })
  assert.equal(imported.created_shots, 0); assert.deepEqual(imported.shots, result.shots)
})

test('foreign IDs, removed existing shots and concurrent edits are rejected atomically', async t => {
  const f = await setup(t), old = await call('POST', `/api/projects/${f.project.id}/script/convert-to-shots`, { scene_ids: [f.scene.id] }), context = await f.context()
  const base = { signature: context.signature, request_id: crypto.randomUUID(), scenes: [{ scene_id: f.scene.id, scene_duration: 30, shots: [shot(null, 30)] }] }
  await f.invoke('commit', base, 422)
  await f.invoke('commit', { ...base, scenes: [{ ...base.scenes[0], shots: [shot('foreign', 30)] }] }, 422)
  await call('PATCH', `/api/script-scenes/${f.scene.id}`, { action: '并发修改' })
  await f.invoke('commit', { ...base, scenes: [{ ...base.scenes[0], shots: [shot(old.shots[0].id, 30)] }] }, 409)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', f.project.id).length, 1)
  assert.equal(all('SELECT * FROM shot_plan_requests WHERE project_id=?', f.project.id).length, 0)
})

test('planned shots require prepared visual references before canvas import; missing boards stay blocked until confirmation', async t => {
  let sceneId = ''
  const f = await setup(t, undefined, async prompt => {
    assert.match(prompt, /开镜参考依赖标记/)
    assert.doesNotMatch(prompt, /隐藏场次动作|UNRELATED_EPISODE_DOCUMENT/)
    return JSON.stringify({ profiles: [
      { kind: 'character', name: '林晚', variant: '默认', definition: '日漫，黑短发和蓝色夹克', view_requirements: '正侧背和服装细节', scene_ids: [sceneId] },
      { kind: 'location', name: '地下车站', variant: '夜间', definition: '日漫，双侧月台和中央通道', view_requirements: '布局、多角度和尺度', scene_ids: [sceneId] },
      { kind: 'prop', name: '铜钥匙', variant: '默认', definition: '日漫，磨损黄铜长柄钥匙', view_requirements: '多视角、尺寸和齿纹', scene_ids: [sceneId] },
    ].map(profile => ({ ...profile, shot_usage: all<{ id: string }>('SELECT id FROM shots WHERE source_scene_id=?', sceneId).map(shot => ({ shot_id: shot.id, usage: 'both' })) })) })
  })
  sceneId = f.scene.id
  const stamp = now()
  run(`INSERT INTO script_artifacts (id,project_id,artifact_type,episode_number,title,content,status,position,created_at,updated_at)
    VALUES (?,?,'episode_script',2,'其他集','UNRELATED_EPISODE_DOCUMENT','ready',0,?,?)`, 'other-doc-' + f.project.id, f.project.id, stamp, stamp)
  const context = await f.context()
  const firstShot = { ...shot(null, 12), image_prompt: '日漫，开镜参考依赖标记：林晚在地下车站握住铜钥匙' }
  const saved = await f.invoke('commit', { signature: context.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: sceneId, scene_duration: 30, shots: [firstShot, shot(null, 18)] },
  ] })
  assert.equal(saved.shots.length, 2); assert.equal(saved.visual_profiles.length, 0)
  const pending = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' }, 422)
  assert.match(pending.message, /参考设定尚未整理/)
  assert.equal(f.visualCalls(), 0)
  const prepared = await f.prepareReferences()
  assert.equal(prepared.created_profiles, 3); assert.equal(prepared.created_shots, 0)
  assert.equal(prepared.shot_visual_bindings.length, 6)
  assert.ok(prepared.shot_visual_bindings.every((binding: { required: boolean; board_asset_id: string | null }) => binding.required && !binding.board_asset_id))
  assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [])
  const imported = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' })
  assert.equal(imported.visual_profiles.length, 3, 'canvas opens before reference images are generated')
  const provider = await call('POST', '/api/providers', { name: '仅预览', base_url: 'https://example.invalid', adapter: 'http' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '参考模型', remote_id: 'mock', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/image', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
  const input = { model_id: model.id, shot_id: imported.shots[0].id, prompt: imported.shots[0].image_prompt, mode: 'text' }
  const missing = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/generate/preview`, payload: input })
  assert.equal(missing.statusCode, 422); assert.match(missing.body, /缺少已确认的设定信息图/)
  const ids: string[] = []
  for (const profile of imported.visual_profiles) {
    const assetId = 'board-' + profile.id; ids.push(assetId)
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", assetId, f.project.id, now())
    await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, board_asset_id: assetId })
  }
  const preview = await call('POST', `/api/projects/${f.project.id}/generate/preview`, input)
  assert.equal(preview.mode, 'reference'); assert.deepEqual([...preview.reference_asset_ids].sort(), ids.sort())
  assert.match(preview.prompt, /黑短发和蓝色夹克|双侧月台和中央通道|磨损黄铜长柄钥匙/)
  const repeated = await f.prepareReferences()
  assert.equal(f.visualCalls(), 1); assert.equal(repeated.created_profiles, 0); assert.equal(repeated.created_shots, 0)
  assert.deepEqual(repeated.shots.map((value: { id: string }) => value.id), saved.shots.map((value: { id: string }) => value.id))
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', f.project.id).length, 0)
})

test('changing a saved shot plan invalidates reference preparation and retries preserve completed boards', async t => {
  let sceneId = '', extraProp = false
  const character = () => ({ kind: 'character', name: '林晚', variant: '默认', definition: '日漫蓝色夹克', view_requirements: '正侧背', scene_ids: [sceneId] })
  const f = await setup(t, undefined, async prompt => {
    if (extraProp) assert.match(prompt, /新增红色雨伞/)
    return JSON.stringify({ profiles: [character(), ...(extraProp ? [{ kind: 'prop', name: '红色雨伞', variant: '默认', definition: '日漫红色雨伞', view_requirements: '多角度和骨架细节', scene_ids: [sceneId] }] : [])]
      .map(profile => ({ ...profile, shot_usage: all<{ id: string }>('SELECT id FROM shots WHERE source_scene_id=?', sceneId).map(shot => ({ shot_id: shot.id, usage: 'both' })) })) })
  })
  sceneId = f.scene.id
  const initial = await f.context()
  const saved = await f.invoke('commit', { signature: initial.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: sceneId, scene_duration: 30, shots: [shot(null, 30)] },
  ] })
  const prepared = await f.prepareReferences(), profile = prepared.visual_profiles[0]
  const assetId = 'retained-board-' + profile.id
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", assetId, f.project.id, now())
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, board_asset_id: assetId })
  assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [])
  const current = await f.context()
  extraProp = true
  const changed = await f.invoke('commit', { signature: current.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: sceneId, scene_duration: 30, shots: [{ ...shot(saved.shots[0].id, 30), image_prompt: '日漫，林晚拿着新增红色雨伞' }] },
  ] })
  assert.equal(changed.shots[0].storyboard_revision, 1, 'new shot wording invalidates media even when source documents did not change')
  assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [sceneId])
  await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' }, 422)
  const refreshed = await f.prepareReferences()
  assert.equal(refreshed.created_profiles, 1); assert.equal(refreshed.created_shots, 0)
  assert.equal(refreshed.visual_profiles.find((value: { id: string }) => value.id === profile.id).board_asset_id, assetId)
  assert.equal(refreshed.shots[0].id, saved.shots[0].id)
  assert.equal(f.visualCalls(), 2)
  await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' })
  assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [])
})

test('replanning with changed documents refreshes all setting types and only the selected shot snapshots', async t => {
  const definitions = {
    character: '主角林晚，21岁，黑色短发，蓝色夹克。',
    location: '车站候车室，北侧木门，白色墙面。',
    prop: '黄铜钥匙，三厘米，圆形钥匙头。',
  }
  const names = { character: '林晚', location: '候车室', prop: '钥匙' }
  let shotId: string | null = null, changedDocument = '', latestContent = '', sceneId = ''
  const f = await setup(t, async prompt => {
    if (changedDocument) {
      assert.match(prompt, /选中参考文档中的最新明确设定优先/)
      assert.ok(prompt.includes(JSON.stringify(latestContent)))
    }
    return JSON.stringify({ scenes: [{ scene_id: sceneId, scene_duration: 30, shots: [
      { ...shot(shotId, 30), image_prompt: Object.values(definitions).join('\n'), video_prompt: Object.values(definitions).join('\n') + '人物拿起钥匙' },
    ] }] })
  }, async prompt => {
    if (changedDocument) {
      assert.match(prompt, /当前剧本文档和人物资料中的明确设定优先/)
      assert.ok(prompt.includes(JSON.stringify(latestContent)))
    }
    return JSON.stringify({ profiles: Object.entries(definitions).map(([kind, definition]) => ({
      kind, name: names[kind as keyof typeof names], variant: '默认', definition, view_requirements: '正侧背与局部细节',
      scene_ids: [sceneId], shot_usage: [{ shot_id: shotId, usage: 'both' }],
    })) })
  })
  sceneId = f.scene.id
  const timestamp = now()
  for (const [position, type] of scriptArtifactTypes.entries()) run(`INSERT INTO script_artifacts
    (id,project_id,artifact_type,title,episode_number,content,status,position,created_at,updated_at) VALUES (?,?,?,?,?,?,'ready',?,?,?)`,
    `${f.project.id}-${type}`, f.project.id, type, type, type === 'episode_script' ? 1 : 0, `${type}原文`, position, timestamp, timestamp)
  const savePlan = async () => {
    const context = await f.context()
    const draft = await f.invoke('plan', { scene_ids: [sceneId], signature: context.signature, model_id: 'mock-text',
      document_ids: changedDocument ? [...new Set([changedDocument, `${f.project.id}-relationships`])] : [] })
    if (changedDocument) assert.ok(draft.source_documents.some((document: { id: string }) => document.id === changedDocument))
    return f.invoke('commit', { signature: draft.signature, request_id: crypto.randomUUID(),
      scenes: draft.scenes.map(({ scene_id, scene_duration, shots }: { scene_id: string; scene_duration: number; shots: unknown[] }) => ({ scene_id, scene_duration, shots })) })
  }
  shotId = (await savePlan()).shots[0].id
  const initial = await f.prepareReferences(), profiles = initial.visual_profiles
  // A draft shared by another scene must remain frozen when only this scene is replanned.
  for (const profile of profiles) run('INSERT INTO scene_visual_bindings VALUES (?,?,1)', f.other.id, profile.id)
  const historical = await call('POST', `/api/projects/${f.project.id}/shots`, { title: '历史镜头', source_scene_id: f.other.id })
  const mediaId = `media-${shotId}`
  run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,'image','frame.png','/tmp/frame.png','upload',?)", mediaId, f.project.id, shotId, now())
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', mediaId, shotId)
  run('UPDATE shot_visual_bindings SET required=0 WHERE shot_id=?', shotId)

  for (const type of ['characters', ...scriptArtifactTypes.filter(type => type !== 'characters')]) {
    const stage = scriptStageForArtifact(type)
    const kind = stage === 'locations' ? 'location' : stage === 'props' ? 'prop' : 'character'
    definitions[kind] = type === 'characters' ? definitions.character.replace('21岁', '32岁') : `${definitions[kind]}\n${type}新约束。`
    latestContent = definitions[kind]; changedDocument = `${f.project.id}-${type}`
    const beforeBindings = all<any>('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY profile_id', shotId)
    const historicalBindings = all('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY profile_id', historical.id)
    run('UPDATE script_artifacts SET content=?,updated_at=? WHERE id=?', latestContent, now(), changedDocument)
    if (type === 'characters') run('UPDATE scripts SET characters=? WHERE project_id=?', latestContent, f.project.id)
    const before = all<any>('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id)
    const saved = await savePlan()
    assert.equal(saved.shots[0].id, shotId); assert.equal(saved.shots[0].selected_asset_id, null)
    assert.ok(one('SELECT 1 FROM assets WHERE id=?', mediaId), 'old shot media remains in history')
    assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [sceneId])
    const refreshed = await f.prepareReferences()
    for (const profile of refreshed.visual_profiles) {
      const previous = before.find(item => item.id === profile.id)!
      assert.equal(profile.definition, definitions[profile.kind as keyof typeof definitions])
      assert.equal(profile.revision, previous.revision + Number(profile.kind === kind))
      assert.equal(profile.board_asset_id, profile.kind === kind ? null : previous.board_asset_id)
      const binding = refreshed.shot_visual_bindings.find((item: { profile_id: string }) => item.profile_id === profile.id)
      assert.equal(binding.required, false)
      const stored = beforeBindings.find(item => item.profile_id === profile.id)
      if (profile.kind === kind) {
        // The profile is updated at once and loses its confirmed board. A following binding keeps the complete previous
        // snapshot (never a mix of revisions) and waits until the new board is confirmed
        // (docs/multi-angle-reference-workflow.md, "未确认新版图 … 保留完整旧版并提示").
        assert.equal(binding.sync_status, 'waiting_confirmation')
        assert.equal(binding.revision, stored.revision); assert.equal(binding.definition, stored.definition)
        assert.deepEqual(JSON.stringify(binding.reference_assets), stored.reference_assets)
      } else {
        // Untouched types are refreshed to their current profile and their stored snapshot is not otherwise disturbed.
        assert.equal(binding.definition, profile.definition); assert.equal(binding.revision, profile.revision)
        assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', shotId, profile.id), stored)
      }
    }
    assert.deepEqual(all('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY profile_id', historical.id), historicalBindings)
    assert.deepEqual((await f.context()).reference_preparation.needs_analysis, [])
    const calls = f.visualCalls()
    await f.prepareReferences(); assert.equal(f.visualCalls(), calls)
    const canvas = await f.invoke('canvas', { scene_ids: [sceneId], mode: 'existing' })
    assert.equal(canvas.shots[0].id, shotId)
    // The next edit must invalidate an approved board, while preserving its asset as history.
    const styleVersion = (await call('GET', `/api/projects/${f.project.id}`)).project_visual_style.version
    const nextBindings = []
    for (const profile of refreshed.visual_profiles) {
      const assetId = `board-${profile.id}-${profile.revision}`
      run("INSERT OR IGNORE INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','board.png','/tmp/board.png','upload',?)", assetId, f.project.id, now())
      await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, board_asset_id: assetId })
      const viewAssetId = `view-${profile.id}-${profile.revision}`
      run("INSERT OR IGNORE INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','view.png','/tmp/view.png','upload',?)", viewAssetId, f.project.id, now())
      const withView = await call('POST', `/api/visual-profiles/${profile.id}/reference-assets`, {
        expected_revision: profile.revision, expected_style_version: styleVersion, asset_id: viewAssetId,
        view: 'front', purpose: profile.kind === 'character' ? 'costume' : profile.kind === 'location' ? 'space' : 'structure',
        status: 'confirmed', is_default: true,
      })
      nextBindings.push({ profile_id: profile.id, required: false, usage: 'both',
        reference_asset_ids: [withView.reference_assets.find((reference: { asset_id: string }) => reference.asset_id === viewAssetId).id] })
    }
    // Binding images of the new revision first moves the shot to that revision; this is the explicit refresh the API offers.
    await call('PUT', `/api/shots/${shotId}/visual-bindings`, { bindings: nextBindings, refresh_profile_ids: nextBindings.map(binding => binding.profile_id) })
    for (const binding of beforeBindings.filter(binding => binding.kind === kind)) {
      for (const reference of JSON.parse(binding.reference_assets)) {
        assert.ok(one('SELECT 1 FROM visual_profile_reference_assets WHERE id=?', reference.id))
        assert.ok(one('SELECT 1 FROM assets WHERE id=?', reference.asset_id))
      }
    }
    for (const profile of before.filter(profile => profile.kind === kind && profile.board_asset_id)) {
      assert.ok(one('SELECT 1 FROM assets WHERE id=?', profile.board_asset_id))
      assert.ok(one('SELECT 1 FROM visual_profile_candidates WHERE profile_id=? AND asset_id=?', profile.id, profile.board_asset_id))
    }
  }
  assert.equal(all('SELECT 1 FROM jobs WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT 1 FROM asset_tasks WHERE project_id=?', f.project.id).length, 0)
})
