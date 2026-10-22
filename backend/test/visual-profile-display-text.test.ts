import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveVisualProfileDisplayText } from '@video-studio/shared/visuals/visual-profile-display-text'
import type { ResourceChange } from '@video-studio/shared/script/script-resource-types'

const shotId = '14f0e07dcd354ce5a1153598f9ff44dd'
const key = 'P6-CHAR-JIANGWANG-BASE'
const baseLabel = '姜望（渡口补网装·落泥前）'

test('known project references become readable without touching URLs, stable image tokens or unrelated prose', () => {
  const text = `${shotId}视频中，基础为本批${key}。\n原样 [[ref:${shotId}]] https://example.invalid/${key}?id=${shotId}\n编号前缀x${shotId}不改；色值abcdef1234567890abcdef1234567890、型号P6-CHAR-LAMP。`
  const result = resolveVisualProfileDisplayText(text, { references: [{ key: shotId, label: '镜头「船腹泥水落手」' }, { key, label: baseLabel }], baseLabel })
  assert.match(result.text, /^镜头「船腹泥水落手」视频中，基础为本批姜望（渡口补网装·落泥前）。/)
  assert.ok(result.text.includes(`[[ref:${shotId}]] https://example.invalid/${key}?id=${shotId}`))
  assert.ok(result.text.includes(`编号前缀x${shotId}不改`))
  assert.ok(result.text.includes('色值abcdef1234567890abcdef1234567890、型号P6-CHAR-LAMP'))
  assert.deepEqual(result.issues, [])
  assert.equal(resolveVisualProfileDisplayText(`镜头ID:${shotId}；保留${key}::deadbeef。`, { references: [{ key: shotId, label: '镜头「船腹泥水落手」' }, { key, label: baseLabel }] }).text,
    `镜头ID:镜头「船腹泥水落手」；保留${key}::deadbeef。`)
})

test('historical base aliases resolve only in an explicit prose role with a stored base relation', () => {
  assert.equal(resolveVisualProfileDisplayText(`基础为本批${key}，仅左手背溅泥。`, { references: [], baseLabel }).text, `基础为本批${baseLabel}，仅左手背溅泥。`)
  assert.equal(resolveVisualProfileDisplayText(`用户笔记：${key}；${shotId}`, { references: [], baseLabel }).text, `用户笔记：${key}；${shotId}`)
  const unknown = resolveVisualProfileDisplayText(`基础为本批${key}，草稿标识：UNREAD-DRAFT-KEY。`, { references: [] })
  assert.equal(unknown.text, '基础为本批关联设定待核对，草稿标识：关联设定待核对。')
  assert.deepEqual(unknown.issues.map(issue => issue.token), [key, 'UNREAD-DRAFT-KEY'])
})

test('ambiguous aliases never select a profile by name or insertion order', () => {
  const result = resolveVisualProfileDisplayText(`沿用${key}。`, { references: [{ key, label: '姜望（基础）' }, { key, label: '另一人物（基础）' }] })
  assert.equal(result.text, '沿用关联设定待核对。')
  assert.deepEqual(result.issues, [{ token: key, reason: 'ambiguous' }])
})

const directory = await mkdtemp(join(tmpdir(), 'visual-profile-display-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, now, run, one, newId } = await import('../src/infrastructure/database/db.js')
const { applyResourceChanges, validateResourceChanges } = await import('../src/modules/script/script-resource-tools.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<any> {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
const draft = (variant: string, extra: Record<string, unknown> = {}) => ({ kind: 'character', name: '姜望', variant,
  definition: '黑发束短马尾，灰褐短褐，身份固定。', view_requirements: '正侧背及左手背细节', scene_ids: [], ...extra })
async function project(name: string) { return call('POST', '/api/projects', { name }) }
async function confirm(projectId: string, profile: any) {
  const assetId = newId()
  run(`INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','base.png','/tmp/unused-base.png','upload',?)`, assetId, projectId, now())
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, board_asset_id: assetId })
  return assetId
}
async function model() {
  const provider = await call('POST', '/api/providers', { name: '隔离文字解析测试', base_url: 'https://example.invalid' })
  return call('POST', '/api/models', { provider_id: provider.id, name: '隔离图片模型', remote_id: 'image', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/images', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
}

test('historical screenshot text is readable in API and actual board preview while stored source stays byte-for-byte', async () => {
  const p = await project('历史编号展示')
  run(`INSERT INTO shots (id,project_id,position,title,prompt,duration,created_at) VALUES (?,?,0,'船腹泥水落手','姜望左手背溅泥',5,?)`, shotId, p.id, now())
  const initial = await call('POST', `/api/projects/${p.id}/visual-profiles`, { profiles: [draft('渡口补网装·落泥前')] })
  const base = initial.visual_profiles[0]
  const definition = `方案6同一姜望的局部状态派生，基础为本批${key}，画面代称：姜望。`
  const delta = `${shotId}视频中，船腹泥水落到左手手背，其余状态不变。`
  const created = await call('POST', `/api/projects/${p.id}/visual-profiles`, { profiles: [draft('左手背少量泥点', { definition, base_profile_id: base.id, state_delta: delta })] })
  const state = created.visual_profiles.find((value: any) => value.base_profile_id === base.id)
  assert.equal(state.definition, definition)
  assert.equal(state.state_delta, delta)
  assert.ok(state.display_definition.includes(`基础为本批姜望（${base.variant}）`))
  assert.ok(!state.board_prompt.includes(key))
  assert.ok(state.display_state_delta.startsWith('镜头「船腹泥水落手」视频中'))
  assert.equal(typeof state.base_reference_signature, 'string')
  const assetId = await confirm(p.id, base), imageModel = await model()
  const preview = await call('POST', `/api/visual-profiles/${state.id}/board-preview`, { model_id: imageModel.id })
  assert.ok(!preview.prompt.includes(key))
  assert.ok(!preview.prompt.includes(shotId))
  assert.deepEqual(preview.reference_asset_ids, [assetId])
  const manual = await call('POST', `/api/visual-profiles/${state.id}/board-preview`, { model_id: imageModel.id,
    prompt_override: `手动要求：${shotId}视频中，基础为本批${key}。保留 [[ref:${assetId}]] 和 https://example.invalid/${key}` })
  assert.ok(manual.prompt.includes('手动要求：镜头「船腹泥水落手」视频中，基础为本批姜望'))
  assert.ok(manual.prompt.includes(`https://example.invalid/${key}`))
  assert.deepEqual(manual.reference_asset_ids, [assetId])
  const queued = await call('POST', `/api/visual-profiles/${state.id}/generate`, { model_id: imageModel.id, expected_revision: state.revision,
    reference_signature: preview.reference_signature, prompt: `${preview.prompt}\n补充：${shotId}视频中保持连续。`, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null })
  const request = JSON.parse(queued.job.request)
  assert.ok(request.prompt.includes('补充：镜头「船腹泥水落手」视频中保持连续。'))
  assert.deepEqual(request.reference_names, preview.reference_names)
  assert.deepEqual(request.reference_sources, [{ asset_id: assetId, profile_id: base.id, revision: base.revision, role: 'base' }])
  assert.deepEqual(one('SELECT definition,state_delta FROM visual_profiles WHERE id=?', state.id), { definition, state_delta: delta })
})

test('new batch draft keys persist as provenance and resolve strictly within their design after reload', async () => {
  const p = await project('新批来源键')
  const designs = [newId(), newId()]
  for (const [index, designId] of designs.entries()) run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,\'[]\',\'\',?)', designId, p.id, `分镜方案 ${index + 6}`, now())
  let firstState: any
  for (const [index, designId] of designs.entries()) {
    const baseName = index ? '另一个姜望' : '姜望'
    const result = await call('POST', `/api/projects/${p.id}/visual-profiles`, { profiles: [
      draft('左手背泥点', { design_id: designId, draft_key: 'mud', base_draft_key: key, definition: `继承${key}，仅左手溅泥。`, state_delta: '仅左手溅泥。' }),
      draft('基础装', { design_id: designId, name: baseName, draft_key: key }),
    ] })
    const state = result.visual_profiles.find((value: any) => value.design_id === designId && value.base_profile_id)
    assert.ok(state.display_definition.includes(`继承${baseName}（基础装 · 分镜方案 ${index + 6}）`))
    const source = one<{ source_draft_key: string }>('SELECT source_draft_key FROM visual_profiles WHERE id=?', state.base_profile_id)
    assert.ok(source?.source_draft_key.startsWith(`${key}::`))
    firstState ||= state
  }
  const reloaded = await call('GET', `/api/projects/${p.id}`)
  const original = reloaded.visual_profiles.find((value: any) => value.id === firstState.id)
  assert.ok(!original.display_definition.includes('另一个姜望'))
  assert.equal(original.definition, `继承${key}，仅左手溅泥。`)
})

test('confirmed script resource batches keep forward identity relations, raw text and resolvable draft provenance', async () => {
  const p = await project('剧本工具保存来源')
  const baseId = newId(), stateId = newId()
  const definition = `沿用${key}，仅手背泥点变化。`
  const changes: ResourceChange[] = [
    { type: 'visual_profile', id: stateId, title: '姜望·泥点', base_version: '', original: null,
      value: { ...draft('泥点'), kind: 'character', definition, draft_key: 'MUD', base_draft_key: key, state_delta: '左手背泥点。' } },
    { type: 'visual_profile', id: baseId, title: '姜望·基础', base_version: '', original: null,
      value: { ...draft('基础'), kind: 'character', draft_key: key } },
  ]
  db.transaction(() => { validateResourceChanges(p.id, changes); applyResourceChanges(p.id, changes) })()
  const state = (await call('GET', `/api/projects/${p.id}`)).visual_profiles.find((value: any) => value.id === stateId)
  assert.equal(state.base_profile_id, baseId)
  assert.equal(state.definition, definition)
  assert.equal(state.display_definition, '沿用姜望（基础），仅手背泥点变化。')
  assert.equal(one<{ source_draft_key: string }>('SELECT source_draft_key FROM visual_profiles WHERE id=?', baseId)?.source_draft_key, key)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
