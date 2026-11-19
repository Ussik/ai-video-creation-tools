import assert from 'node:assert/strict'
import { evidenceWireValue } from '../../backend/test/helpers/appearance-evidence'
import { createHash } from 'node:crypto'
import { appearanceArbitration } from '../../backend/src/modules/visuals/visual-appearance-arbitration'
import { outputContract } from '../../backend/src/modules/generation/model-output'
import { visualRetryToken } from '../../backend/src/modules/visuals/visual-profile-retry'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { JSDOM } from 'jsdom'
import { fixtureVisualCoverage } from '../../backend/test/helpers/visual-coverage'

// The API, checkpoint store and UI are real. Only the provider transport is fake.
const directory = await mkdtemp(join(tmpdir(), 'canvas-ui-api-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
process.env.LANGFUSE_ENABLED = 'false'
process.env.LANGSMITH_TRACING = 'false'
const { buildApp } = await import('../../backend/src/app')
const { all, db, now, run } = await import('../../backend/src/infrastructure/database/db')
const { projectDocuments } = await import('../../backend/src/modules/script/script-document-tools')
const { projectVisualStyle } = await import('../../backend/src/modules/visuals/project-visual-style')
const { saveStoryboardSource, storyboardSourceFingerprint } = await import('../../backend/src/modules/storyboard/storyboard-freshness')
const app = buildApp()
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Production } = await import('../src/features/storyboard/StoryboardProductionDialog')
const { default: Planner } = await import('../src/features/storyboard/StoryboardPlanner')
after(async () => { dom.window.close(); await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const failedKeys = ['PROP-FRIED-NOODLE', 'PROP-BRONZE-GONG', 'PROP-WOOD-CLAPPER']
async function call(url: string, payload?: any) {
  const result = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body); return result.json()
}
async function fixture() {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  const project = await call('/api/projects', { name: '八对象视觉参考恢复离线验收' })
  const scene = await call(`/api/projects/${project.id}/script/scenes`, { heading: '钟表铺', location: '钟表铺', characters: '林晚', duration: 15,
    action: '林晚走过旧柜台，拿起铜钥匙，看向台灯、怀表、木盒、炒面、铜锣和木梆。', episode_number: 1 })
  const shots: any[] = []
  for (let index = 0; index < 5; index++) shots.push(await call(`/api/projects/${project.id}/shots`, { title: '镜头' + (index + 1), source_scene_id: scene.id, duration: 3,
    prompt: '林晚走过钟表铺，查看柜台上的物品。', image_prompt: '林晚站在柜台前', video_prompt: '林晚走过钟表铺，查看柜台上的物品。', start_state: '走入铺内', end_state: '站在柜台前' }))
  const background = Array.from({ length: 700 }, (_, index) => `## 远方地区${index}\n${'无关背景与远方城堡编年史。'.repeat(20)}`).join('\n\n')
  run(`INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,status,position,created_at,updated_at) VALUES (?,?,'story_outline','背景',?,'ready',0,?,?)`, 'bg-' + project.id, project.id, background, now(), now())
  run('INSERT OR IGNORE INTO scripts (project_id,updated_at) VALUES (?,?)', project.id, now())
  run('UPDATE scripts SET characters=? WHERE project_id=?', '林晚穿蓝色外衣。\n' + background, project.id)
  const provider = await call('/api/providers', { name: '离线八对象提供方', base_url: 'https://canvas-catalog.invalid/v1', api_key: 'fixture-only' })
  const model = await call('/api/models', { provider_id: provider.id, name: '离线八对象模型', remote_id: 'fake', modality: 'text', protocol: 'responses',
    settings: { stream: false, structured_output_mode: 'json_schema', request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
  const names = ['铜钥匙', '旧柜台', '台灯', '怀表', '木盒', '炒面', '铜锣', '木梆']
  const catalog = names.map((name, i) => ({ draft_key: i < 5 ? 'SUCCESS-' + i : failedKeys[i - 5]!, kind: 'prop', name, variant: '默认', scene_ids: [scene.id] }))
  const profiles = catalog.map((item, i) => ({ ...item, definition: item.name + '固定材质、外形及配色。', view_requirements: '正侧背与局部细节',
    shot_usage: shots.map((shot, j) => ({ shot_id: shot.id, usage: j === i % shots.length ? 'both' : 'none', reference_view: null })) }))
  const detail = await call('/api/projects/' + project.id)
  saveStoryboardSource(project.id, scene.id, storyboardSourceFingerprint(project, scene, projectDocuments(project.id, detail.script).filter(document => document.content.trim()), projectVisualStyle(project.id).version))
  const check = await call(`/api/projects/${project.id}/script/canvas/check`, { scene_ids: [scene.id] })
  return { project, scene, shots, model, catalog, profiles, detail, check }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
let pendingApi = 0
function adapter(t: TestContext, f: Fixture, options: { interruptProfile?: string; disconnectAfterPrepare?: boolean; validFirst?: boolean; coverageConflict?: boolean; failCoverage?: boolean; blockedCoverage?: boolean; gate?: (key: string, signal?: AbortSignal) => Promise<void> } = {}) {
  const requests: Array<{ path: string; body: any; response: any; status: number }> = []
  const providerCalls: Array<{ name: string; key?: string }> = [], counts = new Map<string, number>()
  let lostOperationLookup = false
  t.mock.method(globalThis, 'fetch', async (url: any, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.startsWith('/api/')) {
      if (lostOperationLookup && path.startsWith('/api/ai-operations/')) return Response.json({ code: 'isolated_status_transport_unavailable' }, { status: 503 })
      init?.signal?.throwIfAborted()
      pendingApi++
      try {
        const response = await app.inject({ method: (init?.method || 'GET') as any, url: path, headers: Object.fromEntries(new Headers(init?.headers)), ...(body ? { payload: body } : {}) })
        requests.push({ path, body, response: response.json(), status: response.statusCode })
        if (path.endsWith('/canvas/prepare') && options.disconnectAfterPrepare) { options.disconnectAfterPrepare = false; lostOperationLookup = true; throw new TypeError('isolated response lost after server completed') }
        return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } })
      } finally { pendingApi-- }
    }
    assert.ok(path.startsWith('https://canvas-catalog.invalid/'), 'unexpected network is prohibited: ' + path)
    const name = body.text?.format?.name, entry: { name: string; key?: string } = { name }; providerCalls.push(entry)
    let value: unknown
    if (name === 'visual_profile_catalog') value = { profiles: f.catalog }
    else if (name === 'visual_profile_content') {
      const item = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0]); entry.key = item.draft_key
      const profile = f.profiles.find(profile => profile.draft_key === item.draft_key)!
      assert.ok(profile)
      const count = (counts.get(item.draft_key) || 0) + 1; counts.set(item.draft_key, count)
      if (options.interruptProfile === item.draft_key && count === 1) return new Response([
        { type: 'response.output_text.delta', delta: '{"definition":"incomplete' },
        { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'upstream stream disconnected' } } },
      ].map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
      await options.gate?.(item.draft_key, init?.signal || undefined)
      value = !options.validFirst && failedKeys.includes(item.draft_key) && count === 1 ? { ...profile, state_delta: '模型擅自增加的未确认变化' }
        : { definition: profile.definition, view_requirements: profile.view_requirements, shot_usage: profile.shot_usage }
    } else if (name === 'visual_reference_coverage' && body.text.format.schema.properties.visual_coverage) {
      const rows = fixtureVisualCoverage(f.profiles, [f.scene], f.shots.map(shot => ({ ...shot, scene_id: f.scene.id, shot_id: shot.id })))
      if (options.coverageConflict) rows[0]!.objects = rows[0]!.objects.filter(object => object.name !== f.profiles[0]!.name)
      value = { visual_coverage: rows }
    } else if (options.coverageConflict && name.startsWith('visual_reference_coverage')) {
      if (options.failCoverage) value = options.blockedCoverage ? { decisions: { unknown_object: {} } } : { decisions: {} }
      else {
        const evidence = JSON.parse(body.input.match(/本次镜头证据：(.*?)(?:\n仅需仲裁|$)/)[1])
        const shot = f.shots.find(shot => shot.id === evidence.shot_id)!
        const target = Object.keys(body.text.format.schema.properties.decisions?.properties || body.text.format.schema.properties.repairs.properties)
        const decisions = Object.fromEntries([...new Set(target.map(key => key.split('__')[0]!))].map(key => [key, { relation_to_base: 'independent',
          image: { visible: true, evidence: { field: 'image_prompt', quote: shot.image_prompt } },
          video: { visible: true, phase: 'throughout', evidence: { field: 'video_prompt', quote: shot.video_prompt } }, reason: '本夹具明确声明该物件在本镜首帧与运动过程中持续可见。' }]))
        const result = Object.fromEntries(target.map(key => [key, key.split('__').reduce<any>((value, part) => value[part], decisions)]))
        value = evidenceWireValue(shot, body.text.format.schema.properties.decisions ? { decisions: result } : { repairs: result })
      }
    } else throw new Error('unexpected provider contract ' + name)
    return Response.json({ output_text: JSON.stringify(value) })
  })
  return { requests, providerCalls, counts }
}
const button = (label: string) => { const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label); assert.ok(value, label); return value }
async function settle() {
  const start = Date.now(); let stable = 0
  while (stable < 2) {
    await new Promise(resolve => setTimeout(resolve, 10)); stable = pendingApi ? 0 : stable + 1
    assert.ok(Date.now() - start < 10_000, 'isolated API did not settle')
  }
}
async function click(label: string, double = false) { await act(async () => { const item = button(label); item.click(); if (double) item.click(); await settle() }) }
async function mount(f: Fixture, planner = false, models = [f.model]) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => { root.render(<MantineProvider env="test">{planner
    ? <Planner opened detail={f.detail} models={models} initialSceneIds={[f.scene.id]} onClose={() => {}} onRefresh={async () => {}} onNotice={() => {}} onOpenCanvas={() => {}} />
    : <Production projectId={f.project.id} sceneIds={[f.scene.id]} shotIds={f.shots.map(shot => shot.id)} designId={null} models={models} onCancel={() => {}} onComplete={() => {}} />}</MantineProvider>); await settle() })
  await act(settle); await act(settle)
  return { destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function business(projectId: string) {
  return Object.fromEntries(['scripts', 'script_scenes', 'shots', 'visual_profiles', 'shot_visual_bindings', 'assets', 'canvas_nodes', 'project_canvases'].map(table => [table, all('SELECT * FROM ' + table
    + (table === 'shot_visual_bindings' ? ' WHERE shot_id IN (SELECT id FROM shots WHERE project_id=?)' : ' WHERE project_id=?') + ' ORDER BY rowid', projectId)]))
}
function privateResponses(projectId: string) {
  return all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', projectId).flatMap(row =>
    Object.entries(JSON.parse(row.payload).steps).filter(([key]) => key.startsWith('response:')).map(([key, value]) => [row.namespace + ':' + row.identity_hash + ':' + key, value] as const))
}

for (const legacy of [false, true]) for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} ${legacy ? 'legacy receipt' : 'terminal upstream interruption'} resumes the same run and imports without regenerating completed work`, async t => {
  const f = await fixture(), transport = adapter(t, f, { validFirst: true, interruptProfile: 'SUCCESS-1' }), before = business(f.project.id)
  let view = await mount(f, planner)
  try {
    await click('加入画布')
    const failed = transport.requests.find(r => r.path.endsWith('/canvas/prepare'))!
    assert.equal(failed.status, 502, JSON.stringify(failed.response))
    assert.doesNotMatch(failed.response.detail, /未通过扩写校验/)
    assert.deepEqual(business(f.project.id), before)
    const snapshot = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
    assert.equal(snapshot.preparation.state, 'failed')
    assert.equal(snapshot.preparation.can_continue, true)
    assert.equal(button('重试').disabled, false, 'a terminal error must refresh recovery immediately')
    if (legacy) {
      const row = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id).find(row => row.namespace.startsWith('canvas-preparation-runs:'))!
      const checkpoint = JSON.parse(row.payload), manifest = checkpoint.steps.manifest.value
      delete manifest.receipts[manifest.runs.find((r: any) => r.id === manifest.active).owner].error.resumable
      const payload = JSON.stringify(checkpoint)
      run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', payload, f.project.id, row.namespace, row.identity_hash)
      const taskId = manifest.runs.find((r: any) => r.id === manifest.active).execution.task_id
      const attempt = all<{ id: string; metrics: string }>('SELECT id,metrics FROM model_request_attempts WHERE task_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1', taskId)[0]!
      const metrics = JSON.parse(attempt.metrics)
      run('UPDATE model_request_attempts SET metrics=? WHERE task_id=? AND id=?', JSON.stringify({ ...metrics, response_terminated: false }), taskId, attempt.id)
      const uncertain = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
      assert.equal(uncertain.preparation.can_continue, false, '502 plus an empty response cannot prove terminal delivery')
      run('UPDATE model_request_attempts SET metrics=? WHERE task_id=? AND id=?', attempt.metrics, taskId, attempt.id)
      const upgraded = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
      assert.equal(upgraded.preparation.can_continue, true, 'legacy recovery requires exact terminal task/operation/response evidence')
      assert.equal(all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=? AND identity_hash=?', f.project.id, row.namespace, row.identity_hash)[0]!.payload, payload, 'status upgrade never rewrites an old receipt')
    }
    const runs = snapshot.preparation.budget.runs, runId = snapshot.preparation.run_id
    const retained = privateResponses(f.project.id).filter(([, entry]) => (entry as any).value?.raw)
    await view.destroy(); view = await mount(f, planner)
    await click('重试', true)
    const prepares = transport.requests.filter(r => r.path.endsWith('/canvas/prepare'))
    assert.equal(prepares.length, 2)
    assert.notEqual(prepares[1]!.body.request_id, prepares[0]!.body.request_id, 'a received failure cannot replay the spent browser intent')
    assert.equal(prepares[1]!.body.run_id, runId)
    assert.equal(prepares[1]!.body.restart_from_run_id, undefined)
    assert.equal(prepares[1]!.status, 200, JSON.stringify(prepares[1]!.response))
    assert.equal(prepares[1]!.response.preparation.budget.runs, runs)
    assert.equal(transport.providerCalls.filter(c => c.name === 'visual_profile_catalog').length, 1)
    assert.equal(transport.counts.get('SUCCESS-0'), 1)
    assert.equal(transport.counts.get('SUCCESS-1'), 2)
    const latest = new Map(privateResponses(f.project.id))
    for (const [id, entry] of retained) assert.deepEqual(latest.get(id), entry)
    assert.equal(transport.requests.filter(r => r.path.endsWith('/canvas/commit') && r.status === 200).length, 1)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1)
  } finally { await view.destroy() }
})

for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} uses real partial API results: five successes, one result action dispatches three failed units`, async t => {
  const f = await fixture(), transport = adapter(t, f), before = business(f.project.id)
  const view = await mount(f, planner)
  try {
    assert.equal(transport.providerCalls.length, 0, 'recovery reads never invoke providers')
    assert.equal(button(planner ? '加入画布' : '加入画布').disabled, false)
    await click(planner ? '加入画布' : '加入画布')
    const partial = transport.requests.find(request => request.path.endsWith('/canvas/prepare'))!
    assert.ok(partial, JSON.stringify({ requests: transport.requests, ui: document.body.textContent }))
    assert.equal(partial.status, 200, JSON.stringify(partial.response))
    assert.equal(partial.response.profiles.length, 5); assert.equal(partial.response.failed_units.length, 3)
    assert.equal(button('重试').disabled, false)
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.deepEqual(business(f.project.id), before, 'partial preparation does not change business records')
    const original = privateResponses(f.project.id), count = transport.providerCalls.length
    await click('重试', true)
    const prepares = transport.requests.filter(request => request.path.endsWith('/canvas/prepare'))
    assert.equal(prepares.length, 2, JSON.stringify(transport.requests.map(request => [request.path, request.status, request.response.detail])))
    assert.deepEqual(prepares[1]!.body.unit_keys, failedKeys)
    assert.deepEqual(transport.providerCalls.slice(count).filter(call => call.name === 'visual_profile_content').map(call => call.key), failedKeys)
    assert.equal(transport.providerCalls.filter(call => call.name === 'visual_profile_catalog').length, 1)
    for (let i = 0; i < 5; i++) assert.equal(transport.counts.get('SUCCESS-' + i), 1)
    const latest = new Map(privateResponses(f.project.id))
    for (const [id, value] of original) assert.deepEqual(latest.get(id), value, 'original answers and corrections stay immutable')
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200), JSON.stringify(transport.requests.map(request => [request.path, request.status, request.response.detail])))
    assert.equal(transport.requests.filter(request => request.path.endsWith('/storyboard/commit')).length, 0)
  } finally { await view.destroy() }
})

for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} a new complete run saves and opens automatically, then reopens without a model`, async t => {
  const f = await fixture(), options = { validFirst: true, coverageConflict: true, failCoverage: true, blockedCoverage: true }, transport = adapter(t, f, options)
  let view = await mount(f, planner)
  try {
    await click('加入画布'); await click('重试')
    const blocked = transport.requests.filter(r => r.path.endsWith('/canvas/prepare')).at(-1)!.response
    assert.ok(blocked.failed_units.every((unit: any) => unit.code === 'visual_coverage_local_target_unavailable'))
    options.failCoverage = false
    const original = privateResponses(f.project.id), count = transport.providerCalls.length
    await click('重新整理', true)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1, 'restart does not open a second dialog')
    const fresh = transport.requests.filter(request => request.path.endsWith('/canvas/prepare')).at(-1)!
    assert.equal(fresh.status, 200, JSON.stringify(fresh.response))
    assert.equal(fresh.response.preparation.full_scope, true)
    assert.equal(fresh.response.preparation.state, 'complete')
    assert.equal(fresh.response.preparation.run_id, fresh.body.request_id)
    assert.equal(fresh.response.preparation.budget.runs, 2)
    assert.equal(transport.providerCalls.slice(count).filter(call => call.name === 'visual_profile_content').length, 8)
    const latest = new Map(privateResponses(f.project.id))
    for (const [id, value] of original) assert.deepEqual(latest.get(id), value)
    assert.equal(transport.requests.filter(r => r.path.endsWith('/canvas/commit') && r.status === 200).length, 1)
    assert.ok(transport.requests.some(r => r.path.endsWith('/storyboard/canvas') && r.status === 200))
    assert.ok(transport.requests.some(r => r.path.endsWith('/canvas/commit') && r.body.run_id === fresh.body.request_id && r.status === 200))
    const providerCount = transport.providerCalls.length
    await view.destroy(); view = await mount(f, planner, [])
    await click('加入画布', true)
    assert.equal(transport.providerCalls.length, providerCount, 'saved references survive reopening and model removal')
    assert.equal(transport.requests.filter(r => r.path.endsWith('/canvas/commit') && r.status === 200).length, 1)
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 8)
  } finally { await view.destroy() }
})

for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} a single-unit API retry preserves other failures for the result action on reopen`, async t => {
  const f = await fixture(), transport = adapter(t, f)
  let view = await mount(f, planner)
  try {
    await click(planner ? '加入画布' : '加入画布')
    const count = transport.providerCalls.length
    const scope = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
    const retry = scope.plan.failed_units.find((unit: any) => unit.unit_key === failedKeys[0])
    await fetch(`/api/projects/${f.project.id}/script/canvas/prepare`, { method: 'POST', body: JSON.stringify({ scene_ids: [f.scene.id], signature: scope.signature, model_id: f.model.id, run_id: scope.preparation.run_id, request_id: crypto.randomUUID(), unit_keys: [retry.unit_key], retry_unit: { unit_key: retry.unit_key, token: retry.recovery.token } }) })
    const prepares = transport.requests.filter(request => request.path.endsWith('/canvas/prepare'))
    assert.equal(prepares.length, 2); assert.equal(prepares[1]!.status, 200, JSON.stringify(prepares[1]!.response))
    assert.deepEqual(prepares[1]!.body.unit_keys, [failedKeys[0]])
    assert.equal(prepares[1]!.response.profiles.length, 6); assert.equal(prepares[1]!.response.failed_units.length, 2)
    assert.deepEqual(transport.providerCalls.slice(count).map(call => [call.name, call.key]), [['visual_profile_content', failedKeys[0]]])
    assert.equal(button('重试').disabled, false)
    const remainingCount = transport.providerCalls.length
    await view.destroy(); view = await mount(f, planner)
    assert.equal(transport.providerCalls.length, remainingCount)
    assert.equal(button('重试').disabled, false)
    assert.match(document.querySelector('[aria-label="画布准备结果"]')!.textContent!, /未能加入画布/)
    await click('重试')
    for (let i = 0; i < 5; i++) assert.equal(transport.counts.get('SUCCESS-' + i), 1)
    assert.equal(transport.counts.get(failedKeys[0]!), 2)
  } finally { await view.destroy() }
})

for (const state of ['unknown', 'budget'] as const) test(`${state} recovery disables competing UI actions and explains the backend decision`, async t => {
  const f = await fixture(), transport = adapter(t, f)
  let view = await mount(f)
  try {
    await click('加入画布'); await view.destroy()
    const rows = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    const row = rows.find(row => row.namespace.startsWith('canvas-preparation-runs:'))!, checkpoint = JSON.parse(row.payload)
    const manifest = checkpoint.steps.manifest.value
    if (state === 'unknown') {
      manifest.runs.find((run: any) => run.id === manifest.active).state = 'unknown'
      const responseRow = rows.find(row => row.namespace.startsWith('visual-profiles:'))!, responseState = JSON.parse(responseRow.payload)
      const entry: any = Object.entries(responseState.steps).find(([key]) => key.startsWith('response:'))![1]
      entry.value.initial_started = { input_hash: entry.value.input_hash }; delete entry.value.raw
      run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(responseState), f.project.id, responseRow.namespace, responseRow.identity_hash)
    }
    else manifest.usage.requests = 512
    run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(checkpoint), f.project.id, row.namespace, row.identity_hash)
    const before = transport.providerCalls.length
    view = await mount(f)
    assert.equal(document.querySelector<HTMLButtonElement>('.storyboard-production-primary')!.disabled, state !== 'unknown')
    if (state === 'unknown') assert.equal(button('重新整理').disabled, false)
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    assert.match(document.body.textContent!, state === 'unknown' ? /正在确认结果/ : /未能加入画布/)
    await click('刷新状态')
    assert.equal(transport.providerCalls.length, before)
  } finally { await view.destroy() }
})

test('a stale running claim with settled responses restores partial results through the status API and enables the real retry action', async t => {
  const f = await fixture(), transport = adapter(t, f)
  let view = await mount(f)
  try {
    await click('加入画布'); await view.destroy()
    const row = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id).find(row => row.namespace.startsWith('canvas-preparation-runs:'))!
    const checkpoint = JSON.parse(row.payload), manifest = checkpoint.steps.manifest.value
    manifest.runs.find((run: any) => run.id === manifest.active).state = 'running'
    manifest.runs.find((run: any) => run.id === manifest.active).owner = 'retired-process-owner'
    run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(checkpoint), f.project.id, row.namespace, row.identity_hash)
    const calls = transport.providerCalls.length
    view = await mount(f)
    assert.equal(document.querySelector<HTMLButtonElement>('.storyboard-production-primary')!.disabled, false, 'a dead executor with settled responses must not leave the user at a disabled dead end')
    assert.equal(transport.providerCalls.length, calls, 'status reconciliation never calls a model')
    await click('重试')
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200))
    for (let i = 0; i < 5; i++) assert.equal(transport.counts.get('SUCCESS-' + i), 1)
  } finally { await view.destroy() }
})

test('a browser-side unknown is corrected by authoritative complete status and reuses the prepared result on reopen', async t => {
  const f = await fixture(), transport = adapter(t, f, { disconnectAfterPrepare: true, validFirst: true })
  let view = await mount(f)
  try {
    await click('加入画布')
    const restored = transport.requests.filter(request => request.path.endsWith('/canvas/recovery')).at(-1)!.response
    assert.equal(restored.preparation?.state, 'complete', JSON.stringify(transport.requests.map(request => ({ path: request.path, status: request.status, state: request.response.preparation?.state, detail: request.response.detail, code: request.response.code }))))
    assert.equal(button('加入画布').disabled, false)
    assert.equal(document.querySelector('[role=alert]'), null)
    const count = transport.providerCalls.length
    await view.destroy(); view = await mount(f)
    assert.equal(transport.providerCalls.length, count)
    await click('加入画布')
    assert.equal(transport.providerCalls.length, count, 'completed backend response must not be generated again after UI disconnect')
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200))
  } finally { await view.destroy() }
})

async function until(check: () => boolean) {
  const started = Date.now()
  while (!check()) { assert.ok(Date.now() - started < 5000, 'isolated recovery did not reach expected state'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
}

test('closing during live preparation leaves work running and reopening reuses completion without automatic adoption', async t => {
  const f = await fixture(); let paused = false, release!: () => void, signal: AbortSignal | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport = adapter(t, f, { validFirst: true, gate: async (key, currentSignal) => {
    if (key !== 'SUCCESS-0') return
    signal = currentSignal; paused = true; await gate
  } })
  let view = await mount(f)
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 5)) })
    await until(() => paused)
    await act(() => button('关闭').click())
    await view.destroy()
    assert.equal(signal?.aborted, false, 'closing is separate from the explicit local stop action')
    release(); await act(settle)
    assert.equal(transport.requests.some(request => request.path.endsWith('/canvas/commit')), false, 'a detached subscriber cannot adopt results')
    const count = transport.providerCalls.length
    view = await mount(f)
    assert.equal(button('加入画布').disabled, false)
    await click('加入画布')
    assert.equal(transport.providerCalls.length, count, 'reopening reuses durable completed work')
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200))
    await view.destroy(); view = await mount(f)
    assert.equal(button('加入画布').disabled, false, 'adoption must not make the saved business fingerprint look like an unconfirmed source edit')
    await click('加入画布')
    assert.equal(transport.providerCalls.length, count, 'already adopted references remain reusable')
  } finally { release(); await view.destroy(); await act(settle) }
})

test('status API → UI cancellation retains an unknown response; explicit abandonment creates one isolated run and completes the handoff', async t => {
  let poll!: () => void
  const interval = dom.window.setInterval.bind(dom.window)
  t.mock.method(dom.window, 'setInterval', (callback: () => void, delay?: number) => { if (delay === 5000) poll = callback; return interval(callback, delay) })
  const f = await fixture(); let paused = false, shouldPause = false
  const transport = adapter(t, f, { gate: async (key, signal) => {
    if (!shouldPause || key !== failedKeys[0]) return
    shouldPause = false; paused = true
    await new Promise((_, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } })
  let view = await mount(f)
  try {
    await click('加入画布'); shouldPause = true
    await act(async () => { button('重试').click(); await new Promise(resolve => setTimeout(resolve, 5)) })
    await until(() => paused)
    await act(async () => poll())
    await until(() => transport.requests.filter(request => request.path.endsWith('/canvas/recovery')).at(-1)?.response.preparation?.state === 'running')
    const running = transport.requests.filter(request => request.path.endsWith('/canvas/recovery')).at(-1)!.response.preparation
    assert.equal(running.state, 'running'); assert.equal(running.inspection.executor, 'active')
    assert.ok(running.inspection.task_id); assert.ok(running.inspection.heartbeat_at)
    assert.ok(running.inspection.progress)
    assert.ok(![...document.querySelectorAll('button')].some(node => node.textContent === '停止任务'))
    // Cancellation remains a backend capability, deliberately absent from this dialog.
    await act(async () => { await call(`/api/projects/${f.project.id}/script/canvas/cancel`, { scene_ids: [f.scene.id], run_id: running.run_id, owner_request_id: running.inspection.owner_request_id }); await settle() })
    await until(() => pendingApi === 0)
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); await settle() })
    const status = transport.requests.filter(request => request.path.endsWith('/canvas/recovery')).at(-1)!.response
    assert.equal(status.preparation.state, 'unknown'); assert.equal(status.preparation.inspection.can_abandon, true)
    assert.equal(button('重新整理').disabled, false)
    const count = transport.providerCalls.length, privateBefore = privateResponses(f.project.id)
    const before = business(f.project.id)
    await view.destroy(); view = await mount(f)
    assert.equal(transport.providerCalls.length, count, 'reopen inspects without replaying the unknown request')
    await click('重新整理', true)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1)
    const restarted = transport.requests.filter(request => request.path.endsWith('/canvas/prepare')).at(-1)!
    assert.equal(restarted.status, 200, JSON.stringify(restarted.response))
    assert.equal(restarted.body.abandon_unknown, true); assert.equal(restarted.body.restart_from_run_id, status.preparation.run_id)
    assert.equal(restarted.response.preparation.run_id, restarted.body.request_id)
    assert.equal(restarted.response.preparation.state, 'complete')
    assert.ok(transport.requests.some(r => r.path.endsWith('/canvas/commit') && r.status === 200), 'explicitly restarted complete results continue to commit')
    const privateAfter = new Map(privateResponses(f.project.id))
    for (const [key, value] of privateBefore) assert.deepEqual(privateAfter.get(key), value, 'old unknown response remains intact')
    const newCount = transport.providerCalls.length
    await view.destroy(); view = await mount(f, false, [])
    assert.equal(button('加入画布').disabled, false)
    await click('加入画布'); assert.equal(transport.providerCalls.length, newCount)
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200 && request.body.run_id === restarted.body.request_id))
  } finally { await view.destroy() }
})


for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} coverage failure preserves completed profiles on reopen and offers coverage-only correction`, async t => {
  const f = await fixture(), options = { validFirst: true, coverageConflict: true, failCoverage: true }, transport = adapter(t, f, options)
  let view = await mount(f, planner)
  try {
    await click('加入画布')
    const partial = transport.requests.find(request => request.path.endsWith('/canvas/prepare'))!.response
    assert.equal(partial.profiles.length, 8)
    assert.ok(partial.failed_units.every((unit: any) => unit.stage === 'coverage'))
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.equal(button('重试').disabled, false)
    const count = transport.providerCalls.length
    await view.destroy(); view = await mount(f, planner)
    assert.equal(transport.providerCalls.length, count)
    assert.match(document.body.textContent!, /已有结果已保留/)
    options.failCoverage = false
    await click('重试', true)
    assert.equal(transport.providerCalls.filter(call => call.name === 'visual_profile_content').length, 8)
    assert.equal(transport.providerCalls.filter(call => call.name === 'visual_profile_catalog').length, 1)
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200))
  } finally { await view.destroy() }
})


for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} migrates a nine-profile 4/4 local-replay dead end and actually completes only two appearance units`, async t => {
  const f = await fixture()
  const ninth = { ...f.catalog[1]!, draft_key: 'SUCCESS-NINTH', name: '第九物品' }
  f.catalog.push(ninth); f.profiles.push({ ...f.profiles[1]!, ...ninth })
  f.profiles[0]!.shot_usage[1]!.usage = 'both'
  const options = { validFirst: true, coverageConflict: true, failCoverage: true }, transport = adapter(t, f, options)
  let view = await mount(f, planner)
  try {
    await click('加入画布'); await view.destroy()
    const rows = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    const ledgerRow = rows.find(row => row.namespace.startsWith('canvas-preparation-runs:'))!, ledger = JSON.parse(ledgerRow.payload)
    const activeRun = ledger.steps.manifest.value.runs.find((r: any) => r.id === ledger.steps.manifest.value.active)
    const responseRow = rows.find(row => row.namespace.startsWith('visual-profiles:') && (row.namespace.endsWith(':run:' + activeRun.id) || activeRun.id === 'legacy' && !row.namespace.includes(':run:')))!, checkpoint = JSON.parse(responseRow.payload)
    for (const key of Object.keys(checkpoint.steps)) if (key.includes('@appearance:')) delete checkpoint.steps[key]
    const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
    const failed: any[] = []
    for (const shot of f.shots.slice(0, 2)) {
      const plan = appearanceArbitration(shot, f.scene, [f.profiles[0]!] as any)
      const schema = outputContract('visual_reference_coverage', plan.schema).schema
      const identity = { policy: 'visual-coverage-unit-v1', prompt: plan.prompt, schema }, unit_key = '@appearance:' + shot.id
      const stepId = 'unit:' + hash(identity) + ':' + unit_key, original = { identity, key: unit_key }
      const raw = JSON.stringify({ decisions: [{ draft_key: f.profiles[0]!.draft_key, image: { visible: true, evidence: '解释文字不能冒充逐字证据' }, video: { visible: true, phase: 'throughout', evidence: '解释文字仍需补全对应来源字段和逐字引用' } }] })
      let args: unknown = original, id = stepId, spent = ''
      for (let attempt = 1; attempt <= 4; attempt++) {
        const binding = hash({ parent_input_hash: hash(args), name: 'visual_reference_coverage', prompt: plan.prompt, schema })
        const slot = 'response:' + id + ':' + binding
        const response = { input_hash: hash(['visual_reference_coverage', schema, plan.prompt]), raw, original_raw: raw }
        checkpoint.steps[slot] = { input_hash: binding, value: response }
        if (attempt > 1) checkpoint.steps['retry-failed:' + stepId + ':' + spent] = { input_hash: hash(args), value: { code: 'model_business_validation', delivery: 'completed' } }
        spent = attempt === 1 ? hash({ policy: 'coverage-retry-v1', stepId, original: response }) : visualRetryToken(stepId, slot, response, attempt)
        id = 'retry:' + stepId + ':' + spent; args = { original, retry_token: spent }
      }
      const unit = { unit_key, name: '镜头「' + shot.title + '」用途仲裁', stage: 'coverage', code: 'visual_coverage_conflict', message: '$.decisions要求object当前array',
        attempt: 4, is_new_model_call: false, checkpoint_source: 'original_raw', retryable: false, recovery_type: 'blocked', scene_ids: [f.scene.id], shot_ids: [shot.id],
        recovery: { action: 'none', model_call: 'none', reason: '本对象已完成 4/4 次尝试' } }
      checkpoint.steps['visual-unit-failure:' + hash(identity) + ':' + unit_key] = { input_hash: hash(original), value: unit }; failed.push(unit)
    }
    activeRun.plan.failed_units = failed; activeRun.plan.status = 'partial'; activeRun.state = 'partial'
    run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(checkpoint), f.project.id, responseRow.namespace, responseRow.identity_hash)
    run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(ledger), f.project.id, ledgerRow.namespace, ledgerRow.identity_hash)
    const sourceBefore = structuredClone(checkpoint.steps), before = transport.providerCalls.length
    view = await mount(f, planner)
    assert.equal(transport.providerCalls.length, before)
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.doesNotMatch(document.body.textContent!, /达到上限/)
    assert.equal(button('重试').disabled, false)
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    const projected = transport.requests.filter(request => request.path.endsWith('/canvas/recovery')).at(-1)!.response
    assert.ok(projected.plan.failed_units.every((u: any) => u.attempt === 1 && u.model_request_count === 1 && u.local_validation_count === 4 && u.recovery.action === 'retry'))
    options.failCoverage = false
    await click('重试', true)
    assert.equal(transport.providerCalls.length - before, 2)
    assert.ok(transport.providerCalls.slice(before).every(call => call.name === 'visual_reference_coverage_local_repair'))
    assert.equal(transport.providerCalls.filter(call => call.name === 'visual_profile_content').length, 9)
    assert.ok(transport.requests.some(request => request.path.endsWith('/canvas/commit') && request.status === 200))
    const retained = JSON.parse(all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=?', f.project.id, responseRow.namespace)[0]!.payload).steps
    for (const [key, entry] of Object.entries(sourceBefore)) if (key.startsWith('response:') || key.startsWith('retry-failed:') || key.startsWith('unit:')) assert.deepEqual(retained[key], entry)
  } finally { await view.destroy() }
})

for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} stale three-run scope preserves/discards old work through the API then prepares replacement shots`, async t => {
  const f = await fixture(), transport = adapter(t, f)
  let view = await mount(f, planner)
  try {
    await click('加入画布')
    for (let index = 0; index < 2; index++) {
      // Seed an unadopted historical run, as when its dialog was closed.
      const scope = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
      await fetch(`/api/projects/${f.project.id}/script/canvas/prepare`, { method: 'POST', body: JSON.stringify({ scene_ids: [f.scene.id], signature: scope.signature,
        model_id: f.model.id, request_id: crypto.randomUUID(), restart_from_run_id: scope.preparation.run_id }) })
    }
    const old = transport.requests.filter(item => item.path.endsWith('/canvas/prepare')).at(-1)!.response
    assert.equal(old.preparation.budget.runs, 3)
    const oldShots = f.shots.map(shot => shot.id)
    await view.destroy()
    for (const shot of f.shots) { const next = 'replacement-' + shot.id; run('UPDATE shots SET id=? WHERE id=?', next, shot.id); shot.id = next }
    for (const profile of f.profiles) for (const usage of profile.shot_usage) usage.shot_id = f.shots[oldShots.indexOf(usage.shot_id)]!.id
    f.detail = await call('/api/projects/' + f.project.id)
    const before = business(f.project.id), providerCount = transport.providerCalls.length
    view = await mount(f, planner)
    assert.equal(button('整理参考').disabled, false)
    assert.match(document.body.textContent!, /分镜已更新/)
    assert.ok(![...document.querySelectorAll('button')].some(node => node.textContent === '核对状态'))
    assert.equal(document.querySelector('.reference-preparation-links'), null)
    // Retained results are still available through the API without cluttering the result dialog.
    const retained = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
    assert.equal(retained.retained_plan.profiles.length, old.profiles.length)
    const discarded = await call(`/api/projects/${f.project.id}/script/canvas/discard`, { scene_ids: [f.scene.id], signature: retained.signature, run_id: retained.preparation.run_id })
    assert.equal(transport.providerCalls.length, providerCount)
    assert.deepEqual(business(f.project.id), before)
    assert.equal(discarded.preparation.adoption.discarded, true)
    assert.deepEqual(discarded.retained_plan.signature, old.signature)
    await click('整理参考', true)
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1)
    const prepared = transport.requests.filter(item => item.path.endsWith('/canvas/prepare')).at(-1)!
    assert.equal(prepared.status, 200, JSON.stringify(prepared.response))
    assert.equal(prepared.body.prepare_current_from_run_id, old.preparation.run_id)
    assert.equal(prepared.response.preparation.budget.runs, 4)
    assert.ok(prepared.response.preparation.budget.task_requests > old.preparation.budget.task_requests)
    assert.notEqual(prepared.response.signature, old.signature)
    assert.ok(transport.requests.some(r => r.path.endsWith('/storyboard/canvas') && r.status === 200), 'current-scope result automatically continues to canvas')
    assert.equal(transport.requests.filter(item => item.path.endsWith('/canvas/commit') && item.status === 200).length, 1)
    const currentIds = f.shots.map(shot => shot.id)
    for (const binding of all<any>('SELECT * FROM shot_visual_bindings WHERE shot_id IN (' + currentIds.map(() => '?').join(',') + ')', ...currentIds)) assert.ok(currentIds.includes(binding.shot_id))
  } finally { await view.destroy() }
})


for (const planner of [false, true]) test(`${planner ? 'planner' : 'production'} exhausted real coverage requests preserve successes and expose only the authorized restart`, async t => {
  const f = await fixture(), options = { validFirst: true, coverageConflict: true, failCoverage: true }, transport = adapter(t, f, options)
  let view = await mount(f, planner)
  try {
    await click('加入画布')
    for (let index = 0; index < 2; index++) await click('重试')
    const latest = transport.requests.filter(request => request.path.endsWith('/canvas/prepare')).at(-1)!.response
    assert.equal(latest.failed_units[0].model_request_count, 4)
    assert.equal(latest.failed_units[0].recovery.action, 'none')
    assert.equal(latest.profiles.length, 8)
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.equal(button('重新整理').disabled, false, 'server-authorized restart stays visible after retries are exhausted')
    assert.ok(![...document.querySelectorAll('button')].some(button => /继续覆盖检查|修正逐镜用途/.test(button.textContent || '')))
    assert.doesNotMatch(latest.preparation.continue_reason, /全部重新开始/)
    const count = transport.providerCalls.length, before = business(f.project.id)
    await view.destroy(); view = await mount(f, planner)
    assert.equal(transport.providerCalls.length, count)
    assert.deepEqual(business(f.project.id), before)
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.equal(transport.requests.filter(request => request.path.endsWith('/canvas/commit')).length, 0)
  } finally { await view.destroy() }
})
