import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const directory = await mkdtemp(join(tmpdir(), 'image-prompt-document-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, now, all } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '正文与固定引用' })
  const provider = await call('POST', '/api/providers', { name: '隔离占位', base_url: 'https://example.invalid', adapter: 'http' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '图片占位', remote_id: 'mock', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/image', request_template: { prompt: '{{prompt}}', images: '{{images}}' }, image_base64_path: 'data.0.b64_json' } })
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '渡口补网', image_prompt: '旧镜头正文' })
  const asset = `${project.id}-face`
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'reference.png', '/tmp/reference.png', 'upload', ?)", asset, project.id, now())
  const { visual_profiles: [profile] } = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ kind: 'character', name: '姜望', variant: '补网装', definition: '已绑定灰衣设定', view_requirements: '正侧背' }] })
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: asset })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true }] })
  return { project, shot, model, profile, asset, url: `/api/projects/${project.id}/generate` }
}

async function propReferences(state: Awaited<ReturnType<typeof fixture>>, bound = true) {
  const ids = ['board', 'detail', 'sibling'].map(name => `${state.project.id}-ruler-${name}`)
  for (const id of ids) run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', ?, '/tmp/ruler.png', 'upload', ?)",
    id, state.project.id, `${id}.png`, now())
  const result = await call('POST', `/api/projects/${state.project.id}/visual-profiles`, { profiles: [
    { kind: 'prop', name: '巡天尺', variant: '青铜常态', definition: '巡天尺为青铜长尺，尺端嵌一枚朱红晶石。', view_requirements: '正面结构与握柄细节' },
  ] })
  const profile = result.visual_profiles.find((item: { name: string }) => item.name === '巡天尺')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: ids[0] })
  const references = []
  for (const [index, assetId] of ids.slice(1).entries()) {
    const data = await call('POST', `/api/visual-profiles/${profile.id}/reference-assets`, {
      expected_revision: 1, expected_style_version: result.project_visual_style.version,
      asset_id: assetId, view: 'detail', purpose: index ? 'structure' : 'detail', label: index ? '未选尺身' : '握柄红晶', status: 'confirmed',
    })
    references.push(data.reference_assets.find((reference: { asset_id: string }) => reference.asset_id === assetId))
  }
  if (bound) await call('PUT', `/api/shots/${state.shot.id}/visual-bindings`, { bindings: [
    { profile_id: state.profile.id, required: true },
    { profile_id: profile.id, required: false, usage: 'none', reference_asset_ids: references.map(reference => reference.id) },
  ] })
  return { ids, profile, references }
}

test('explicit inactive prop references carry frozen identity, definitions and selected view purposes without selecting sibling views', async () => {
  const state = await fixture(), prop = await propReferences(state)
  run("UPDATE shot_visual_bindings SET sync_mode='locked' WHERE shot_id=? AND profile_id=?", state.shot.id, prop.profile.id)
  run('UPDATE visual_profiles SET definition=? WHERE id=?', '当前库中较新定义，不应覆盖冻结的镜头设定', prop.profile.id)
  const preview = await call('POST', `${state.url}/preview`, { shot_id: state.shot.id, model_id: state.model.id,
    prompt_body: '姜望双手握住巡天尺，尺端朝上。', prompt: '姜望双手握住巡天尺。',
    reference_asset_ids: prop.ids.slice(0, 2), explicit_reference_asset_ids: prop.ids.slice(0, 2) })
  assert.deepEqual(preview.reference_asset_ids, [...prop.ids.slice(0, 2), state.asset])
  assert.match(preview.prompt, /道具：巡天尺（青铜常态/)
  assert.match(preview.prompt, /青铜长尺，尺端嵌一枚朱红晶石/)
  assert.match(preview.prompt, /参考图 1：巡天尺（青铜常态）/)
  assert.match(preview.prompt, /参考图 2：巡天尺（青铜常态）.*握柄红晶.*局部纹理/)
  assert.doesNotMatch(preview.prompt, /当前库中较新定义|未选尺身/)
  assert.ok(!preview.reference_asset_ids.includes(prop.ids[2]))
  const queued = await call('POST', state.url, preview)
  assert.deepEqual(JSON.parse(queued.request).reference_asset_ids, preview.reference_asset_ids)
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
  assert.equal(all<{ usage: string }>('SELECT usage FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', state.shot.id, prop.profile.id)[0]!.usage, 'none')
  const removed = await call('POST', `${state.url}/preview`, { shot_id: state.shot.id, model_id: state.model.id,
    prompt_body: '姜望低头补网。', prompt: '姜望低头补网。', reference_asset_ids: [] })
  assert.deepEqual(removed.reference_asset_ids, [state.asset])
  assert.doesNotMatch(removed.prompt, /巡天尺|握柄红晶/)
})

test('unbound confirmed prop views enrich only actual explicit inputs and semantic changes invalidate an approved preview', async () => {
  const state = await fixture(), prop = await propReferences(state, false)
  const preview = await call('POST', `${state.url}/preview`, { shot_id: state.shot.id, model_id: state.model.id,
    prompt_body: '姜望手持巡天尺。', prompt: '姜望手持巡天尺。', reference_asset_ids: [prop.ids[1]], explicit_reference_asset_ids: [prop.ids[1]] })
  assert.deepEqual(preview.reference_asset_ids, [prop.ids[1], state.asset])
  assert.match(preview.prompt, /道具：巡天尺/)
  assert.match(preview.prompt, /参考图 1：巡天尺.*握柄红晶/)
  assert.doesNotMatch(preview.prompt, /未选尺身/)
  run('UPDATE visual_profiles SET definition=? WHERE id=?', '巡天尺改为黑铁尺身。', prop.profile.id)
  const queued = await app.inject({ method: 'POST', url: state.url, payload: preview })
  assert.equal(queued.statusCode, 409, queued.body)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', state.project.id).length, 0)
})

test('explicit prop metadata does not rewrite edited or deliberately absent full-document sections', async () => {
  const state = await fixture(), prop = await propReferences(state)
  for (const block of ['', '【镜头视觉设定】\n巡天尺改为创作者指定的木质短尺。\n【镜头视觉设定结束】']) {
    const prompt = `姜望握住[[ref:${prop.ids[1]}]]所示道具。${block ? `\n\n${block}` : ''}`
    const preview = await call('POST', `${state.url}/preview`, { shot_id: state.shot.id, model_id: state.model.id,
      prompt, prompt_document: true, reference_asset_ids: [prop.ids[1]], explicit_reference_asset_ids: [prop.ids[1]] })
    assert.equal(preview.prompt, prompt.replace(`[[ref:${prop.ids[1]}]]`, '参考图 1'))
    assert.doesNotMatch(preview.prompt, /青铜长尺|【图片参考图用途】/)
    assert.deepEqual(preview.reference_asset_ids, [prop.ids[1], state.asset])
  }
})

test('a fixed node reference survives inactive shot defaults through preview and queue without changing those defaults', async () => {
  const { project, shot, model, profile, asset, url } = await fixture()
  const extra = `${project.id}-new-character`
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'new-character.png', '/tmp/new-character.png', 'upload', ?)", extra, project.id, now())
  const { visual_profiles } = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'character', name: '陆沉舟', variant: '登船装', definition: '青衣、腰间佩剑', view_requirements: '正侧背' },
  ] })
  const added = visual_profiles.find((item: { name: string }) => item.name === '陆沉舟')
  await call('PATCH', `/api/visual-profiles/${added.id}`, { expected_revision: 1, board_asset_id: extra })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [
    { profile_id: profile.id, required: true, usage: 'both' }, { profile_id: added.id, required: false, usage: 'none' },
  ] })
  const base = { shot_id: shot.id, model_id: model.id, prompt: '姜望低头补网。', reference_asset_ids: [extra] }
  const automatic = await call('POST', `${url}/preview`, base)
  assert.deepEqual(automatic.reference_asset_ids, [asset], 'inactive defaults still exclude automatic images')
  const block = '【项目画风约束】\n保留创作者的木刻画风。\n【项目画风约束结束】'
  const document = `姜望低头补网；陆沉舟站在其左后方，面部和服装参考[[ref:${extra}]]。\n\n${block}`
  const preview = await call('POST', `${url}/preview`, { ...base, prompt: document, prompt_document: true,
    explicit_reference_asset_ids: [extra] })
  assert.deepEqual(preview.reference_asset_ids, [extra, asset])
  assert.deepEqual(preview.explicit_reference_asset_ids, [extra])
  assert.equal(preview.prompt, document.replace(`[[ref:${extra}]]`, '参考图 1'))
  const queued = await call('POST', url, preview)
  const request = JSON.parse(queued.request)
  assert.deepEqual(request.reference_asset_ids, [extra, asset])
  assert.deepEqual(request.explicit_reference_asset_ids, [extra])
  assert.equal(request.prompt, preview.prompt)
  assert.equal(all<{ usage: string }>('SELECT usage FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', shot.id, added.id)[0]!.usage, 'none')
  const disconnected = await call('POST', `${url}/preview`, { ...base, reference_asset_ids: [] })
  assert.deepEqual(disconnected.reference_asset_ids, [asset], 'removing the connection does not enable the new character globally')
})

test('explicit reference replacements remain canonical when an approved preview is queued', async () => {
  const { project, shot, model, asset, url } = await fixture()
  const replacement = `${project.id}-replacement`
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'replacement.png', '/tmp/replacement.png', 'upload', ?)", replacement, project.id, now())
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id,
    prompt: '姜望低头补网。', reference_asset_ids: [asset], explicit_reference_asset_ids: [asset],
    prompt_reference_overrides: { [asset]: replacement } })
  assert.deepEqual(preview.reference_asset_ids, [replacement])
  assert.deepEqual(preview.explicit_reference_asset_ids, [replacement])
  const queued = await call('POST', url, preview)
  assert.deepEqual(JSON.parse(queued.request).explicit_reference_asset_ids, [replacement])
})

test('explicit references cannot add unsubmitted images or duplicate entries', async () => {
  const { shot, model, asset, url } = await fixture()
  for (const explicit_reference_asset_ids of [['unsubmitted'], [asset, asset]]) {
    const response = await app.inject({ method: 'POST', url: `${url}/preview`, payload: {
      shot_id: shot.id, model_id: model.id, prompt: '姜望低头补网。', reference_asset_ids: [asset], explicit_reference_asset_ids,
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /显式参考/)
  }
})

test('explicit body is authoritative while current visuals, actual image mapping and bounded parameters are rebuilt through queue', async () => {
  const { shot, model, asset, url } = await fixture()
  const body = `姜望按[[ref:${asset}]]保持身份，在岸边补网。固定机位。`
  const parameters = '【图片生成要求】\n画面比例：16:9\n清晰度要求：4K\n【图片生成要求结束】'
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id, prompt_body: body,
    prompt: `不能使用的旧正文\n\n【镜头视觉设定】\n不能使用的旧设定\n【镜头视觉设定结束】\n\n${parameters}\n\n【图片参考图用途】\n[[ref:stale-never-submitted]]\n【图片参考图用途结束】`, prompt_is_final: true })
  assert.deepEqual(preview.reference_asset_ids, [asset])
  assert.match(preview.prompt, /姜望按参考图 1保持身份.*固定机位/)
  assert.match(preview.prompt, /已绑定灰衣设定/)
  assert.match(preview.prompt, /参考图 1：姜望（补网装）/)
  assert.ok(preview.prompt.includes(parameters))
  assert.doesNotMatch(preview.prompt, /不能使用|stale-never-submitted/)
  const queued = await call('POST', url, preview)
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
  assert.equal(JSON.parse(queued.request).prompt_body, body)
  for (const marker of ['镜头视觉设定', '图片参考图用途', '图片生成要求']) assert.equal(preview.prompt.split(`【${marker}】`).length, 2)
})

test('legacy final prose gains image ownership mapping without reverting creator-edited visual text', async () => {
  const { shot, model, asset, url } = await fixture()
  const oldFinal = '创作者新镜头动作。\n\n【镜头视觉设定】\n我已将灰衣改为湿蓝衣。'
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id, prompt: oldFinal, prompt_is_final: true })
  assert.ok(preview.prompt.startsWith(oldFinal))
  assert.match(preview.prompt, /参考图 1：姜望（补网装）/)
  assert.doesNotMatch(preview.prompt, /已绑定灰衣设定/)
  assert.deepEqual(preview.reference_asset_ids, [asset])
  const queued = await call('POST', url, preview)
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
})

test('read-only image mapping never revives an inactive reference after switching to text-only mode', async () => {
  const { shot, model, asset, url } = await fixture()
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id, prompt_is_final: true,
    visual_reference_mode: 'text_only', reference_asset_ids: [], prompt: `只保留我的画面。\n\n【图片参考图用途】\n[[ref:${asset}]]：姜望身份\n【图片参考图用途结束】` })
  assert.deepEqual(preview.reference_asset_ids, [])
  assert.equal(preview.mode, 'text')
  assert.equal(preview.prompt, '只保留我的画面。')
})

test('image nodes without a shot preserve the explicit body and parameters and label manual references without invented owners', async () => {
  const { model, asset, url } = await fixture()
  const parameters = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const preview = await call('POST', `${url}/preview`, { model_id: model.id, prompt_body: '只调整船的材质。',
    prompt: `旧稿\n\n${parameters}`, prompt_is_final: true, reference_asset_ids: [asset] })
  assert.match(preview.prompt, /^只调整船的材质。/)
  assert.ok(preview.prompt.includes(parameters))
  assert.match(preview.prompt, /参考图 1：补充参考/)
  assert.doesNotMatch(preview.prompt, /姜望|旧稿/)
  assert.deepEqual(preview.reference_asset_ids, [asset])
})

test('setting board previews rebuild saved definitions and views outside the editable body without duplicating system sections', async () => {
  const { model, profile, asset } = await fixture()
  const parameters = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const preview = await call('POST', `/api/visual-profiles/${profile.id}/board-preview`, { model_id: model.id,
    prompt_override: `仅调整信息图的排布。\n\n【设定图固定要求】\n错误旧定义与视图\n【设定图固定要求结束】\n\n${parameters}`,
    reference_asset_ids: [asset] })
  assert.match(preview.prompt, /^仅调整信息图的排布。/)
  assert.match(preview.prompt, /已绑定灰衣设定|正侧背/)
  assert.ok(preview.prompt.includes(parameters))
  assert.doesNotMatch(preview.prompt, /错误旧定义与视图|只生成当前镜头的一幅完整画面/)
  assert.equal(preview.prompt.split('【设定图固定要求】').length, 2)
  assert.equal(preview.prompt.split('【生成参考图】').length, 2)
})

test('system-only structured prompts and system-only board overrides cannot enqueue generation', async () => {
  const { shot, model, profile, url } = await fixture()
  for (const prompt_body of ['', ' \n\t', '【镜头视觉设定】\n只有系统说明\n【镜头视觉设定结束】']) {
    const response = await app.inject({ method: 'POST', url: `${url}/preview`, payload: { shot_id: shot.id, model_id: model.id,
      prompt: '完整系统占位词', prompt_body, prompt_is_final: true } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /请输入提示词正文/)
  }
  const board = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/board-preview`, payload: { model_id: model.id,
    prompt_override: '【设定图固定要求】\n只有固定区\n【设定图固定要求结束】' } })
  assert.equal(board.statusCode, 422, board.body)
  assert.match(board.body, /请输入提示词正文/)
})

test('excluding an optional shared image owner keeps its text but removes its identity from the actual image mapping', async () => {
  const { project, shot, model, profile, asset, url } = await fixture()
  const { visual_profiles: profiles } = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ kind: 'prop', name: '木网针', variant: '旧木', definition: '保留的木网针文字', view_requirements: '线槽细节' }] })
  const prop = profiles.find((item: { kind: string }) => item.kind === 'prop')
  await call('PATCH', `/api/visual-profiles/${prop.id}`, { expected_revision: 1, board_asset_id: asset })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true }, { profile_id: prop.id, required: false }] })
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id, prompt_body: '按正文补网。', prompt: '按正文补网。',
    prompt_is_final: true, excluded_visual_profile_ids: [prop.id] })
  assert.deepEqual(preview.reference_asset_ids, [asset])
  const [body, mapping] = preview.prompt.split('【图片参考图用途】')
  assert.match(body, /保留的木网针文字/)
  assert.match(mapping, /参考图 1：姜望（补网装）/)
  assert.doesNotMatch(mapping, /木网针|旧木/)
})

test('complete edited documents preserve all sections and compile references authored inside system sections through queue', async () => {
  const { project, shot, model, asset, url } = await fixture()
  const extra = `${project.id}-extra`
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'extra.png', '/tmp/extra.png', 'upload', ?)", extra, project.id, now())
  run('UPDATE scripts SET generation_options=? WHERE project_id=?', JSON.stringify({ visual_style: '项目保存的水墨' }), project.id)
  const document = `  创作者完整文稿。\n\n【镜头视觉设定】\n自改蓝衣，身份[[ref:${asset}]]。\n【镜头视觉设定结束】\n\n` +
    `【图片参考图用途】\n[[ref:${extra}]]只参考船的材质，不改人物。\n【图片参考图用途结束】\n\n` +
    '【项目画风约束】\n人工修改的版画。\n【项目画风约束结束】\n\n【图片生成要求】\n创作者画幅备注。\n【图片生成要求结束】\n末段。  '
  const input = { shot_id: shot.id, model_id: model.id, prompt: document, prompt_document: true,
    prompt_body: '已废弃的旧正文字段', prompt_is_final: true, reference_asset_ids: [asset] }
  const preview = await call('POST', `${url}/preview`, input)
  const expected = document.replace(`[[ref:${asset}]]`, '参考图 1').replace(`[[ref:${extra}]]`, '参考图 2')
  assert.equal(preview.prompt, expected)
  assert.deepEqual(preview.reference_asset_ids, [asset, extra])
  assert.doesNotMatch(preview.prompt, /已绑定灰衣设定|项目保存的水墨|旧正文字段/)
  const queued = await call('POST', url, preview)
  const request = JSON.parse(queued.request)
  assert.equal(request.prompt_document, true)
  assert.equal(request.prompt, expected)
  assert.deepEqual(request.reference_asset_ids, [asset, extra])
})

test('complete documents may remove all generated sections without having defaults restored', async () => {
  const { shot, model, asset, url } = await fixture()
  const prompt = '仅保留我明确写出的完整文稿。'
  const preview = await call('POST', `${url}/preview`, { shot_id: shot.id, model_id: model.id,
    prompt, prompt_document: true, prompt_body: '' })
  assert.equal(preview.prompt, prompt)
  assert.deepEqual(preview.reference_asset_ids, [asset])
  const standalone = await call('POST', `${url}/preview`, { model_id: model.id, prompt_document: true,
    prompt: `【生成参考图】\n材质按[[ref:${asset}]]\n【生成参考图结束】`, reference_asset_ids: [] })
  assert.equal(standalone.prompt, '【生成参考图】\n材质按参考图 1\n【生成参考图结束】')
  assert.deepEqual(standalone.reference_asset_ids, [asset])
})

test('complete board documents retain authored definitions, image uses, style and parameters in the actual job', async () => {
  const { project, model, profile, asset } = await fixture()
  run('UPDATE scripts SET generation_options=? WHERE project_id=?', JSON.stringify({ visual_style: '项目水墨' }), project.id)
  const document = `只改排版。\n\n【设定图固定要求】\n人工修改为蓝衣，保持身份[[ref:${asset}]]。\n【设定图固定要求结束】\n\n` +
    '【项目画风约束】\n木刻风格。\n【项目画风约束结束】\n\n【图片生成要求】\n横向排版。\n【图片生成要求结束】'
  const input = { model_id: model.id, expected_revision: profile.revision, prompt_document: true, prompt_override: document }
  const preview = await call('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  assert.equal(preview.prompt, document.replace(`[[ref:${asset}]]`, '参考图 1'))
  assert.deepEqual(preview.reference_asset_ids, [asset])
  const generated = await call('POST', `/api/visual-profiles/${profile.id}/generate`, { ...input,
    prompt: preview.prompt, reference_signature: preview.reference_signature, project_style_version: preview.project_style_version,
    ratio: '16:9', resolution: null, quality: null, clarity: null, background: null })
  const request = JSON.parse(generated.jobs[0].request)
  assert.equal(request.prompt_document, true)
  assert.equal(request.prompt, preview.prompt)
  assert.deepEqual(request.reference_asset_ids, [asset])
  assert.doesNotMatch(request.prompt, /已绑定灰衣设定|项目水墨|生成参考图/)
})

test('complete documents validate malformed markers, invalid references and foreign image references', async () => {
  const { shot, model, url } = await fixture()
  const other = await fixture()
  const input = { shot_id: shot.id, model_id: model.id, prompt_document: true }
  for (const [prompt, message] of [
    ['完整文稿。\n【图片参考图用途】不完整', /系统区/],
    ['【镜头视觉设定】[[ref:bad ref]]【镜头视觉设定结束】', /无效/],
    [`【图片参考图用途】[[ref:${other.asset}]]【图片参考图用途结束】`, /当前项目/],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `${url}/preview`, payload: { ...input, prompt } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, message)
  }
})

test('generation preview and enqueue reject explicit document parameter conflicts before any writes', async () => {
  const { shot, model, url } = await fixture()
  const tables = ['jobs', 'shots', 'asset_tasks', 'canvas_nodes']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  const input = { shot_id: shot.id, model_id: model.id, prompt_document: true, ratio: '16:9', clarity: '4K',
    prompt: '按当前人物补网。\n\n【图片生成要求】\n画面比例：9:16\n清晰度要求：2K\n【图片生成要求结束】' }
  for (const target of [`${url}/preview`, url]) {
    const response = await app.inject({ method: 'POST', url: target, payload: input })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /画面比例.*16:9/)
    assert.match(response.body, /清晰度要求.*4K/)
    assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
  }
})

test('board preview and enqueue validate actual parameters without creating a board task or job', async () => {
  const { model, profile } = await fixture()
  const prompt = '只调整排版。\n\n【图片生成要求】\n画面比例：9:16\n【图片生成要求结束】'
  const input = { model_id: model.id, expected_revision: profile.revision, prompt_document: true, prompt_override: prompt }
  // A legacy preview omitting generation fields remains compatible, but enqueue
  // must independently check the authoritative fields sent with the request.
  const preview = await call('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  const tables = ['jobs', 'visual_profiles', 'asset_tasks', 'canvas_nodes']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  for (const [target, payload] of [
    [`/api/visual-profiles/${profile.id}/board-preview`, { ...input, ratio: '16:9' }],
    [`/api/visual-profiles/${profile.id}/generate`, { ...input, prompt: preview.prompt, reference_signature: preview.reference_signature,
      ratio: '16:9', resolution: null, quality: null, clarity: null, background: null }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: target, payload })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /画面比例.*16:9/)
    assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
  }
})

test('asset task generation checks explicit document parameters before enqueueing or mutating the task', async () => {
  const { profile, model } = await fixture()
  const board = await call('POST', `/api/visual-profiles/${profile.id}/board-task`, {})
  const tables = ['jobs', 'asset_tasks']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  const response = await app.inject({ method: 'POST', url: `/api/asset-tasks/${board.task_id}/generate`, payload: {
    model_id: model.id, prompt_document: true, prompt: '整理视图。\n背景要求：透明背景，仅保留主体，不要绘制棋盘格或实色背景',
    background: 'auto', ratio: '16:9', mode: 'text',
  } })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /背景要求.*auto/)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
})

test('video preview and enqueue reject declared duration and mode mismatches against actual request fields', async () => {
  const { shot, model: imageModel, url } = await fixture()
  const model = await call('POST', '/api/models', { provider_id: imageModel.provider_id, name: '视频隔离占位', remote_id: 'mock-video',
    modality: 'video', protocol: 'async_video', settings: seedance2VideoSettings() })
  const input = { shot_id: shot.id, model_id: model.id, prompt_document: true, mode: 'text', duration: 5,
    visual_reference_mode: 'text_only', ratio: '16:9', resolution: '480p',
    prompt: '按正文连续补网。\n【视频生成要求】\n视频时长：8 秒\n生成模式：first_frame\n【视频生成要求结束】' }
  const before = all('SELECT * FROM jobs')
  for (const target of [`${url}/preview`, url]) {
    const response = await app.inject({ method: 'POST', url: target, payload: input })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /视频时长.*5 秒/)
    assert.match(response.body, /生成模式.*text/)
    assert.deepEqual(all('SELECT * FROM jobs'), before)
  }
})
