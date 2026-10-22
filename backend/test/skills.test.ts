import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'

const testData = await mkdtemp(join(tmpdir(), 'studio-skills-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { installedSkills, installedSkillDetail, installSkillBundle, configureSkill, normalizeSkillRepo, parseSkillDocument, loadSkillBundle, searchSkillCatalog, skillContext, withSkillRules } = await import('../src/modules/skills/skills.js')
const app = buildApp(), remoteApp = Fastify()
const revisionA = 'a'.repeat(40), revisionB = 'b'.repeat(40)
let currentRevision = revisionA, capturedPrompt = '', generated = 0
const repo = 'studio-fixture/creative-skills'
const fixture: Record<string, string> = {
  'skills/short-drama-image-prompts/SKILL.md': '---\nname: short-drama-image-prompts\ndescription: >-\n  图片与信息图提示词\n  保持人物一致\nlicense: MIT\n---\n# 图像规则\n固定人物身份，不改变比例。\n[人物](references/character-and-look.md) [场景](references/location-plate.md)\n[契约](references/stage-contract.md)',
  'skills/short-drama-image-prompts/references/character-and-look.md': '# 人物\n每个视图保持同一张脸和服装。',
  'skills/short-drama-image-prompts/references/location-plate.md': '# 场景\n门窗位置不能改变。',
  'skills/short-drama-image-prompts/references/stage-contract.md': '# 阶段契约\n图片只展示一个时间点。',
  'skills/short-drama-image-prompts/scripts/check.py': 'raise RuntimeError("must never execute")',
  'skills/short-drama-write/SKILL.md': '---\nname: short-drama-write\ndescription: 编剧规则\n---\n# 编剧\n每段对白明确人物动机。',
  'skills/short-drama-storyboard/SKILL.md': '---\nname: short-drama-storyboard\ndescription: 分镜规则\n---\n# 分镜\n每镜记录起点和终点。',
  'odd/folder/SKILL.md': '---\nname: metadata-only-id\ndescription: 技能名称与目录不同\n---\n按主体细节写作。',
}
const requests: string[] = []
const fetcher: typeof fetch = async input => {
  const url = new URL(String(input)); requests.push(url.toString())
  let result: unknown
  if (url.host === 'skills.sh') result = { count: 3, skills: [
    { name: 'short-drama-image-prompts', skillId: 'short-drama-image-prompts', source: repo, installs: 42 },
    { name: 'invalid', skillId: '../escape', source: repo, installs: 1 },
    { name: 'external', skillId: 'skill', source: 'skills.example.com/repo', installs: 1 },
  ] }
  else if (url.pathname === `/repos/${repo}`) result = { default_branch: 'creative', license: { spdx_id: 'MIT' } }
  else if (url.pathname === `/repos/${repo}/commits/creative`) result = { sha: currentRevision }
  else if (url.pathname === `/repos/${repo}/git/trees/${currentRevision}`) result = { tree: Object.entries(fixture).map(([path, body]) => ({ path, type: 'blob', size: Buffer.byteLength(body) })) }
  else if (url.host === 'raw.githubusercontent.com') {
    const prefix = `/${repo}/${currentRevision}/`
    assert.ok(url.pathname.startsWith(prefix), `immutable revision: ${url}`)
    const path = decodeURIComponent(url.pathname.slice(prefix.length))
    assert.ok(fixture[path], `fixture path ${path}`)
    return new Response(fixture[path], { status: 200 })
  } else throw new Error(`Unexpected remote: ${url}`)
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
}
remoteApp.setErrorHandler((issue, _request, reply) => reply.code((issue as { statusCode?: number }).statusCode || 422).send({ detail: issue instanceof Error ? issue.message : String(issue) }))
registerSkillRoutes(remoteApp, { fetcher, generateText: async (_projectId, _modelId, prompt) => { capturedPrompt = prompt; generated++; return JSON.stringify({ prompt: '9:16 人物从开镜位置转身，镜头缓慢推近。' }) } })
after(async () => { await remoteApp.close(); await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, target = remoteApp): Promise<T> {
  const response = await target.inject({ method, url, ...(payload !== undefined ? { payload } : {}) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

test('YAML metadata supports folded descriptions and rejects invalid documents and unsafe sources', () => {
  assert.equal(normalizeSkillRepo('https://github.com/Studio-Fixture/Creative-Skills.git'), repo)
  assert.match(parseSkillDocument(fixture['skills/short-drama-image-prompts/SKILL.md']!).description, /图片与信息图提示词 保持人物一致/)
  for (const value of ['../repo', 'https://evil.example/repo', 'owner/repo/extra', 'owner/..']) assert.throws(() => normalizeSkillRepo(value))
  for (const value of ['plain text', '---\nname: skill\n---\nBody', '---\nname: [x]\ndescription: desc\n---\nBody']) assert.throws(() => parseSkillDocument(value))
})

test('directory search filters invalid coordinates and retains install counts and source links', async () => {
  const result = await searchSkillCatalog('fixture-images', 0, fetcher)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0]?.installs, 42)
  assert.equal(result.skills[0]?.repo, repo)
  assert.match(requests.at(-1)!, /q=fixture-images/)
})

test('installation resolves nested directories, pins source version, bundles references and never executes scripts', async () => {
  const bundle = await loadSkillBundle(repo, 'short-drama-image-prompts', fetcher)
  assert.equal(bundle.path, 'skills/short-drama-image-prompts')
  assert.equal(bundle.revision, revisionA)
  assert.equal(bundle.files.length, 4)
  assert.match(bundle.tool_requirements.join(' '), /check.py/)
  assert.ok(!bundle.files.some(file => file.path.endsWith('.py')))
  const installed = await call<{ id: string; enabled: boolean; suggested_stages: string[] }>('POST', '/api/skills/install', { repo, path: 'short-drama-image-prompts' })
  assert.equal(installed.enabled, false)
  assert.deepEqual(installed.suggested_stages, ['image_prompt'])
  const repeated = await call<{ id: string }>('POST', '/api/skills/install', { repo, path: 'skills/short-drama-image-prompts' })
  assert.equal(repeated.id, installed.id)
  assert.equal(installedSkills().length, 1)
  const metadataPath = await loadSkillBundle(repo, 'metadata-only-id', fetcher)
  assert.equal(metadataPath.path, 'odd/folder')
  const rejected = await remoteApp.inject({ method: 'POST', url: '/api/skills/install', payload: { repo, path: '../escape' } })
  assert.equal(rejected.statusCode, 422)
})

test('enabling is explicit, references depend on current subject, and disabling removes runtime rules', async () => {
  const skill = installedSkills()[0]!
  assert.equal(skillContext('image_prompt', '人物').text, '')
  const empty = await remoteApp.inject({ method: 'PATCH', url: `/api/skills/${skill.id}`, payload: { enabled: true, stages: [] } })
  assert.equal(empty.statusCode, 422)
  await call('PATCH', `/api/skills/${skill.id}`, { enabled: true, stages: ['image_prompt'] })
  const context = skillContext('image_prompt', '制作人物信息图')
  assert.match(context.text, /同一张脸/)
  assert.ok(!context.text.includes('门窗位置'))
  assert.match(context.text, /本次要求的 JSON/)
  assert.equal(skillContext('video_prompt', '人物').text, '')
  await call('PATCH', `/api/skills/${skill.id}`, { enabled: false, stages: ['image_prompt'] })
  assert.equal(withSkillRules('image_prompt', '本次任务'), '本次任务')
  configureSkill(skill.id, true, ['image_prompt'])
})

test('enabled script and storyboard skills reach actual preview builders without replacing their schemas', async () => {
  const scriptSkill = installSkillBundle(await loadSkillBundle(repo, 'short-drama-write', fetcher))
  configureSkill(scriptSkill.id, true, ['script'])
  const storyboard = installSkillBundle(await loadSkillBundle(repo, 'short-drama-storyboard', fetcher))
  configureSkill(storyboard.id, true, ['storyboard'])
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '技能规则测试' }, app)
  const script = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/generate/prompt`, { idea: '雨夜车站' }, app)
  assert.match(script.prompt, /每段对白明确人物动机/)
  assert.match(script.prompt, /合法 JSON 对象/)
  assert.ok(!script.prompt.includes('每镜记录起点和终点'))
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站', action: '人物转身' }, app)
  const planned = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/plan-shots/prompt`, { scene_ids: [scene.id], shots_per_scene: 2 }, app)
  assert.match(planned.prompt, /每镜记录起点和终点/)
  assert.match(planned.prompt, /image_prompt/); assert.match(planned.prompt, /video_prompt/)
  assert.ok(!planned.prompt.includes('每段对白明确人物动机'))
})

test('prompt refinement uses bound rules and frozen settings, returns draft without writing shots or nodes, and rejects foreign references', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '人物板' }, app)
  const input = { model_id: 'text-fixture', stage: 'image_prompt', prompt: '人物三视图，保持服装', ratio: '9:16', duration: 5, mode: 'text' }
  const before = all('SELECT * FROM shots').length
  const response = await call<{ prompt: string; skills: unknown[] }>('POST', `/api/projects/${project.id}/skills/refine-prompt`, input)
  assert.match(capturedPrompt, /同一张脸/); assert.match(capturedPrompt, /9:16/)
  assert.match(capturedPrompt, /不改变比例|不要改变比例/)
  assert.equal(response.skills.length, 1)
  assert.equal(all('SELECT * FROM shots').length, before)
  assert.equal(all('SELECT * FROM jobs').length, 0)
  assert.equal(all('SELECT * FROM canvas_nodes').length, 0)
  const other = await call<{ id: string }>('POST', '/api/projects', { name: '其他项目' }, app)
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES ('foreign', ?, 'image', 'ref.png', '/tmp/ref.png', 'upload', '2026-10-08')", other.id)
  const calls = generated
  const foreign = await remoteApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, reference_asset_ids: ['foreign'] } })
  assert.equal(foreign.statusCode, 422); assert.equal(generated, calls)
  const noBinding = await remoteApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, stage: 'video_prompt' } })
  assert.equal(noBinding.statusCode, 200); assert.deepEqual(noBinding.json().skills, []); assert.equal(generated, calls + 1)
})

test('adjustment requests use the current editable draft with protected shot context and never write source content or nodes', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '定向整理' }, app)
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '雨夜站台', action: '林晚在站台等待', dialogue: '林晚：我会回来。',
  }, app)
  const visuals = await call<{ visual_profiles: Array<{ id: string; revision: number }> }>('POST', `/api/projects/${project.id}/visual-profiles`, {
    profiles: [{ kind: 'character', name: '林晚', definition: '短发、深绿雨衣', view_requirements: '正侧背与面部细节', scene_ids: [scene.id] }],
  }, app)
  const board = `${project.id}-board`, composition = `${project.id}-composition`
  for (const id of [board, composition]) run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', ?, '/tmp/ref.png', 'upload', '2026-10-17')", id, project.id, `${id}.png`)
  await call('PATCH', `/api/visual-profiles/${visuals.visual_profiles[0]!.id}`, { board_asset_id: board, expected_revision: 1 }, app)
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, {
    title: '林晚等待', source_scene_id: scene.id, video_prompt: '源分镜中的旧提示词：林晚在远景等候。',
  }, app)
  run("INSERT INTO canvas_nodes (id, project_id, position, type, x, y, width, height, shot_id, prompt) VALUES ('adjustment-node', ?, 0, 'video', 0, 0, 300, 200, ?, ?)", project.id, shot.id, '画布上尚未应用的新稿')
  run("INSERT INTO script_source_documents (project_id, filename, content, updated_at) VALUES (?, '原稿.txt', '上传的原稿保持完整', '2026-10-17')", project.id)
  const tables = ['shots', 'canvas_nodes', 'script_scenes', 'script_source_documents', 'scripts', 'visual_profiles', 'shot_visual_bindings', 'jobs']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  const prompt = '这是上轮整理后由我编辑的近景稿。林晚轻轻握拳，她说：“我会回来。”'
  const adjustment = '保留动作和对白，加强面部情绪，镜头缓慢推近。'
  await call('POST', `/api/projects/${project.id}/skills/refine-prompt`, {
    model_id: 'text-fixture', stage: 'video_prompt', shot_id: shot.id, prompt, adjustment_request: `  ${adjustment}\n`,
    ratio: '16:9', duration: 8, mode: 'reference', storyboard_reference_asset_id: composition, reference_asset_ids: [composition, board],
  })
  assert.ok(capturedPrompt.includes(`原提示词：\n${prompt}\n本次调整要求：\n${adjustment}\n`))
  assert.match(capturedPrompt, /当前提示词是本次修改基稿/)
  assert.match(capturedPrompt, /不得用其中的旧提示词替换本次基稿/)
  assert.match(capturedPrompt, /仅修改要求涉及的方面，保留其余剧情、人物身份、人物关系和逐字对白/)
  assert.match(capturedPrompt, /调整要求不能覆盖项目画风、比例、时长、生成模式、实际参考图顺序及输出格式/)
  assert.match(capturedPrompt, /不增加无依据的剧情/)
  assert.match(capturedPrompt, /不得伪造已提供参考图的可见内容/)
  assert.match(capturedPrompt, /"ratio":"16:9","duration":8,"mode":"reference"/)
  assert.match(capturedPrompt, /"image_number":1,"purpose":"storyboard"/)
  assert.match(capturedPrompt, /"image_number":2,"purpose":"character","objects":"林晚"/)
  assert.match(capturedPrompt, /短发、深绿雨衣/)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
})

test('missing and blank adjustment requests preserve ordinary refinement, and oversized requests fail before calling the model', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '整理要求兼容' }, app)
  const input = { model_id: 'text-fixture', stage: 'image_prompt', prompt: '人物站在站台边，保持原有身份。' }
  const url = `/api/projects/${project.id}/skills/refine-prompt`
  await call('POST', url, input)
  const ordinary = capturedPrompt
  assert.match(ordinary, /本次调整要求：\n未指定，按现有规则整理当前提示词。/)
  for (const adjustment_request of ['', '  \n\t ']) {
    await call('POST', url, { ...input, adjustment_request })
    assert.equal(capturedPrompt, ordinary)
  }
  const maximum = '细'.repeat(4000)
  await call('POST', url, { ...input, adjustment_request: ` ${maximum} ` })
  assert.ok(capturedPrompt.includes(`本次调整要求：\n${maximum}\n`))
  const calls = generated
  const invalid = await remoteApp.inject({ method: 'POST', url, payload: { ...input, adjustment_request: '细'.repeat(4001) } })
  assert.equal(invalid.statusCode, 422)
  assert.match(invalid.body, /adjustment_request/)
  assert.equal(generated, calls)
})

test('visual setting refinement receives the profile definition and views with the requested direction', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '设定图定向调整' }, app)
  const { visual_profiles: [profile] } = await call<{ visual_profiles: Array<{ id: string }> }>('POST', `/api/projects/${project.id}/visual-profiles`, {
    profiles: [{ kind: 'prop', name: '旧铜灯', definition: '磨损的黄铜灯罩、木制底座', view_requirements: '正面、侧面与底座特写' }],
  }, app)
  const before = all('SELECT * FROM visual_profiles')
  await call('POST', `/api/projects/${project.id}/skills/refine-prompt`, {
    model_id: 'text-fixture', stage: 'image_prompt', profile_id: profile!.id, prompt: '旧铜灯的多视图设定图。', adjustment_request: '突出黄铜磨损和木质纹理。',
  })
  assert.match(capturedPrompt, /为当前视觉设定图节点/)
  assert.match(capturedPrompt, /当前为道具设定图，依据该设定的定义与视图要求/)
  assert.match(capturedPrompt, /不套用剧情镜头或视频动作流程/)
  assert.match(capturedPrompt, /磨损的黄铜灯罩、木制底座/)
  assert.match(capturedPrompt, /正面、侧面与底座特写/)
  assert.match(capturedPrompt, /本次调整要求：\n突出黄铜磨损和木质纹理。/)
  assert.deepEqual(all('SELECT * FROM visual_profiles'), before)
})

test('a refined board override is identical in preview and task, and changing it invalidates the reference signature', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '信息图提示词' }, app)
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '车站' }, app)
  const visuals = await call<{ visual_profiles: Array<{ id: string; revision: number }> }>('POST', `/api/projects/${project.id}/visual-profiles`, {
    profiles: [{ kind: 'character', name: '阿宁', variant: '雨衣', definition: '深绿雨衣、短发', view_requirements: '正侧背与面部细节', scene_ids: [scene.id] }],
  }, app)
  const profile = visuals.visual_profiles[0]!
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '图片测试', base_url: 'https://example.invalid', adapter: 'http' }, app)
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '图片模型', remote_id: 'test-image', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/images', request_template: { prompt: '{{prompt}}' }, image_base64_path: 'data.0.b64_json' } }, app)
  const input = { model_id: model.id, expected_revision: profile.revision, prompt_override: '整理后的完整人物信息图：深绿雨衣，同一身份的正侧背视图。' }
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input, app)
  assert.equal(stripManagedPromptBlocks(preview.prompt), input.prompt_override)
  assert.match(preview.prompt, /【设定图固定要求】/)
  const task = await call<{ prompt: string }>('POST', `/api/visual-profiles/${profile.id}/board-task`, { ...input, reference_signature: preview.reference_signature }, app)
  assert.equal(task.prompt, preview.prompt)
  const changed = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/board-preview`, payload: { ...input, prompt_override: '已修改提示词', reference_signature: preview.reference_signature } })
  assert.equal(changed.statusCode, 409)
})

test('updating pins the new revision while preserving enabled stage bindings; removing a repository retains installed skills', async () => {
  const skill = installedSkills().find(item => item.name === 'short-drama-image-prompts')!
  currentRevision = revisionB
  fixture['skills/short-drama-image-prompts/references/character-and-look.md'] = '# 人物\n更新后的身份锁：眼睛与服装一致。'
  const status = await call<{ available: boolean }>('GET', `/api/skills/${skill.id}/update`)
  assert.equal(status.available, true)
  await call('POST', `/api/skills/${skill.id}/update`, {})
  const updated = installedSkillDetail(skill.id)
  assert.equal(updated.revision, revisionB); assert.equal(updated.enabled, true); assert.deepEqual(updated.stages, ['image_prompt'])
  assert.match(skillContext('image_prompt', '人物').text, /更新后的身份锁/)
  await call('POST', '/api/skills/repositories', { repo })
  await call('DELETE', `/api/skills/repositories?repo=${encodeURIComponent(repo)}`)
  assert.equal(installedSkills().length, 3)
  await call('DELETE', `/api/skills/${skill.id}`)
  assert.equal(skillContext('image_prompt', '人物').text, '')
  assert.equal(installedSkills().length, 2)
})

test('Skill prompt metadata identifies only actually loaded rules and references for each matching stage', async () => {
  const skill = installSkillBundle(await loadSkillBundle(repo, 'short-drama-image-prompts', fetcher))
  configureSkill(skill.id, true, ['image_prompt'])
  let observed: ReturnType<typeof skillContext> | undefined
  const prompt = withSkillRules('image_prompt', '制作人物信息图', context => { observed = context })
  assert.match(prompt, /同一张脸|更新后的身份锁/)
  const metadata = observed!.skills.find(item => item.id === skill.id)!
  assert.equal(metadata.revision, skill.revision)
  assert.ok(metadata.files.some(file => /SKILL\.md$/.test(file)))
  assert.ok(metadata.files.some(file => /character/.test(file)))
  assert.ok(!metadata.files.some(file => /location/.test(file)))
  assert.ok(metadata.files.every(file => observed!.files.includes(file)))
  configureSkill(skill.id, false, ['image_prompt'])
  withSkillRules('image_prompt', '制作人物信息图', context => { observed = context })
  assert.ok(!observed!.skills.some(item => item.id === skill.id))
})

test('video prompt skill receives actual numbered storyboard and object roles, synchronizes mapping, and rejects unrelated pins', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '参考分镜视频' }, app)
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '站台' }, app)
  const visuals = await call<{ visual_profiles: Array<{ id: string; revision: number }> }>('POST', `/api/projects/${project.id}/visual-profiles`, {
    profiles: [{ kind: 'character', name: '林晚', variant: '校服', definition: '短发、蓝色校服', view_requirements: '正侧背与面部细节', scene_ids: [scene.id] }],
  }, app)
  for (const id of ['video-composition', 'video-person-board']) run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', ?, '/tmp/ref.png', 'upload', '2026-10-10')", id, project.id, `${id}.png`)
  await call('PATCH', `/api/visual-profiles/${visuals.visual_profiles[0].id}`, { board_asset_id: 'video-person-board', expected_revision: visuals.visual_profiles[0].revision }, app)
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '林晚转身', source_scene_id: scene.id }, app)
  const input = { model_id: 'text-fixture', stage: 'video_prompt', shot_id: shot.id, prompt: '林晚缓慢转身，镜头平稳推近', mode: 'reference',
    visual_reference_mode: 'profiles', storyboard_reference_asset_id: 'video-composition', reference_asset_ids: ['video-composition', 'video-person-board'] }
  const response = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/skills/refine-prompt`, input)
  assert.match(capturedPrompt, /"image_number":1,"purpose":"storyboard"/)
  assert.match(capturedPrompt, /"image_number":2,"purpose":"character","objects":"林晚"/)
  assert.match(response.prompt, /图片1：分镜构图/)
  assert.match(response.prompt, /图片2：林晚（校服）/)
  assert.equal((response.prompt.match(/【视频参考图用途】/g) || []).length, 1)
  const calls = generated
  const invalid = await remoteApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, storyboard_reference_asset_id: 'unrelated' } })
  assert.equal(invalid.statusCode, 422)
  assert.equal(generated, calls)
})
