import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { estimateTextRequestTokens, textRequestInput } from '../src/infrastructure/providers/text-context.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fixtureVisualCoverage } from './helpers/visual-coverage.js'

const dir = await mkdtemp(join(tmpdir(), 'canvas-catalog-60fa-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { buildApp } = await import('../src/app.js')
const { db, all, run, now } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }) })
async function call(url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload: payload as any })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await call('/api/projects', { name: '目录一场五镜隔离回归' })
  const scene = await call(`/api/projects/${project.id}/script/scenes`, {
    heading: '钟表铺内', location: '钟表铺', characters: '林晚', action: '林晚拿起铜钥匙，走向柜台。', episode_number: 1,
  })
  const shots = []
  for (let index = 0; index < 5; index++) shots.push(await call(`/api/projects/${project.id}/shots`, {
    title: `本场第${index + 1}镜`, source_scene_id: scene.id, duration: 3,
    image_prompt: `钟表铺内林晚握着铜钥匙，第${index + 1}镜开镜`, video_prompt: '林晚将铜钥匙放在柜台上。',
    start_state: '手持铜钥匙', end_state: '铜钥匙落在柜台上',
  }))
  const background = Array.from({ length: 700 }, (_, index) => `## 其他地区${index}\n无关背景记录${index}：${'远方矿山和城堡的编年史。'.repeat(20)}`).join('\n\n')
  run(`INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,status,position,created_at,updated_at)
    VALUES (?,?,'story_outline','全项目背景',?,'ready',0,?,?)`, `background-${project.id}`, project.id, background, now(), now())
  run('INSERT OR IGNORE INTO scripts (project_id,updated_at) VALUES (?,?)', project.id, now())
  run('UPDATE scripts SET characters=? WHERE project_id=?', '## 林晚\n林晚固定穿蓝色外衣，铜钥匙的齿形已确认。\n\n' + background, project.id)
  const provider = await call('/api/providers', { name: '隔离请求捕获', base_url: 'https://canvas-catalog.invalid/v1', api_key: 'fixture-only-key' })
  const model = await call('/api/models', { provider_id: provider.id, name: '离线目录模型', remote_id: 'fixture-model', modality: 'text', protocol: 'responses',
    settings: { stream: false, structured_output_mode: 'json_schema', request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' } })
  const catalog = [{ draft_key: 'actor', kind: 'character', name: '林晚', variant: '默认', scene_ids: [scene.id] },
    { draft_key: 'key', kind: 'prop', name: '铜钥匙', variant: '默认', scene_ids: [scene.id] }]
  const profiles = catalog.map(item => ({ ...item, definition: item.name === '林晚' ? '林晚穿已确认蓝色外衣，面部固定。' : '铜钥匙固定齿形和黄铜材质。',
    view_requirements: '正侧背及局部细节', shot_usage: shots.map(shot => ({ shot_id: shot.id, usage: 'both', reference_view: null })) }))
  const checked = await call(`/api/projects/${project.id}/script/canvas/check`, { scene_ids: [scene.id] })
  const request = { scene_ids: [scene.id], signature: checked.signature, model_id: model.id, skill_ids: [] }
  const prepare = () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/canvas/prepare`, payload: request })
  return { project, scene, shots, background, catalog, profiles, request, prepare }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

for (const protocol of ['responses', 'anthropic_messages']) test(`single-object final ${protocol} transport sends one content schema and bounded relevant context`, async t => {
  const f = await fixture(), captured: any[] = []
  if (protocol === 'anthropic_messages') run('UPDATE models SET protocol=?,settings=? WHERE id=?', protocol,
    JSON.stringify({ stream: false, structured_output_mode: 'json_schema', text_api: { mode: 'standard', output_mode: 'auto' } }), f.request.model_id)
  for (const [type, content] of [
    ['world', '## 不相关的远方世界\n' + 'UNRELATED_WORLD与远方城堡的历史。'.repeat(10000)],
    ['episode_outline', '## 全季大纲\nEP001-SC001 ' + 'UNRELATED_ALL_EPISODES'.repeat(10000)],
    ['props', '## 铜钥匙\n固定黄铜齿形，不能变成银质。\n\n## 其他物品\n' + 'UNRELATED_PROP'.repeat(5000)],
  ]) run(`INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,status,position,created_at,updated_at) VALUES (?,?,?,'隔离资料',?,'ready',0,?,?)`, randomUUID(), f.project.id, type, content, now(), now())
  f.request.signature = (await call(`/api/projects/${f.project.id}/script/canvas/check`, { scene_ids: [f.scene.id] })).signature
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/canvas-catalog\.invalid\//)
    const body = JSON.parse(String(init.body)), schema = body.text?.format?.schema || body.output_config?.format?.schema
    assert.ok(schema, 'the final provider body carries the code-owned native schema')
    let value: unknown
    if (schema.properties.profiles) value = { profiles: f.catalog }
    else if (schema.properties.definition) {
      const prompt = protocol === 'responses' ? body.input : body.messages.map((message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text || '').join('\n')).join('\n')
      const item = JSON.parse(prompt.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      const profile = f.profiles.find(profile => profile.draft_key === item.draft_key)!
      captured.push(body)
      assert.ok(!prompt.includes('UNRELATED_WORLD') && !prompt.includes('UNRELATED_ALL_EPISODES') && !prompt.includes('UNRELATED_PROP'))
      assert.ok(!prompt.includes('usage_type') && !prompt.includes('"profiles":'))
      assert.deepEqual(Object.keys(schema.properties).sort(), ['definition', 'shot_usage', 'view_requirements'])
      assert.equal(schema.properties.view_requirements.type, 'string')
      assert.deepEqual(schema.properties.shot_usage.items.properties.usage.enum, ['both', 'image', 'video', 'none'])
      assert.ok(!JSON.stringify(schema).includes('hand_held'))
      const inputTokens = estimateTextRequestTokens(textRequestInput(body))
      assert.ok(inputTokens < 15_000, `final wire estimate ${inputTokens} must exclude huge unrelated documents`)
      value = { definition: profile.definition, view_requirements: profile.view_requirements, shot_usage: profile.shot_usage }
    } else if (schema.properties.visual_coverage) value = { visual_coverage: fixtureVisualCoverage(f.profiles, [f.scene], f.shots.map(shot => ({ ...shot, scene_id: f.scene.id, shot_id: shot.id }))) }
    else throw new Error('unexpected native schema')
    return Response.json(protocol === 'anthropic_messages' ? { id: 'msg_offline', type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 } }
      : { output_text: JSON.stringify(value) })
  })
  const result = await f.prepare(); assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().status, 'complete'); assert.equal(captured.length, 2)
})

function upstream(t: TestContext, f: Fixture, generate?: (name: string, body: any, count: number) => unknown) {
  const calls: Array<{ name: string; body: any; bytes: number }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/canvas-catalog\.invalid\//, 'all network stays in the isolated fake provider')
    const body = JSON.parse(String(init.body)), name = body.text?.format?.name
    calls.push({ name, body, bytes: Buffer.byteLength(String(init.body)) })
    let value = generate?.(name, body, calls.filter(call => call.name === name).length)
    if (value === undefined) {
      if (name === 'visual_profile_catalog') value = { profiles: f.catalog }
      else if (name === 'visual_profiles' || name === 'visual_profile_content') {
        const locked = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
        const current = f.profiles.find(item => item.draft_key === locked.draft_key)!
        assert.ok(current, 'each expansion must identify its own directory unit')
        value = name === 'visual_profile_content' ? { definition: current.definition, view_requirements: current.view_requirements, shot_usage: current.shot_usage } : { profiles: [current] }
      } else if (name === 'visual_reference_coverage') value = { visual_coverage: fixtureVisualCoverage(f.profiles, [f.scene], f.shots.map(shot => ({ ...shot, scene_id: f.scene.id, shot_id: shot.id }))) }
      else throw new Error(`unexpected contract ${name}`)
    }
    return Response.json({ output_text: typeof value === 'string' ? value : JSON.stringify(value) })
  })
  return calls
}

test('60fa canvas/prepare catalog contains one scene and five shots without competing full-profile requirements', async t => {
  const f = await fixture()
  const calls = upstream(t, f, (name, body) => {
    if (name !== 'visual_profile_catalog') return
    assert.ok(body.input.includes(f.scene.id))
    for (const shot of f.shots) assert.ok(body.input.includes(shot.id))
    assert.ok(body.input.includes('林晚固定穿蓝色外衣'))
    assert.ok(!body.input.includes('无关背景记录699'), 'catalog must select relevant facts, never repeat the entire project')
    assert.ok(!body.input.includes('每份档案必须用shot_usage'))
    assert.ok(!body.input.includes('逐镜返回visual_coverage'))
    const items = body.text.format.schema.properties.profiles.items
    assert.deepEqual(items.properties.scene_ids.items.enum, [f.scene.id])
    assert.equal(items.properties.scene_ids.minItems, 1)
    assert.ok(!items.properties.definition && !items.properties.shot_usage)
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().profiles.length, 2)
  assert.equal(response.json().visual_coverage.length, 5)
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.bytes < 50000), JSON.stringify(calls.map(call => [call.name, call.bytes])))
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
  const repeated = await f.prepare()
  assert.equal(repeated.statusCode, 200, repeated.body)
  assert.equal(calls.length, 4, 'completed steps are reused')
  t.diagnostic(JSON.stringify({ final_request_bytes: calls.map(call => ({ name: call.name, bytes: call.bytes })) }))
})

test('60fa missing association correction only edits the failed field and retains valid catalog identities across restart', async t => {
  const f = await fixture()
  const raw = JSON.stringify({ profiles: [f.catalog[0], { ...f.catalog[1], scene_ids: null }], system_note: 'test-only-extra-field' })
  const patch = { repairs: { item_1_scene_ids: [f.scene.id] }, remove_root_fields: ['system_note'] }
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return raw
    if (name === 'visual_profile_catalog_local_repair') {
      assert.ok(body.input.includes(f.shots[4].id))
      assert.ok(!body.input.includes('无关背景记录699'))
      assert.deepEqual(Object.keys(body.text.format.schema.properties.repairs.properties), ['item_1_scene_ids'])
      return patch
    }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().profiles.map((item: any) => [item.draft_key, item.scene_ids]), f.catalog.map(item => [item.draft_key, item.scene_ids]))
  const rows = all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
  const privateValues = rows.flatMap(row => Object.entries(JSON.parse(row.payload).steps).filter(([key]) => key.startsWith('response:object-catalog:')).map(([, entry]: any) => entry.value))
  assert.equal(privateValues.length, 1)
  assert.equal(privateValues[0].original_raw, raw)
  assert.deepEqual(JSON.parse(privateValues[0].correction.raw), patch)
  const ledgerUsage = () => all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    .flatMap(row => Object.entries(JSON.parse(row.payload).steps).filter(([key]) => key === 'model_workflow_budget:v1').map(([, entry]: any) => entry.value['model_workflow_budget:v1'].usage))
  const beforeUsage = ledgerUsage()
  assert.equal(beforeUsage.length, 1)
  assert.equal(beforeUsage[0].requests, 5)
  const restarted = buildApp()
  t.after(() => restarted.close())
  const again = await restarted.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`, payload: f.request })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(calls.length, 5)
  assert.deepEqual(ledgerUsage(), beforeUsage, 'restart cannot reset or add charged correction usage')
})

test('60fa null, empty and foreign associations fail with distinct diagnostics and spend no new correction after restart', async t => {
  for (const [association, code] of [[null, 'visual_catalog_missing_scene'], [[], 'visual_catalog_missing_scene'], [['foreign-scene'], 'visual_catalog_scene_out_of_scope']] as const) {
    const f = await fixture()
    const calls = upstream(t, f, name => {
      if (name === 'visual_profile_catalog') return { profiles: [f.catalog[0], { ...f.catalog[1], scene_ids: association }] }
      if (name === 'visual_profile_catalog_local_repair') return { repairs: { item_1_scene_ids: association }, remove_root_fields: [] }
    })
    const first = await f.prepare()
    assert.equal(first.statusCode, 422, first.body)
    assert.match(first.body, new RegExp(code))
    if (code === 'visual_catalog_scene_out_of_scope') assert.ok(first.body.includes(f.scene.heading), 'out-of-scope diagnostics identify the readable legal scene')
    assert.ok(!calls.some(call => call.name === 'visual_profiles' || call.name === 'visual_profile_content'))
    const again = await f.prepare()
    assert.equal(again.statusCode, 422, again.body)
    assert.equal(calls.length, 2, 'exhausted correction cannot be repurchased by refresh')
    t.mock.restoreAll()
  }
})

test('60fa a refusal with an empty catalog gets one selected-scope correction without automatic scene bindings', async t => {
  const f = await fixture()
  const raw = '我没有收到场次信息。\n```json\n' + JSON.stringify({ profiles: [], visual_coverage: [], system_note: '需要补充信息' }) + '\n```'
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return raw
    if (name === 'visual_profile_catalog_local_repair') {
      assert.ok(body.input.includes(f.scene.id) && body.input.includes(f.shots[4].id))
      assert.ok(!body.input.includes('无关背景记录699'))
      return { repairs: { catalog_profiles: f.catalog }, remove_root_fields: ['visual_coverage', 'system_note'] }
    }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(calls.filter(call => call.name.includes('catalog')).length, 2)
  assert.deepEqual(response.json().profiles.map((item: any) => item.scene_ids), f.catalog.map(item => item.scene_ids))
  const again = await f.prepare()
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(calls.length, 5)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
})

test('60fa root extras are removed by an explicit bounded patch without rewriting valid catalog items', async t => {
  const f = await fixture()
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog, visual_coverage: [], system_note: '说明' }
    if (name === 'visual_profile_catalog_local_repair') {
      assert.deepEqual(Object.keys(body.text.format.schema.properties.repairs.properties), [])
      return { repairs: {}, remove_root_fields: ['visual_coverage', 'system_note'] }
    }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().profiles.map(({ draft_key, kind, name, variant, scene_ids }: any) => ({ draft_key, kind, name, variant, scene_ids })), f.catalog)
  assert.equal(calls.length, 5)
})

test('60fa a patch cannot rewrite valid siblings or remove an unresolved object', async t => {
  const f = await fixture()
  const calls = upstream(t, f, name => {
    if (name === 'visual_profile_catalog') return { profiles: [f.catalog[0], { ...f.catalog[1], scene_ids: [] }] }
    if (name === 'visual_profile_catalog_local_repair') return { repairs: { item_1_scene_ids: [f.scene.id], item_0: { ...f.catalog[0], name: '偷改身份' } }, remove_root_fields: [] }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 422, response.body)
  assert.equal(calls.length, 2)
  assert.ok(!calls.some(call => call.name === 'visual_profiles' || call.name === 'visual_profile_content'))
})

test('60fa duplicate identities are object-scope errors and never resolved by silently dropping a catalog item', async t => {
  const f = await fixture()
  const calls = upstream(t, f, name => name === 'visual_profile_catalog' ? { profiles: [f.catalog[0], { ...f.catalog[0], draft_key: 'another-key' }] } : undefined)
  const response = await f.prepare()
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /visual_catalog_object_scope/)
  assert.equal(calls.length, 1)
})

test('60fa final provider transformation dropping selected evidence is stopped before fetch', async t => {
  const f = await fixture(), calls = upstream(t, f)
  const row = all<{ settings: string }>('SELECT settings FROM models WHERE id=?', f.request.model_id)[0]!
  const settings = JSON.parse(row.settings)
  settings.request_template = { model: '{{model}}', input: '错误模板没有prompt槽位' }
  run('UPDATE models SET settings=? WHERE id=?', JSON.stringify(settings), f.request.model_id)
  const response = await f.prepare()
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /visual_input_transport_missing/)
  assert.equal(calls.length, 0)
})

test('60fa confirmed profiles are reused verbatim and only their shot usage is generated', async t => {
  const f = await fixture()
  const saved = await call(`/api/projects/${f.project.id}/visual-profiles`, { profiles: [f.profiles[0]] })
  const own = saved.visual_profiles[0]
  run("UPDATE visual_profiles SET definition_status='ready' WHERE id=?", own.id)
  const checked = await call(`/api/projects/${f.project.id}/script/canvas/check`, { scene_ids: [f.scene.id] })
  f.request.signature = checked.signature
  const before = all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id)
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_usage') {
      assert.ok(body.input.includes(own.definition))
      assert.ok(!body.text.format.schema.properties.profiles)
      return { shot_usage: f.profiles[0]!.shot_usage }
    }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().profiles.find((item: any) => item.name === own.name).definition, own.definition)
  assert.equal(calls.filter(call => call.name === 'visual_profile_usage').length, 1)
  assert.equal(calls.filter(call => call.name === 'visual_profiles' || call.name === 'visual_profile_content').length, 1, 'only the new prop needs full expansion')
  assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id), before)
})

test('60fa large-context derived profiles expand in dependency order and preserve the base state and shot usage', async t => {
  const f = await fixture(), base = { ...f.catalog[0]!, draft_key: 'base' }
  const derived = { ...base, draft_key: 'mud', variant: '手背泥点', base_draft_key: 'base', state_delta: '仅右手背少量泥点' }
  const profiles = [{ ...base, definition: '蓝色夹克、黑色短发，正侧背固定。', view_requirements: '正侧背',
    shot_usage: f.shots.map(shot => ({ shot_id: shot.id, usage: 'none', reference_view: null })) },
  { ...derived, definition: '沿用蓝色夹克和黑色短发，仅右手背泥点。', view_requirements: '正侧背与手背细节',
    shot_usage: f.shots.map(shot => ({ shot_id: shot.id, usage: 'both', reference_view: null })) }]
  const keys: string[] = []
  upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: [derived, base] }
    if (name === 'visual_profiles' || name === 'visual_profile_content') {
      const current = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      keys.push(current.draft_key)
      if (current.draft_key === 'mud') assert.match(body.input, /只读已确认档案与基础版本.*蓝色夹克、黑色短发/)
      const profile = profiles.find(item => item.draft_key === current.draft_key)!
      return name === 'visual_profile_content' ? { definition: profile.definition, view_requirements: profile.view_requirements, shot_usage: profile.shot_usage } : { profiles: [profile] }
    }
    if (name === 'visual_reference_coverage') return { visual_coverage: fixtureVisualCoverage(profiles, [f.scene], f.shots.map(shot => ({ ...shot, scene_id: f.scene.id, shot_id: shot.id }))) }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(keys, ['base', 'mud'])
  const result = response.json().profiles
  assert.equal(result.find((item: any) => item.draft_key === 'mud').base_draft_key, 'base')
  assert.equal(result.find((item: any) => item.draft_key === 'mud').state_delta, derived.state_delta)
  assert.ok(result.find((item: any) => item.draft_key === 'base').shot_usage.every((item: any) => item.usage === 'none'))
})

test('60fa large-context design scopes exclude historical profiles and reject cross-design bases', async t => {
  const f = await fixture()
  const previous = await call(`/api/projects/${f.project.id}/visual-profiles`, { profiles: [{ ...f.profiles[0], definition: 'HISTORY_REF_ONLY不可沿用形象' }] })
  const historical = previous.visual_profiles[0], designId = `design-${f.project.id}`
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)', designId, f.project.id, '独立蓝白方案', JSON.stringify([f.scene.id]), '蓝白新形象', now())
  run('UPDATE shots SET design_id=? WHERE project_id=?', designId, f.project.id)
  f.request.signature = (await call(`/api/projects/${f.project.id}/script/canvas/check`, { scene_ids: [f.scene.id] })).signature
  const calls = upstream(t, f, (_name, body) => {
    assert.ok(!body.input.includes(historical.id))
    assert.ok(!body.input.includes('HISTORY_REF_ONLY'))
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(response.json().profiles.every((item: any) => item.design_id === designId))
  assert.equal(calls.length, 4)
  // A source change requires an explicit isolated restart; the original
  // cumulative ledger remains authoritative and historical bases stay invalid.
  run('UPDATE shots SET video_prompt=? WHERE id=?', '林晚放下铜钥匙，然后转身。', f.shots[0].id)
  f.request.signature = (await call(`/api/projects/${f.project.id}/script/canvas/check`, { scene_ids: [f.scene.id] })).signature
  t.mock.restoreAll()
  const badCalls = upstream(t, f, name => name === 'visual_profile_catalog' ? { profiles: [{ ...f.catalog[0], base_profile_id: historical.id, state_delta: '换白衣' }] } : undefined)
  const recovery = await call(`/api/projects/${f.project.id}/script/canvas/recovery`, { scene_ids: [f.scene.id] })
  const bad = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`,
    payload: { ...f.request, request_id: randomUUID(), restart_from_run_id: recovery.preparation.run_id } })
  assert.equal(bad.statusCode, 422, bad.body)
  assert.match(bad.body, /visual_catalog_object_scope/)
  assert.equal(badCalls.length, 1)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 1)
})


test('dccd canvas prepare persists an audited eight-item dialect candidate and buys only one field correction across restart', async t => {
  const f = await fixture()
  f.catalog.push(...Array.from({ length: 6 }, (_, index) => ({ draft_key: `prop_${index}`, kind: 'prop', name: `已出镜物件${index}`, variant: '默认', scene_ids: [f.scene.id] })))
  f.profiles = f.catalog.map(item => ({ ...item, definition: '明确已出镜的固定形状与材质。', view_requirements: '正侧背与局部',
    shot_usage: f.shots.map(shot => ({ shot_id: shot.id, usage: 'both', reference_view: null })) }))
  const dialect = f.catalog.map((item, index) => ({ draft_key: item.draft_key, category: item.kind, name_zh: item.name, name_en: null,
    prompt_names: item.name, definition: index === 2 ? '标记写着“已确认”。' : '固定外观', scene_ids: item.scene_ids }))
  const raw = '```json\n' + JSON.stringify({ profiles: dialect }, null, 2).replace('“已确认”', '"已确认"') + '\n```'
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return raw
    if (name === 'visual_profile_catalog_local_repair') {
      const repairs: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(body.text.format.schema.properties.repairs.properties) as Array<[string, any]>) {
        const index = Number(key.split('_')[1])
        if (key.endsWith('_remove_fields')) repairs[key] = value.prefixItems.map((item: any) => item.const)
        else if (key.endsWith('_fields')) repairs[key] = Object.fromEntries(Object.keys(value.properties).map(field => [field, (f.catalog[index] as any)[field]]))
        else throw new Error('unexpected catalog repair target')
      }
      return { repairs, remove_root_fields: [] }
    }
  })
  const result = await f.prepare()
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().profiles.length, 8)
  assert.equal(calls.length, 11)
  const payloads = all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id).map(row => JSON.parse(row.payload))
  const values = payloads.flatMap(row => Object.entries(row.steps).filter(([key]) => key.startsWith('response:object-catalog:')).map(([, entry]: any) => entry.value))
  assert.equal(values.length, 1)
  assert.equal(values[0].original_raw, raw)
  assert.equal(values[0].correction_candidate.candidate.profiles.length, 8)
  assert.equal(values[0].correction_candidate.escape_offsets.length, 2)
  assert.ok(values[0].correction.raw)
  const usage = () => all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    .flatMap(row => Object.entries(JSON.parse(row.payload).steps).filter(([key]) => key === 'model_workflow_budget:v1').map(([, entry]: any) => entry.value['model_workflow_budget:v1'].usage))
  const before = usage(); assert.equal(before[0].requests, 11)
  const restarted = buildApp(); t.after(() => restarted.close())
  const replay = await restarted.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`, payload: f.request })
  assert.equal(replay.statusCode, 200, replay.body)
  assert.equal(calls.length, 11)
  assert.deepEqual(usage(), before)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.project.id).length, 0)
})

test('2317 final coverage transport uses its own small schema and excludes profiles, views, skills and world context', async t => {
  const f = await fixture(), calls = upstream(t, f)
  const response = await f.prepare(); assert.equal(response.statusCode, 200, response.body)
  const call = calls.find(call => call.name === 'visual_reference_coverage')!
  assert.ok(call)
  const schema = call.body.text.format.schema
  assert.deepEqual(Object.keys(schema.properties), ['visual_coverage'])
  assert.equal(schema.properties.visual_coverage.items.properties.no_reference_reason.type, 'string')
  assert.ok(!Object.hasOwn(schema.properties.visual_coverage.items.properties.objects.items.properties, 'reference_view'))
  assert.ok(!call.body.input.includes(f.background))
  assert.ok(!call.body.input.includes('林晚固定穿蓝色外衣'))
  assert.ok(!call.body.input.includes('已完成档案身份及用途'))
  assert.ok(call.bytes < 30000, 'final fake-provider wire body remains bounded to selected shots and identity index')
})


test('a current-scope update reuses unaffected scene objects and regenerates only changed shot associations', async t => {
  const f = await fixture()
  const secondScene = await call(`/api/projects/${f.project.id}/script/scenes`, { heading: '空房间', location: '空房间', action: '台灯亮起', episode_number: 1 })
  const secondShot = await call(`/api/projects/${f.project.id}/shots`, { title: '台灯', source_scene_id: secondScene.id, image_prompt: '房间里台灯亮起', video_prompt: '台灯保持明亮', duration: 3 })
  const item = { draft_key: 'lamp', kind: 'prop', name: '台灯', variant: '默认', scene_ids: [secondScene.id] }
  f.catalog.push(item)
  f.profiles.push({ ...item, definition: '绿色灯罩、黄铜灯座。', view_requirements: '正侧细节', shot_usage: [{ shot_id: secondShot.id, usage: 'both', reference_view: null }] })
  const scenes = [f.scene, secondScene], shots = [...f.shots, secondShot]
  const calls = upstream(t, f, name => name === 'visual_reference_coverage'
    ? { visual_coverage: fixtureVisualCoverage(f.profiles, scenes, shots.map(shot => ({ ...shot, scene_id: shot.source_scene_id, shot_id: shot.id }))) } : undefined)
  const scope = { scene_ids: scenes.map(scene => scene.id) }, url = `/api/projects/${f.project.id}/script/canvas/`
  const check = await call(url + 'check', scope)
  const initial = await call(url + 'prepare', { ...scope, signature: check.signature, model_id: f.request.model_id, skill_ids: [] })
  assert.equal(initial.status, 'complete')
  assert.equal(calls.filter(call => call.name === 'visual_profile_content').length, 3)
  run('UPDATE shots SET video_prompt=? WHERE id=?', '台灯熄灭后又亮起', secondShot.id)
  const next = await call(url + 'check', scope), previousCount = calls.length
  const updated = await call(url + 'prepare', { ...scope, signature: next.signature, model_id: f.request.model_id, skill_ids: [],
    request_id: randomUUID(), prepare_current_from_run_id: initial.preparation.run_id })
  assert.equal(updated.status, 'complete')
  const expansions = calls.slice(previousCount).filter(call => call.name === 'visual_profile_content')
  assert.equal(expansions.length, 1, 'unaffected character and prop in the first scene are reused')
  assert.match(expansions[0]!.body.input, /"draft_key":"lamp"/)
  assert.deepEqual(updated.profiles.filter((p: any) => p.draft_key !== 'lamp'), initial.profiles.filter((p: any) => p.draft_key !== 'lamp'))
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0, 'preparation alone still does not adopt business content')
})
