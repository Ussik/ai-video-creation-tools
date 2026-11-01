import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resourceReadPage, resourceReadPageLimit } from '../src/modules/script/script-resource-read-page.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-resource-page-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all, one, run } = await import('../src/infrastructure/database/db.js')
const { resourceTools, resourceVersion } = await import('../src/modules/script/script-resource-tools.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const profileValue = { kind: 'character', name: '角色00', variant: '默认', definition: '设定', view_requirements: '正侧背', scene_ids: [] }
function seedProfile(projectId: string, index: number, referenceCount: number) {
  const id = `${projectId}-profile-${index}`, timestamp = new Date().toISOString()
  run(`INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES (?,?,'character',?,?,?, ?,?)`, id, projectId, `角色${String(index).padStart(2, '0')}`, '人物设定'.repeat(3000), '正侧背', timestamp, timestamp)
  for (let ref = 0; ref < referenceCount; ref++) {
    const assetId = `${id}-asset-${ref}`
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,?,'upload',?)", assetId, projectId, `${ref}.png`, join(testData, `${ref}.png`), timestamp)
    run(`INSERT INTO visual_profile_reference_assets (id,profile_id,asset_id,revision,view,purpose,label,status,created_at,updated_at)
      VALUES (?,?,?,1,'front','identity',?,'confirmed',?,?)`, `${id}-ref-${ref}`, id, assetId, '参考图说明'.repeat(20), timestamp, timestamp)
    run('INSERT INTO visual_profile_candidates (profile_id,asset_id,updated_at) VALUES (?,?,?)', id, assetId, timestamp)
  }
  return id
}
async function fixture() {
  const project = await call('/api/projects', { name: '资源续读预算测试' })
  const scene = await call(`/api/projects/${project.id}/script/scenes`, { heading: '场景00', characters: '角色00', action: '角色进场', duration: 8 })
  return { project, scene }
}
function collectPages(first: any, next: (args: any) => any) {
  const pages: any[] = [], values = new Map<string, Map<string, any>>(), chunks = new Map<string, string>()
  let page = first
  for (let count = 0; ; count++) {
    assert.ok(count < 200, 'continuation must terminate')
    assert.ok(JSON.stringify(page).length <= resourceReadPageLimit)
    assert.equal(page.source_version, first.source_version)
    pages.push(page)
    const add = (section: string, value: any) => {
      if (!values.has(section)) values.set(section, new Map())
      const key = value.id || section
      assert.ok(!values.get(section)!.has(key), `must not repeat ${section}:${key}`)
      values.get(section)!.set(key, value)
    }
    for (const section of ['profiles', 'objects', 'visual_profile_catalog']) for (const value of page[section] || []) add(section, value)
    if (page.project_visual_style) add('project_visual_style', page.project_visual_style)
    for (const fragment of page.fragments) {
      const key = `${fragment.section}:${fragment.index}`, previous = chunks.get(key) || ''
      assert.equal(fragment.offset, previous.length)
      const content = previous + fragment.serialized_fragment
      assert.equal(fragment.next_offset, content.length)
      chunks.set(key, content)
      if (fragment.complete) { assert.equal(content.length, fragment.total_length); add(fragment.section, JSON.parse(content)) }
    }
    if (page.complete) { assert.equal(page.continuation, null); break }
    assert.ok(page.continuation)
    page = next(page.continuation)
  }
  return { pages, values }
}

test('the entire JSON envelope, escaped text, oversized style and individual records reconstruct losslessly', () => {
  const style = { version: 'style-v1', details: '画风"\\\n😀'.repeat(18_000) }
  const profiles = Array.from({ length: 30 }, (_, index) => ({ id: `profile-${index}`, version: `v-${index}`, definition: '设定"\\\n😀'.repeat(index === 0 ? 18_000 : 1000) }))
  const query = { offset: 0, limit: 20 }
  const read = (args: any) => resourceReadPage({ projectId: 'project', tool: 'read_visual_profiles', query, cursor: args.cursor,
    sections: [{ key: 'project_visual_style', values: [style], limit: 1, singleton: true }, { key: 'profiles', values: profiles, limit: 20 }],
    metadata: positions => ({ next_offset: positions[1]!.index, total: profiles.length }) }).result
  const result = collectPages(read({}), read)
  assert.deepEqual([...result.values.get('project_visual_style')!.values()], [style])
  for (const profile of profiles) assert.deepEqual(result.values.get('profiles')!.get(profile.id), profile)
  assert.ok(result.pages.length > 5)
  for (const invalid of [null, [], 42, 'cursor', {}, { v: 1, positions: null }]) {
    assert.throws(() => read({ cursor: Buffer.from(JSON.stringify(invalid)).toString('base64url') }), error => error instanceof Error && (error as any).statusCode === 422)
  }
})

test('large profile reads preserve every reference and candidate; partial and tail-only reads cannot authorize edits', async () => {
  const { project } = await fixture()
  const ids = db.transaction(() => Array.from({ length: 24 }, (_, index) => seedProfile(project.id, index, index === 0 ? 150 : 3)))()
  const tool = resourceTools(project.id), args = { limit: 20 }, first: any = tool.execute('read_visual_profiles', args)
  assert.equal(first.profiles.length, 0)
  assert.ok(first.fragments.some((fragment: any) => fragment.section === 'profiles' && !fragment.complete))
  const original = one<any>('SELECT * FROM visual_profiles WHERE id=?', ids[0])!, version = resourceVersion(original)
  const proposal = { summary: '补充设定', profiles: [{ profile_id: original.id, base_version: version, profile: profileValue }] }
  assert.throws(() => tool.execute('propose_visual_profile_draft', proposal), /操作前请读取/)
  const result = collectPages(first, continuation => tool.execute('read_visual_profiles', continuation))
  assert.equal(result.values.get('profiles')!.size, ids.length)
  for (const [index, id] of ids.entries()) {
    const profile = result.values.get('profiles')!.get(id)
    assert.equal(profile.definition, original.definition)
    assert.equal(profile.reference_assets.length, index === 0 ? 150 : 3)
    assert.equal(profile.candidates.length, index === 0 ? 150 : 3)
    assert.deepEqual(profile.reference_assets.map((reference: any) => reference.id), all<any>('SELECT id FROM visual_profile_reference_assets WHERE profile_id=? ORDER BY created_at,id', id).map(row => row.id))
  }
  assert.doesNotThrow(() => tool.execute('propose_visual_profile_draft', proposal))
  const tailPageIndex = result.pages.findIndex(page => page.fragments.some((fragment: any) => fragment.id === original.id && fragment.complete))
  assert.ok(tailPageIndex > 0)
  const tailOnly = resourceTools(project.id)
  tailOnly.execute('read_visual_profiles', result.pages[tailPageIndex - 1].continuation)
  assert.throws(() => tailOnly.execute('propose_visual_profile_draft', proposal), /操作前请读取/)
  assert.throws(() => tool.execute('read_visual_profiles', { ...first.continuation, limit: 1 }), /项目或查询不匹配/)
  const other = await fixture()
  assert.throws(() => resourceTools(other.project.id).execute('read_visual_profiles', first.continuation), /项目或查询不匹配/)
  run('UPDATE visual_profile_reference_assets SET label=? WHERE profile_id=?', '参考图已修订', original.id)
  assert.throws(() => tool.execute('read_visual_profiles', first.continuation), /读取源版本已变化/)
})

test('storyboard objects and catalog share the budget, continue without catalog repetition and authorize only delivered objects', async () => {
  const { project, scene } = await fixture()
  const ids = db.transaction(() => Array.from({ length: 43 }, (_, index) => seedProfile(project.id, index, index === 0 ? 100 : 4)))()
  const action = '连续行动😀'.repeat(20_000)
  run('UPDATE script_scenes SET action=? WHERE id=?', action, scene.id)
  for (const id of ids.slice(0, 6)) run('INSERT INTO scene_visual_bindings (scene_id,profile_id) VALUES (?,?)', scene.id, id)
  for (let index = 1; index < 7; index++) await call(`/api/projects/${project.id}/script/scenes`, { heading: `场景${index}`, characters: '', action: '继续行动', duration: 8 })
  const tool = resourceTools(project.id), first: any = tool.execute('get_storyboard_context', { limit: 3 })
  assert.equal(first.objects.length, 0)
  const firstFragment = first.fragments.find((fragment: any) => fragment.section === 'objects')
  assert.ok(firstFragment && !firstFragment.complete)
  const plan = { summary: '拆分场次', scenes: [{ scene_id: scene.id, base_version: firstFragment.version,
    shots: [{ title: '进入', prompt: '角色进场', image_prompt: '角色站在门口', video_prompt: '角色进场', duration: 8 }] }] }
  assert.throws(() => tool.execute('propose_shot_plan', plan), /操作前请读取/)
  const result = collectPages(first, continuation => tool.execute('get_storyboard_context', continuation))
  assert.equal(result.values.get('objects')!.size, 7)
  assert.equal(result.values.get('visual_profile_catalog')!.size, ids.length)
  const object = result.values.get('objects')!.get(scene.id)
  assert.equal(object.bindings.length, 6)
  assert.equal(object.action, action)
  const catalogProfile = result.values.get('visual_profile_catalog')!.get(ids[0])
  assert.equal(catalogProfile.reference_assets.length, 100)
  assert.doesNotThrow(() => tool.execute('propose_shot_plan', plan))
  const original = one<any>('SELECT * FROM visual_profiles WHERE id=?', ids[0])!
  assert.throws(() => tool.execute('propose_visual_profile_draft', { summary: '目录不能授权', profiles: [{ profile_id: original.id, base_version: resourceVersion(original), profile: profileValue }] }), /操作前请读取/)
  const partial = resourceTools(project.id), partialPage: any = partial.execute('get_storyboard_context', { limit: 3 })
  run('UPDATE visual_profiles SET definition=? WHERE id=?', '档案定义变化', ids.at(-1))
  assert.throws(() => partial.execute('get_storyboard_context', partialPage.continuation), /读取源版本已变化/)
})
