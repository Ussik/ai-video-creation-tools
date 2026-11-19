import assert from 'node:assert/strict'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fixtureVisualCoverage } from './helpers/visual-coverage.js'

const dir = await mkdtemp(join(tmpdir(), 'canvas-unit-f563-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { buildApp } = await import('../src/app.js')
const { db, all, run, now } = await import('../src/infrastructure/database/db.js')
const incidentResponses = JSON.parse(await readFile(new URL('./fixtures/visual-profile-2236.json', import.meta.url), 'utf8')) as Array<{ raw: string; source_sha256: string }>
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
function upstream(t: TestContext, f: Fixture, generate?: (name: string, body: any, count: number) => unknown) {
  const calls: Array<{ name: string; body: any; bytes: number }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/canvas-catalog\.invalid\//, 'all network stays in the isolated fake provider')
    const body = JSON.parse(String(init.body)), name = body.text?.format?.name
    calls.push({ name, body, bytes: Buffer.byteLength(String(init.body)) })
    let value = generate?.(name, body, calls.filter(call => call.name === name).length)
    if (value === undefined) {
      if (name === 'visual_profile_catalog') value = { profiles: f.catalog }
      else if (name === 'visual_profiles') {
        const current = f.profiles.find(item => body.input.includes(`"draft_key":"${item.draft_key}"`))!
        assert.ok(current, 'each expansion must identify its own directory unit')
        value = { profiles: [current] }
      } else if (name === 'visual_reference_coverage') value = { visual_coverage: fixtureVisualCoverage(f.profiles, [f.scene], f.shots.map(shot => ({ ...shot, scene_id: f.scene.id, shot_id: shot.id }))) }
      else throw new Error(`unexpected contract ${name}`)
    }
    return Response.json({ output_text: typeof value === 'string' ? value : JSON.stringify(value) })
  })
  return calls
}


function fixedValue(node: any): any {
  if (Object.hasOwn(node, 'const')) return node.const
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties || {}).map(([key, value]) => [key, fixedValue(value)]))
  if (node.type === 'array' && node.prefixItems) return node.prefixItems.map(fixedValue)
  if (node.type === 'array' && node.maxItems === 0) return []
  throw new Error('patch must contain only code-owned fixed format values')
}

test('f563 canvas expansion corrects bare look format without rewriting locked delta or legal content', async t => {
  const f = await fixture()
  const base = { ...f.catalog[0]!, draft_key: 'BASE', base_profile_id: null, base_draft_key: null, state_delta: '' }
  const look = { ...base, draft_key: 'LOOK', variant: '深色外衣', base_draft_key: 'BASE', state_delta: '深色外衣：立领、暗扣；手持掌心大小铜质圆牌。' }
  f.catalog = [base, look, f.catalog[1]!]
  f.profiles = f.catalog.map(item => ({ ...item, definition: '  沿用已确认基础外形与配色，仅应用锁定目录中的明确变化。\n',
    view_requirements: '\t正侧背、衣领与圆牌细节。  ', shot_usage: f.shots.map(shot => ({ shot_id: shot.id, usage: 'both', reference_view: null })) }))
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog }
    if (name === 'visual_profiles' || name === 'visual_profile_content') {
      const locked = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      const item = f.profiles.find(profile => profile.draft_key === locked.draft_key)!
      assert.ok(item)
      if (item.draft_key === 'LOOK') return name === 'visual_profiles' && body.input.includes('【一次格式修正】')
        ? { profiles: [{ ...item, state_delta: '立领竖起、暗扣全扣；新增黑布绳。' }] } : { ...item, kind: 'look' }
      return name === 'visual_profile_content' ? { definition: item.definition, view_requirements: item.view_requirements, shot_usage: item.shot_usage } : { profiles: [item] }
    }
    if (name === 'visual_profile_content_local_repair') {
      assert.ok(!body.input.includes(f.profiles[1]!.definition), 'format-only correction must not resend the legal definition')
      assert.deepEqual(Object.keys(body.text.format.schema.properties.repairs.properties), [])
      return fixedValue(body.text.format.schema)
    }
    if (name === 'visual_profiles') throw new Error('unreachable')
  })
  t.after(() => t.diagnostic(JSON.stringify({ captured_request_bytes: calls.map(call => ({ name: call.name, bytes: call.bytes })) })))
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json().profiles
  assert.equal(result.find((item: any) => item.draft_key === 'LOOK').state_delta, look.state_delta)
  assert.equal(result.find((item: any) => item.draft_key === 'LOOK').definition, f.profiles[1]!.definition)
  assert.equal(result.find((item: any) => item.draft_key === 'LOOK').view_requirements, f.profiles[1]!.view_requirements)
  assert.equal(result.find((item: any) => item.draft_key === 'LOOK').base_draft_key, 'BASE')
  assert.equal(calls.filter(call => call.name.endsWith('_local_repair')).length, 1)
  assert.ok(calls.filter(call => call.name === 'visual_profile_content').every(call => !call.body.text.format.schema.properties.state_delta))
  const before = calls.length
  const restarted = buildApp(); t.after(() => restarted.close())
  const again = await restarted.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`, payload: f.request })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(calls.length, before)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id).length, 0)
  t.diagnostic(JSON.stringify({ request_bytes: calls.map(call => ({ name: call.name, bytes: call.bytes })) }))
})

test('f563 explicit locked fact conflicts fail with unit path and hashes and never get overwritten or repurchased', async t => {
  const f = await fixture()
  const base = { ...f.catalog[0]!, draft_key: 'BASE' }
  const look = { ...base, draft_key: 'LOOK', variant: '深色外衣', base_draft_key: 'BASE', state_delta: '立领、暗扣' }
  f.catalog = [base, look]
  f.profiles = f.catalog.map(item => ({ ...item, definition: '合法基础设计', view_requirements: '正侧背', shot_usage: f.profiles[0]!.shot_usage }))
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog }
    if (name === 'visual_profile_content' || name === 'visual_profiles') {
      const locked = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      const item = f.profiles.find(profile => profile.draft_key === locked.draft_key)!
      if (item.draft_key === 'LOOK') return { ...item, state_delta: '立领竖起、暗扣全扣', definition: '新增青铜与黑布绳，木梆15厘米。' }
      return name === 'visual_profile_content' ? { definition: item.definition, view_requirements: item.view_requirements, shot_usage: item.shot_usage } : { profiles: [item] }
    }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().status, 'partial')
  assert.equal(response.json().failed_units[0].unit_key, 'LOOK')
  assert.equal(response.json().failed_units[0].code, 'visual_profile_locked_field_changed')
  assert.match(response.body, /LOOK/)
  assert.equal(calls.filter(call => call.name.endsWith('_local_repair')).length, 0)
  const before = calls.length
  const again = await f.prepare()
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().status, 'partial')
  assert.equal(again.json().failed_units[0].retryable, false)
  assert.equal(calls.length, before)
  const checkpoint = all<{payload: string}>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id).map(row => JSON.parse(row.payload))
  assert.ok(checkpoint.some(row => Object.entries(row.steps).some(([key, entry]: any) => key.startsWith('unit:') && entry.value.draft_key === 'BASE')))
})



for (const [incident, fixtureResponse] of incidentResponses.entries()) test(`2236 captured anonymous answer ${incident + 1}: two settled failures retain legal retries, patch only bad fields and never repay duplicate intents`, async t => {
  const f = await fixture(); f.catalog = [f.catalog[1]!]; f.profiles = [f.profiles[1]!]
  let raw = fixtureResponse.raw
  for (let i = 0; i < f.shots.length; i++) raw = raw.replaceAll('shot-' + (i + 1), f.shots[i]!.id)
  f.profiles[0]!.shot_usage = JSON.parse(raw.replace(/^```json\s*|\s*```$/gu, '')).shot_usage.map((row: any) => ({ shot_id: row.shot_id, usage: row.usage_type, reference_view: null }))
  let repairs = 0
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog }
    if (name === 'visual_profile_content') return raw
    if (name === 'visual_profile_content_local_repair') {
      repairs++
      assert.ok(!body.input.includes('已确认道具外观、颜色和材质保持一致。'), 'valid definition is retained locally, never sent for rewriting')
      assert.ok(!body.text.format.schema.properties.repairs.properties.definition)
      if (repairs < 3) return { repairs: { view_requirements: [] } }
      const target = body.text.format.schema.properties.repairs.properties
      const patch: any = {}
      for (const [key, spec] of Object.entries<any>(target)) {
        if (key === 'view_requirements') patch[key] = '正侧背与局部细节，保持原设计事实。'
        else if (spec.type === 'object') patch[key] = Object.fromEntries(Object.entries<any>(spec.properties).map(([field, rule]) =>
          [field, Object.hasOwn(rule, 'const') ? rule.const : field === 'reference_view' ? 'detail' : rule.enum?.[0]]))
        else patch[key] = 'detail'
      }
      const adjudications = body.text.format.schema.properties.field_adjudications?.properties
      const field_adjudications = adjudications ? Object.fromEntries(Object.entries<any>(adjudications).map(([key, value]) => [key,
        Object.fromEntries(Object.entries<any>(value.properties).map(([field, spec]) => [field, { source_hash: spec.properties.source_hash.const,
          resolution: 'represented_by_usage', explanation: '已根据原行说明核对本镜用途，保留合法用途并按证据修正视角。' }]))])) : undefined
      return { repairs: patch, ...(field_adjudications ? { field_adjudications } : {}) }
    }
  })
  const initial = await f.prepare(); assert.equal(initial.statusCode, 200, initial.body)
  let unit = initial.json().failed_units[0]
  const preserved = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    .flatMap(row => Object.entries<any>(JSON.parse(row.payload).steps).filter(([key]) => key.startsWith('response:unit:')).map(([key, entry]) => ({ namespace: row.namespace, identity_hash: row.identity_hash, key, entry })))
  const url = `/api/projects/${f.project.id}/script/canvas/prepare`
  for (let attempt = 2; attempt <= 3; attempt++) {
    assert.equal(unit.recovery.action, 'retry', JSON.stringify(unit))
    const payload = { ...f.request, unit_keys: [unit.unit_key], retry_unit: { unit_key: unit.unit_key, token: unit.recovery.token } }
    const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body)
    const count = calls.length
    const duplicate = await app.inject({ method: 'POST', url, payload }); assert.equal(duplicate.statusCode, 200, duplicate.body)
    assert.equal(calls.length, count, 'identical explicit attempt cannot purchase another patch')
    if (attempt === 2) {
      unit = response.json().failed_units[0]; assert.equal(unit.recovery.action, 'retry')
      assert.notEqual(unit.recovery.token, payload.retry_unit.token)
      // Reproduce an old one-shot UI failure without changing raw responses:
      // a read-only status lookup must derive the current legal next token.
      const rows = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
      const row = rows.find(row => row.namespace.startsWith('canvas-preparation-runs:'))!, state = JSON.parse(row.payload)
      const manifest = state.steps.manifest.value, plan = manifest.runs.find((r: any) => r.id === manifest.active).plan
      plan.failed_units[0].recovery = { action: 'inspect', model_call: 'unknown' }
      run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(state), f.project.id, row.namespace, row.identity_hash)
      const recovery = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/recovery`, payload: { scene_ids: [f.scene.id] } })
      assert.equal(recovery.statusCode, 200, recovery.body)
      assert.equal(recovery.json().plan.failed_units[0].recovery.token, unit.recovery.token)
      assert.equal(calls.length, count)
    } else {
      assert.equal(response.json().status, 'complete', response.body)
      assert.equal(response.json().profiles[0].definition, '已确认道具外观、颜色和材质保持一致。')
      assert.ok(response.json().profiles[0].shot_usage.every((row: any) => row.reference_view === 'detail' || row.reference_view === null))
    }
  }
  assert.equal(calls.filter(call => call.name === 'visual_profile_content').length, 1, 'explicit retries reuse the complete candidate and buy only local patches')
  assert.equal(repairs, 3)
  for (const saved of preserved) {
    const row = all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=? AND identity_hash=?', f.project.id, saved.namespace, saved.identity_hash)[0]!
    assert.deepEqual(JSON.parse(row.payload).steps[saved.key], saved.entry)
  }
})

test('a newer explicit patch with unknown delivery fences off the older settled retry after status refresh', async t => {
  const f = await fixture(); f.catalog = [f.catalog[1]!]; f.profiles = [f.profiles[1]!]
  let repairs = 0
  const calls = upstream(t, f, name => {
    if (name === 'visual_profile_content') return { definition: '合法固定设计', view_requirements: {}, shot_usage: f.profiles[0]!.shot_usage }
    if (name === 'visual_profile_content_local_repair') {
      if (++repairs === 3) throw new TypeError('fixture connection lost after dispatch')
      return { repairs: { view_requirements: [] } }
    }
  })
  const first = await f.prepare(); assert.equal(first.statusCode, 200, first.body)
  let unit = first.json().failed_units[0], lastPayload: any
  for (let i = 0; i < 2; i++) {
    assert.equal(unit.recovery.action, 'retry')
    lastPayload = { ...f.request, unit_keys: [unit.unit_key], retry_unit: { unit_key: unit.unit_key, token: unit.recovery.token } }
    const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`, payload: lastPayload })
    assert.equal(response.statusCode, i === 0 ? 200 : 502, response.body)
    if (i === 0) unit = response.json().failed_units[0]
    else assert.equal(response.json().outcome_certainty, 'unknown')
  }
  const count = calls.length
  const restarted = buildApp(); t.after(() => restarted.close())
  const status = await restarted.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/recovery`, payload: { scene_ids: [f.scene.id] } })
  assert.equal(status.statusCode, 200, status.body)
  assert.notEqual(status.json().plan.failed_units[0].recovery.action, 'retry', 'unknown latest delivery cannot resurrect an older next-token')
  await restarted.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/canvas/prepare`, payload: lastPayload })
  assert.equal(calls.length, count)
})

test('object-only retry preserves validated siblings, unrelated failures, keys and original paid responses', async t => {
  const f = await fixture()
  const keys = ['PROP-FRIED-NOODLE', 'PROP-BRONZE-GONG', 'PROP-WOOD-CLAPPER']
  f.catalog = keys.map((draft_key, i) => ({ ...f.catalog[1]!, draft_key, name: ['炒面', '铜锣', '木梆'][i]! }))
  f.profiles = f.catalog.map(item => ({ ...item, definition: '固定材质与外形', view_requirements: '正侧背与细节', shot_usage: f.profiles[0]!.shot_usage }))
  const counts = new Map<string, number>()
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog }
    if (name === 'visual_profile_content') {
      const locked = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      const item = f.profiles.find(profile => profile.draft_key === locked.draft_key)!
      const count = (counts.get(item.draft_key) || 0) + 1; counts.set(item.draft_key, count)
      return item.draft_key !== keys[1] && count === 1 ? { ...item, state_delta: '新增未确认变化' }
        : { definition: item.definition, view_requirements: item.view_requirements, shot_usage: item.shot_usage }
    }
  })
  const initial = await f.prepare()
  assert.equal(initial.statusCode, 200, initial.body)
  const partial = initial.json()
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.profiles.map((p: any) => p.draft_key), [keys[1]])
  assert.deepEqual(partial.failed_units.map((u: any) => u.unit_key), [keys[0], keys[2]])
  const retry = partial.failed_units[0].recovery
  assert.equal(retry.action, 'retry')
  assert.equal(retry.model_call, 'required')
  assert.match(retry.token, /^[a-f0-9]{64}$/)
  const before = calls.length
  const oldResponses = all<{payload: string}>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id)
    .flatMap(row => Object.entries(JSON.parse(row.payload).steps)).filter(([key]) => key.startsWith('response:unit:'))
  const payload = { ...f.request, unit_keys: [keys[0]], retry_unit: { unit_key: keys[0], token: retry.token } }
  const response = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().status, 'partial', 'unselected failures cannot disappear')
  assert.deepEqual(response.json().profiles.map((p: any) => p.draft_key), [keys[0], keys[1]])
  assert.deepEqual(response.json().failed_units.map((u: any) => u.unit_key), [keys[2]])
  assert.deepEqual(calls.slice(before).map(call => call.name), ['visual_profile_content'])
  assert.equal(counts.get(keys[1]!), 1)
  assert.equal(counts.get(keys[2]!), 1)
  const again = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(calls.length, before + 1, 'the same retry token must be idempotent')
  const latest = all<{payload: string}>('SELECT payload FROM model_unit_checkpoints WHERE project_id=?', f.project.id).flatMap(row => Object.entries(JSON.parse(row.payload).steps))
  for (const [key, value] of oldResponses) assert.deepEqual(latest.find(([id]) => id === key)?.[1], value, 'original response stays immutable')
  const skipBefore = calls.length
  const skipped = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: { ...f.request, skip_unit_keys: [keys[2]] } })
  assert.equal(skipped.statusCode, 200, skipped.body)
  assert.equal(skipped.json().status, 'partial')
  assert.equal(calls.length, skipBefore, 'skipping must never dispatch provider calls')
  const empty = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: { ...f.request, unit_keys: [] } })
  assert.equal(empty.statusCode, 422, empty.body)
  assert.equal(calls.length, skipBefore)
  const badScope = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: { ...f.request, unit_keys: ['unknown-object'] } })
  assert.equal(badScope.statusCode, 422, badScope.body)
  const badCoverageScope = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: { ...f.request, unit_keys: ['@appearance:not-a-selected-shot'] } })
  assert.equal(badCoverageScope.statusCode, 422, badCoverageScope.body)
  assert.equal(calls.length, skipBefore)
})

test('settled object failures offer a versioned next attempt; spent intents never repurchase and the finite cap has a precise reason', async t => {
  const f = await fixture()
  f.catalog = [f.catalog[0]!]; f.profiles = [f.profiles[0]!]
  const calls = upstream(t, f, (name) => name === 'visual_profile_content' ? { ...f.profiles[0], state_delta: '未确认的变化' } : undefined)
  const first = await f.prepare()
  assert.equal(first.statusCode, 200, first.body)
  let unit = first.json().failed_units[0]
  const payloads: any[] = []
  for (let attempt = 2; attempt <= 4; attempt++) {
    assert.equal(unit.recovery.action, 'retry')
    const payload = { ...f.request, unit_keys: [unit.unit_key], retry_unit: { unit_key: unit.unit_key, token: unit.recovery.token } }
    payloads.push(payload)
    const retry = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload })
    assert.equal(retry.statusCode, 200, retry.body)
    unit = retry.json().failed_units[0]
    assert.equal(unit.recovery.model_call, attempt < 4 ? 'required' : 'none')
    if (attempt < 4) assert.notEqual(unit.recovery.token, payload.retry_unit.token)
  }
  assert.equal(unit.recovery.action, 'none'); assert.match(unit.recovery.reason, /4\/4.*剩余额度/)
  const before = calls.length
  const restarted = buildApp(); t.after(() => restarted.close())
  for (const input of [f.request, ...payloads, { ...payloads[0], retry_unit: { unit_key: unit.unit_key, token: '0'.repeat(64) } }]) {
    const again = await restarted.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: input })
    assert.equal(again.statusCode, 200, again.body)
    assert.equal(again.json().status, 'partial')
    assert.equal(calls.length, before)
  }
})

test('scoped continuation reuses bases and completes only necessary dependencies before coverage', async t => {
  const f = await fixture()
  const base = { ...f.catalog[0]!, draft_key: 'BASE' }
  const look = { ...base, draft_key: 'LOOK', variant: '泥点状态', base_draft_key: 'BASE', state_delta: '右手背少量泥点' }
  f.catalog = [base, look, f.catalog[1]!]
  f.profiles = f.catalog.map(item => ({ ...item, definition: '固定外形与配色', view_requirements: '正侧背', shot_usage: f.profiles[0]!.shot_usage }))
  const expanded: string[] = []
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_content') {
      const locked = JSON.parse(body.input.split('锁定目录项（不得更改身份、场次或基础关系）：')[1].split('\n')[0])
      const item = f.profiles.find(profile => profile.draft_key === locked.draft_key)!
      expanded.push(item.draft_key)
      if (item.draft_key === 'BASE' && expanded.filter(key => key === 'BASE').length === 1) return { ...item, state_delta: '不允许的变化' }
      return { definition: item.definition, view_requirements: item.view_requirements, shot_usage: item.shot_usage }
    }
  })
  const initial = await f.prepare()
  assert.equal(initial.statusCode, 200, initial.body)
  const failure = initial.json().failed_units.find((u: any) => u.unit_key === 'BASE')
  assert.equal(initial.json().failed_units.find((u: any) => u.unit_key === 'LOOK').code, 'visual_profile_dependency_blocked')
  const url = '/api/projects/' + f.project.id + '/script/canvas/prepare'
  const retry = await app.inject({ method: 'POST', url, payload: { ...f.request, unit_keys: ['BASE'], retry_unit: { unit_key: 'BASE', token: failure.recovery.token } } })
  assert.equal(retry.statusCode, 200, retry.body)
  assert.equal(retry.json().status, 'complete')
  assert.ok(expanded.includes('LOOK'), 'a previously blocked child resumes after its selected base succeeds')
  const complete = await app.inject({ method: 'POST', url, payload: { ...f.request, unit_keys: ['LOOK'] } })
  assert.equal(complete.statusCode, 200, complete.body)
  assert.equal(complete.json().status, 'complete')
  assert.deepEqual(expanded, ['BASE', 'key', 'BASE', 'LOOK'])
  assert.equal(complete.json().profiles.length, 3)
  assert.equal(calls.filter(call => call.name === 'visual_reference_coverage').length, 1)
  const before = calls.length
  const skipComplete = await app.inject({ method: 'POST', url, payload: { ...f.request, skip_unit_keys: ['BASE'] } })
  assert.equal(skipComplete.statusCode, 200, skipComplete.body)
  assert.equal(skipComplete.json().status, 'partial')
  assert.equal(calls.length, before)
})

test('skip or continuation without saved context never selects skills or generates a new catalog', async t => {
  const f = await fixture()
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call a provider') })
  for (const scope of [{ skip_unit_keys: ['actor'] }, { unit_keys: ['actor'] }]) {
    const response = await app.inject({ method: 'POST', url: '/api/projects/' + f.project.id + '/script/canvas/prepare', payload: { ...f.request, ...scope } })
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().code, 'visual_profile_resume_context_missing')
  }
})
const { assertVisualProfileLock, visualProfileContentRepair, generateVisualProfileUnit } = await import('../src/modules/visuals/visual-profile-unit.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { generateStructuredOutput } = await import('../src/modules/generation/model-output.js')
const locked = { draft_key: 'LOOK-LOCK', kind: 'character', name: '隔离人物', variant: '外衣', scene_ids: ['s1', 's2'], base_draft_key: 'BASE-LOCK', state_delta: '立领、暗扣\n仅局部变化' }
const contentSchema = z.object({ definition: z.string().min(1), view_requirements: z.string().min(1), shot_usage: z.array(z.object({ shot_id: z.enum(['q1', 'q2']), usage: z.enum(['both', 'none']), reference_view: z.string().nullable() }).strict()).length(2) }).strict()
const legalContent = { definition: '合法正文逐字保留，“引号”和\n换行。', view_requirements: '合法视图逐字保留', shot_usage: [{ shot_id: 'q1' as const, usage: 'both' as const, reference_view: null }, { shot_id: 'q2' as const, usage: 'none' as const, reference_view: null }] }
const fullSchema = z.object({ ...contentSchema.shape, draft_key: z.literal(locked.draft_key), kind: z.literal(locked.kind), name: z.literal(locked.name), variant: z.literal(locked.variant), scene_ids: z.array(z.string()), base_draft_key: z.string().nullable().optional(), base_profile_id: z.string().nullable().optional(), state_delta: z.string().optional() }).strict()
const legacySchema = z.object({ profiles: z.array(fullSchema).length(1) }).strict()

test('extra shot fields require source-bound semantic adjudication and cannot rewrite legal sibling fields', () => {
  const candidate = { ...legalContent, shot_usage: [{ ...legalContent.shot_usage[0]!, note: '手持状态是既定事实', visual_priority: 'high' }, legalContent.shot_usage[1]!] }
  const planner = visualProfileContentRepair(locked, contentSchema, '锁定事实')
  const plan = planner(candidate, { issues: [] })!
  assert.ok(plan)
  const row = { ...legalContent.shot_usage[0]! }
  assert.throws(() => plan.apply({ repairs: { shot_usage_0: row } }), /field_adjudications/)
  const fields = (z.toJSONSchema(plan.schema) as any).properties.field_adjudications.properties.shot_usage_0.properties
  const field_adjudications = { shot_usage_0: Object.fromEntries(Object.entries<any>(fields).map(([key, spec]) => [key, {
    source_hash: spec.properties.source_hash.const, resolution: 'represented_by_usage', explanation: '保留本镜既定用途，原手持说明已按镜头证据核对。',
  }])) }
  assert.throws(() => plan.apply({ repairs: { shot_usage_0: { ...row, usage: 'none' } }, field_adjudications }))
  const patched = plan.apply({ repairs: { shot_usage_0: row }, field_adjudications })
  assert.deepEqual(patched, legalContent)
  assert.ok(Object.hasOwn(candidate.shot_usage[0]!, 'note'), 'source extra fields remain intact')
  assert.equal(planner({ ...candidate, shot_usage: [{ ...candidate.shot_usage[0], usage_type: 'none' }, candidate.shot_usage[1]] }, { issues: [] }), undefined)
})

test('f563 lock checks independent/derived null-optionals, complete scene sets and exact delta bytes before normalization', () => {
  const independent = { ...locked, base_draft_key: null, state_delta: '' }
  assert.doesNotThrow(() => assertVisualProfileLock({ ...independent, base_profile_id: null, base_draft_key: undefined, state_delta: undefined, scene_ids: ['s2', 's1'] }, independent))
  assert.doesNotThrow(() => assertVisualProfileLock({ ...independent, state_delta: null }, independent))
  assert.doesNotThrow(() => assertVisualProfileLock({ ...locked, base_profile_id: null }, locked))
  assert.doesNotThrow(() => assertVisualProfileLock({ ...locked, base_draft_key: null, base_profile_id: 'saved-base' }, { ...locked, base_draft_key: null, base_profile_id: 'saved-base' }))
  for (const change of [{ state_delta: locked.state_delta + ' ' }, { state_delta: '立领竖起、暗扣全扣' }, { state_delta: null }, { scene_ids: ['s1'] }, { scene_ids: ['s1', 's1'] }, { scene_ids: ['s1', 's2', 'foreign'] }, { base_draft_key: 'another-base' }, { name: '别的人物' }]) {
    assert.throws(() => assertVisualProfileLock({ ...locked, ...change }, locked), (error: any) => {
      const detail = JSON.parse(error.diagnostics)
      assert.equal(detail.stage, 'profile_expansion'); assert.equal(detail.unit.draft_key, locked.draft_key)
      assert.match(detail.differences[0].before_hash, /^[a-f0-9]{64}$/)
      assert.notEqual(detail.differences[0].before_hash, detail.differences[0].after_hash)
      return error.code === 'visual_profile_locked_field_changed'
    })
  }
})

test('f563 one missing content field repairs only its path and cannot overwrite valid prose or usage siblings', () => {
  const candidate = { ...legalContent, view_requirements: '' }
  const plan = visualProfileContentRepair(locked, contentSchema, '锁定事实和基础设计、项目画风', '完整镜头证据')(candidate, { issues: [] })!
  assert.ok(plan)
  assert.ok(!plan.prompt.includes(legalContent.definition))
  const result = plan.apply({ repairs: { view_requirements: '只补正缺失视图' } }) as any
  assert.equal(result.definition, candidate.definition)
  assert.deepEqual(result.shot_usage, candidate.shot_usage)
  assert.throws(() => plan.apply({ repairs: { view_requirements: '补正', definition: '偷改' } }))
  assert.throws(() => plan.apply({ repairs: { view_requirements: '补正' }, state_delta: '偷改' }))
})

test('f563 per-shot format patch preserves legal shot siblings and rejects a full-profile patch', () => {
  const candidate = { ...legalContent, shot_usage: [{ ...legalContent.shot_usage[0]!, usage: 'illegal' }, legalContent.shot_usage[1]!] }
  const plan = visualProfileContentRepair(locked, contentSchema, '只读事实')(candidate, { issues: [] })!
  assert.ok(plan)
  const result = plan.apply({ repairs: { shot_usage_0_usage: 'both' } }) as any
  assert.deepEqual(result, legalContent)
  assert.throws(() => plan.apply({ repairs: { shot_usage_0_usage: 'both', shot_usage: [] } }))
})

test('f563 echoed conflicting facts cannot be dropped by a format patch, and extra envelope siblings cannot disappear', () => {
  const planner = visualProfileContentRepair(locked, contentSchema, '只读事实')
  assert.throws(() => planner({ ...legalContent, state_delta: '立领竖起；新增青铜挂件' }, { issues: [] }), /锁定字段/)
  assert.equal(planner({ profiles: [{ ...locked, ...legalContent }, { ...locked, draft_key: 'unrelated' }] }, { issues: [] }), undefined)
  assert.equal(planner({ profiles: [{ ...locked, ...legalContent }], extra: 'cannot silently drop' }, { issues: [] }), undefined)
})

async function savedLegacy(mode: 'changed' | 'valid' | 'unknown' | 'raw') {
  let saved: any = { steps: {} }, requests = 0
  const steps = createGenerationSteps({ save: state => { saved = structuredClone(state) } })
  const stepId = 'unit:legacy-fixture:LOOK-LOCK', stepInput = { test: 'exact legacy binding' }, legacyPrompt = '只读原任务、画风和基础资料'
  const profile = { ...locked, ...legalContent }
  try {
    await steps.run(stepId, '旧档案', stepInput, () => generateStructuredOutput('visual_profiles', legacySchema, async () => {
      requests++
      if (mode === 'valid') return JSON.stringify({ profiles: [profile] })
      if (requests === 1) return JSON.stringify({ ...profile, kind: 'look' })
      if (mode === 'unknown' || mode === 'raw') throw new Error('fake interrupted correction')
      return JSON.stringify({ profiles: [{ ...profile, state_delta: '立领竖起、暗扣全扣' }] })
    }, legacyPrompt, { maxAttempts: mode === 'raw' ? 1 : 2, validate: value => { if (value.profiles[0]!.state_delta !== locked.state_delta) throw Object.assign(new Error('完整视觉档案不能改变已锁定的对象目录或基础关系'), { statusCode: 422 }) } }), value => value)
  } catch { /* Expected old behavior, with raw/correction retained by the real factory. */ }
  if (mode === 'valid') {
    // Simulate complete private response saved before the business-step save.
    delete saved.steps[stepId]
  }

  return { saved, requests, stepId, stepInput, legacyPrompt }
}

for (const mode of ['changed', 'valid', 'unknown', 'raw'] as const) test(`f563 exact legacy ${mode} binding replays locally without new calls or overwriting saved candidates`, async () => {
  const legacy = await savedLegacy(mode)
  const before = structuredClone(legacy.saved), originalKeys = Object.keys(before.steps)
  let state = structuredClone(before), generated = 0
  const steps = createGenerationSteps({ checkpoint: state, save: value => { state = structuredClone(value) } })
  const work = () => steps.run(legacy.stepId, '恢复旧档案', legacy.stepInput, () => generateVisualProfileUnit({ item: locked, schema: contentSchema,
    prompt: 'new compact task with all required facts', legacySchema, legacyPrompt: legacy.legacyPrompt, steps, stepId: legacy.stepId, stepInput: legacy.stepInput,
    generate: async () => { generated++; throw new Error('must not dispatch') }, validate: value => { assertVisualProfileLock(value, locked); return fullSchema.parse(value) },
    validateLegacy: value => { if (value.profiles[0]!.state_delta !== locked.state_delta) throw Object.assign(new Error('完整视觉档案不能改变已锁定的对象目录或基础关系'), { statusCode: 422 }) }, constraints: '只读事实', evidence: '完整镜头证据',
  }), value => value)
  if (mode !== 'unknown') {
    assert.equal((await work()).definition, legalContent.definition)
    const audits = Object.entries(state.steps).filter(([key]) => key.startsWith('visual-profile-local-migration:'))
    assert.equal(audits.length, mode === 'valid' ? 0 : 1)
    if (audits.length) {
      const audit = (audits[0]![1] as any).value
      assert.equal(audit.policy, 'visual-profile-original-content-v1')
      assert.equal(audit.new_paid_requests, 0)
      assert.equal(audit.correction_already_used, mode === 'changed')
      assert.deepEqual(audit.format_changes, ['envelope', 'kind'])
    }
    for (const key of originalKeys) assert.deepEqual(state.steps[key], before.steps[key], 'old response and correction budget remain immutable')
    assert.deepEqual(await work(), state.steps[legacy.stepId].value)
  }
  else {
    await assert.rejects(work, (error: any) => error.code === 'visual_profile_legacy_delivery_pending')
    await assert.rejects(work)
    assert.deepEqual(state, before, 'failed/unknown/spent private bytes and allowance are immutable')
  }
  assert.equal(generated, 0)
  assert.ok(originalKeys.every(key => key in state.steps))
  assert.equal(Object.keys(state.steps).filter(key => key.startsWith('response:')).length, 1)
})

for (const unknown of [false, true]) test(`f563 compact ${unknown ? 'unknown' : 'spent'} correction never buys a second patch after restart`, async () => {
  let state: any = { steps: {} }, calls = 0
  const stepId = 'unit:compact-fixture:LOOK-LOCK', stepInput = { test: 'compact allowance' }
  const execute = async () => {
    const steps = createGenerationSteps({ checkpoint: state, save: value => { state = structuredClone(value) } })
    return steps.run(stepId, '隔离档案', stepInput, () => generateVisualProfileUnit({ item: locked, schema: contentSchema, prompt: '新内容任务', legacySchema, legacyPrompt: '旧任务', steps, stepId, stepInput,
      generate: async (_prompt, contract) => {
        calls++
        if (contract?.name === 'visual_profile_content') return JSON.stringify({ ...legalContent, view_requirements: '' })
        if (unknown) throw new Error('fake disconnected correction')
        return JSON.stringify({ repairs: { view_requirements: '' } })
      }, validate: value => { assertVisualProfileLock(value, locked); return fullSchema.parse(value) }, validateLegacy: () => {}, constraints: '原文事实、基础设计、画风', evidence: '完整范围',
    }), value => value)
  }
  await assert.rejects(execute)
  assert.equal(calls, 2)
  const before = structuredClone(state)
  await assert.rejects(execute)
  assert.equal(calls, 2)
  assert.deepEqual(state, before)
  const privateValue: any = Object.entries(state.steps).find(([key]) => key.startsWith('response:'))![1]
  assert.equal(!!privateValue.value.correction, !unknown)
  assert.ok(privateValue.value.correction_started)
  assert.ok(privateValue.value.correction_request)
})

test('f563 privately captured original and correction replay locally with exact locked-fact diagnostics', { skip: !process.env.F563_LOCAL_REPLAY }, async () => {
  const { readFile } = await import('node:fs/promises')
  const saved = JSON.parse(await readFile(process.env.F563_LOCAL_REPLAY!, 'utf8'))
  const { completeStructuredRoot } = await import('../src/modules/generation/structured-output.js')
  const item = saved.catalog.profiles.find((profile: any) => profile.draft_key === 'LOOK-XZY-COAT')
  assert.ok(item)
  const original: any = completeStructuredRoot(saved.response.original_raw || saved.response.raw, { allowFenceExplanation: true })!.value
  const corrected: any = completeStructuredRoot(saved.response.correction.raw, { allowFenceExplanation: true })!.value
  assert.equal(original.kind, 'look')
  assert.equal(original.state_delta, item.state_delta)
  const diff = ['draft_key', 'kind', 'name', 'variant', 'scene_ids', 'base_profile_id', 'base_draft_key', 'state_delta'].filter(key => JSON.stringify(corrected.profiles[0][key]) !== JSON.stringify(item[key]))
  assert.deepEqual(diff, ['state_delta'])
  assert.throws(() => assertVisualProfileLock(corrected.profiles[0], item), (error: any) => error.code === 'visual_profile_locked_field_changed' && error.field_path === '$.state_delta')
  const { profileDraft } = await import('../src/modules/visuals/visual-profiles.js')
  const schema = profileDraft.shape.profiles.element.pick({ definition: true, view_requirements: true, shot_usage: true })
  const plan = visualProfileContentRepair(item, schema, 'local-only context')(original, { issues: [] })!
  assert.ok(plan)
  const { outputContract } = await import('../src/modules/generation/model-output.js')
  const patch = fixedValue(outputContract('visual_profile_content_local_repair', plan.schema).schema)
  const content = plan.apply(patch) as any
  assert.equal(content.definition, original.definition)
  assert.equal(content.view_requirements, original.view_requirements)
  assert.deepEqual(content.shot_usage, original.shot_usage)
  assert.equal(Object.hasOwn(content, 'state_delta'), false)
  assert.equal(item.state_delta, original.state_delta)
  const migrated = migrateOriginalVisualProfile({ checkpoint: saved.response, item, schema, bindingHash: 'b'.repeat(64), initialInputHash: saved.response.input_hash,
    assertLock: value => assertVisualProfileLock(value, item, false, true),
    validate: value => { assertVisualProfileLock(value, item); return profileDraft.shape.profiles.element.parse(value) },
  })!
  assert.ok(migrated)
  assert.equal(migrated.value.definition, original.definition)
  assert.equal(migrated.value.view_requirements, original.view_requirements)
  assert.deepEqual(migrated.value.shot_usage, original.shot_usage)
  assert.equal(migrated.value.state_delta, item.state_delta)
  assert.equal(migrated.audit.new_paid_requests, 0)
})

test('f563 saved-base derivation preserves null optionals, both scenes and every shot through actual canvas preparation', async t => {
  const f = await fixture()
  const baseResult = await call(`/api/projects/${f.project.id}/visual-profiles`, { profiles: [f.profiles[0]] })
  const base = baseResult.visual_profiles[0]
  const second = await call(`/api/projects/${f.project.id}/script/scenes`, { heading: '钟表铺门外', location: '店门', characters: '林晚', action: '林晚穿外衣出门。', episode_number: 1 })
  f.shots.push(await call(`/api/projects/${f.project.id}/shots`, { title: '门外镜头', source_scene_id: second.id, duration: 3, image_prompt: '林晚在店门口，外衣领口。', video_prompt: '林晚走出店门。' }))
  const delta = '仅增加深色外衣；其余沿用基础。'
  f.catalog = [{ ...f.catalog[0]!, draft_key: 'saved-base-look', variant: '深色外衣', base_profile_id: base.id, base_draft_key: null, state_delta: delta,
    scene_ids: [f.scene.id, second.id] } as any]
  f.profiles = [{ ...f.catalog[0]!, definition: '沿用基础人物，增加已锁定外衣。', view_requirements: '正侧背和外衣细节', shot_usage: f.shots.map(shot => ({ shot_id: shot.id, usage: 'both', reference_view: null })) }]
  f.request.scene_ids = [f.scene.id, second.id]
  f.request.signature = (await call(`/api/projects/${f.project.id}/script/canvas/check`, { scene_ids: f.request.scene_ids })).signature
  const beforeData = all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id)
  const calls = upstream(t, f, (name, body) => {
    if (name === 'visual_profile_catalog') return { profiles: f.catalog }
    if (name === 'visual_profile_content') {
      assert.ok(body.input.includes(base.id))
      assert.ok(body.input.includes(base.definition), 'saved base design is necessary context')
      assert.ok(body.input.includes(delta))
      for (const shot of f.shots) assert.ok(body.input.includes(shot.id))
      return { definition: f.profiles[0]!.definition, view_requirements: f.profiles[0]!.view_requirements, shot_usage: f.profiles[0]!.shot_usage }
    }
    if (name === 'visual_reference_coverage') return { visual_coverage: fixtureVisualCoverage(f.profiles, [f.scene, second], f.shots.map(shot => ({ ...shot, scene_id: shot.source_scene_id, shot_id: shot.id }))) }
  })
  const response = await f.prepare()
  assert.equal(response.statusCode, 200, response.body)
  const profile = response.json().profiles[0]
  assert.equal(profile.base_profile_id, base.id)
  assert.equal(profile.base_draft_key, null)
  assert.equal(profile.state_delta, delta)
  assert.deepEqual(profile.scene_ids, f.request.scene_ids)
  assert.equal(profile.shot_usage.length, 6)
  assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=?', f.project.id), beforeData)
  const beforeRequests = calls.length
  assert.equal((await f.prepare()).statusCode, 200)
  assert.equal(calls.length, beforeRequests)
})

const { migrateOriginalVisualProfile } = await import('../src/modules/visuals/visual-profile-local-migration.js')
const { createHash } = await import('node:crypto')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function migrate(raw: string, changes: Record<string, unknown> = {}, validator = (value: unknown) => fullSchema.parse(value)) {
  return migrateOriginalVisualProfile({ checkpoint: { input_hash: 'a'.repeat(64), raw, original_raw: raw, ...changes },
    item: locked, schema: contentSchema, bindingHash: 'b'.repeat(64), initialInputHash: 'a'.repeat(64),
    assertLock: value => assertVisualProfileLock(value, locked, false, true), validate: validator })
}

test('922 complete originals migrate only their envelope and known kind; content and bad corrections stay intact', () => {
  const raw = JSON.stringify({ ...locked, ...legalContent, kind: 'look' })
  const correction = { input_hash: 'c'.repeat(64), raw: JSON.stringify({ profiles: [{ ...locked, ...legalContent, state_delta: '错误纠正' }] }) }
  const before = structuredClone(correction)
  const result = migrate(raw, { correction, correction_started: { input_hash: correction.input_hash } })!
  assert.ok(result)
  assert.deepEqual(result.value, { ...locked, ...legalContent })
  assert.equal(result.audit.content_hash, digest(legalContent))
  assert.deepEqual(result.audit.format_changes, ['envelope', 'kind'])
  assert.deepEqual(correction, before)
  const reordered = { ...locked, kind: 'look', view_requirements: legalContent.view_requirements, definition: legalContent.definition,
    shot_usage: legalContent.shot_usage.map(({ shot_id, usage, reference_view }) => ({ reference_view, usage, shot_id })) }
  assert.ok(migrate(JSON.stringify(reordered)), 'JSON property order is not a content edit')
  assert.ok(migrate(JSON.stringify({ profiles: [{ ...locked, ...legalContent, kind: 'look' }] })))
})

test('922 truncated, ambiguous, duplicate-key, alias and unknown-delivery originals cannot migrate', () => {
  const original = { ...locked, ...legalContent, kind: 'look' }, raw = JSON.stringify(original)
  for (const broken of [raw.slice(0, -1), raw + raw, raw.replace('"kind":"look"', '"kind":"look","kind":"character"'),
    JSON.stringify({ ...original, kind: 'costume' }), JSON.stringify({ ...original, description: 'alias' }),
    JSON.stringify({ profiles: [original, original] }), JSON.stringify({ profiles: [original], extra: true })]) assert.equal(migrate(broken), undefined)
  for (const checkpoint of [
    { correction_request: { base_input_hash: 'd'.repeat(64), input_hash: 'e'.repeat(64), prompt: 'foreign frozen request', contract: { name: 'visual_profiles', schema: {} } } },
    { input_hash: 'd'.repeat(64) }, { original_raw: undefined }, { initial_started: { input_hash: 'd'.repeat(64) } },
    { correction_started: { input_hash: 'd'.repeat(64) } },
    { correction_started: { input_hash: 'd'.repeat(64) }, correction: { input_hash: 'e'.repeat(64), raw: '{}' } },
  ]) assert.equal(migrate(raw, checkpoint), undefined)
})

test('922 fact, shot and business conflicts never become a successful migration', () => {
  for (const change of [{ name: '其他人' }, { state_delta: locked.state_delta + ' ' }, { scene_ids: ['s1'] }, { base_draft_key: 'unrelated' }])
    assert.throws(() => migrate(JSON.stringify({ ...locked, ...legalContent, ...change, kind: 'look' })), /锁定字段/)
  assert.equal(migrate(JSON.stringify({ ...locked, ...legalContent, kind: 'look', shot_usage: [{ shot_id: 'foreign', usage: 'both', reference_view: null }] })), undefined)
  assert.equal(migrate(JSON.stringify({ ...locked, ...legalContent, kind: 'look', definition: '' })), undefined)
  assert.throws(() => migrate(JSON.stringify({ ...locked, ...legalContent, kind: 'look' }), {}, () => { throw new Error('final business validator') }), /final business validator/)
  assert.equal(migrate(JSON.stringify({ ...locked, ...legalContent, kind: 'look' }), {}, value => ({ ...(value as any), definition: 'silently rewritten' })), undefined)
})
