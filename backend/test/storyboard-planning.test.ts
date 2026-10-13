import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'

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
  return { project, scene, context, draft, plan: () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/plan`,
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
  assert.equal(calls, 1)
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

test('old scene templates stay unplanned after script edits; structured authored shots can be reused', async t => {
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
  assert.equal(context.scenes[0].planned, true)
  assert.deepEqual(context.existing_shots, [{ ...value, scene_id: f.scene.id, title: '车站场次' }])
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
  assert.deepEqual((await f.invoke('plan', inherited)).used_skills.map((item: { id: string }) => item.id), [selected])
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

test('confirming a replan preserves shot IDs, media, timeline and bindings, replaces the plan and replays once', async t => {
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
  assert.equal(result.shots.length, 2); assert.equal(result.shots[0].id, oldId); assert.equal(result.shots[0].selected_asset_id, assetId)
  assert.deepEqual(result.updated_shot_ids, [oldId]); assert.equal(result.created_shots, 1)
  assert.equal(one<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', f.scene.id)!.duration, 15)
  assert.equal(one<{ out_ms: number }>('SELECT * FROM timeline_clips WHERE shot_id=?', oldId)!.out_ms, 5000)
  assert.equal(one<{ shot_id: string }>('SELECT * FROM assets WHERE id=?', assetId)!.shot_id, oldId)
  assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', oldId, profileId), originalBinding)
  assert.equal(result.shot_visual_bindings.length, 2)
  assert.ok(result.shot_visual_bindings.every((binding: { profile_id: string; required: boolean }) => binding.profile_id === profileId && !binding.required))
  const retry = await f.invoke('commit', plan); assert.equal(retry.replayed, true); assert.equal(retry.shots.length, 2)
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
  await f.invoke('commit', { signature: current.signature, request_id: crypto.randomUUID(), scenes: [
    { scene_id: sceneId, scene_duration: 30, shots: [{ ...shot(saved.shots[0].id, 30), image_prompt: '日漫，林晚拿着新增红色雨伞' }] },
  ] })
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
