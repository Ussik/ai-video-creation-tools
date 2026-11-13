import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import { workflowFixtureTypes } from './fixtures/script-workflow.js'
import type { VideoAudioPlan } from '@video-studio/shared/media/video-prompt-audio'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-script-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, now, one, run } = await import('../src/infrastructure/database/db.js')

// Start with the prior shots table to cover the additive migration.
db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
    ratio TEXT NOT NULL DEFAULT '16:9', music_asset_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE scripts (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    outline TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 5, selected_asset_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE script_artifacts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, artifact_type)
  );
`)
const timestamp = now()
run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)', 'legacy-project', '旧项目', '', '16:9', null, timestamp, timestamp)
run('INSERT INTO scripts VALUES (?, ?, ?, ?)', 'legacy-project', '', '', timestamp)
run('INSERT INTO shots VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'legacy-shot', 'legacy-project', 0, '旧镜头', '原提示词', 5, null, timestamp)
run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)', 'migration-project', '旧剧本文档', '', '16:9', null, timestamp, timestamp)
run('INSERT INTO script_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  'legacy-artifact', 'migration-project', 'episode_script', '旧正文', '保留旧正文及ID', 0, 'ready', timestamp, timestamp)

const { buildApp } = await import('../src/app.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

interface Scene {
  id: string; project_id: string; position: number; heading: string; action: string;
  duration: number; location: string; time_of_day: string; characters: string;
  dialogue: string; narration: string
}
interface Shot {
  id: string; title: string; prompt: string; image_prompt: string; video_prompt: string; source_scene_id: string | null; position: number
  audio_plan: VideoAudioPlan | null
}
interface Script {
  outline: string; characters: string; generation_options: Record<string, string>; scenes: Scene[]
}

test('empty generation idea falls back to the project name and retains saved script context', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '山海经', brief: '' })
  await call('PUT', `/api/projects/${project.id}/script`, {
    outline: '现代学生穿越上古，命名异兽', characters: '主角与引路人', scenes: [],
  })
  const result = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/generate/prompt`, { idea: '' })
  assert.match(result.prompt, /创意：山海经/)
  assert.match(result.prompt, /现代学生穿越上古，命名异兽/)
  assert.match(result.prompt, /主角与引路人/)
  const saved = await call<{ script: Script }>('GET', `/api/projects/${project.id}`)
  assert.equal(saved.script.outline, '现代学生穿越上古，命名异兽')
})

test('long script scenes survive scene edits and full saves while shots retain their own duration limit', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '长场景兼容' })
  const scene = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '会议室到走廊', action: '长对话之后，主角离开会议室走入走廊。', duration: 600,
  })
  assert.equal(scene.duration, 600)
  const patched = await call<Scene>('PATCH', `/api/script-scenes/${scene.id}`, { duration: 120 })
  assert.equal(patched.duration, 120)
  const saved = await call<Script>('PUT', `/api/projects/${project.id}/script`, {
    outline: '保留长场景', characters: '', scenes: [{ ...patched, duration: 600 }],
  })
  assert.equal(saved.scenes[0]?.duration, 600)
  const committed = await call<Script>('PUT', `/api/projects/${project.id}/script/commit`, {
    outline: '修改大纲而保留场景', characters: '', scenes: saved.scenes, artifacts: [],
  })
  assert.equal(committed.scenes[0]?.duration, 600)
  for (const [method, url, payload] of [
    ['POST', `/api/projects/${project.id}/script/scenes`, { heading: '过长场景', duration: 601 }],
    ['PATCH', `/api/script-scenes/${scene.id}`, { duration: 601 }],
    ['POST', `/api/projects/${project.id}/shots`, { title: '过长镜头', duration: 31, source_scene_id: scene.id }],
  ] as const) {
    const rejected = await app.inject({ method, url, payload })
    assert.equal(rejected.statusCode, 422, rejected.body)
  }
  const afterRejection = await call<{ script: Script; shots: Shot[] }>('GET', `/api/projects/${project.id}`)
  assert.deepEqual(afterRejection.script.scenes.map(item => [item.id, item.duration]), [[scene.id, 600]])
  assert.deepEqual(afterRejection.shots, [])
})

test('legacy scene conversion rejects unplanned long scenes before creating any shots', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '长场景必须先规划' })
  const short = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '短场景', duration: 8 })
  const long = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '长场景', duration: 120 })
  const rejected = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/convert-to-shots`, payload: { scene_ids: [short.id, long.id] } })
  assert.equal(rejected.statusCode, 422, rejected.body)
  assert.match(rejected.body, /先规划分镜/)
  assert.deepEqual((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots, [])

  const planned = await call<Shot>('POST', `/api/projects/${project.id}/shots`, { title: '已规划镜头', duration: 15, source_scene_id: long.id })
  const result = await call<{ shots: Shot[]; skipped_scene_ids: string[] }>('POST', `/api/projects/${project.id}/script/convert-to-shots`, { scene_ids: [short.id, long.id] })
  assert.deepEqual(result.shots.map(item => item.source_scene_id), [short.id])
  assert.deepEqual(result.skipped_scene_ids, [long.id])
  assert.ok((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots.some(item => item.id === planned.id))
})

test('script editing is atomic and existing shots survive scene revisions', async () => {
  const legacy = await call<{ script: Script; shots: Shot[] }>('GET', '/api/projects/legacy-project')
  assert.deepEqual(legacy.script, { outline: '', characters: '', generation_options: {}, scenes: [] })
  assert.equal(legacy.shots[0]?.source_scene_id, null)
  assert.equal(legacy.shots[0]?.image_prompt, '')
  assert.equal(legacy.shots[0]?.video_prompt, '')
  assert.equal(legacy.shots[0]?.audio_plan, null, 'legacy shots keep unknown audio instead of silently becoming mute')

  const first = await call<Scene>('POST', '/api/projects/legacy-project/script/scenes', {
    heading: '站台', location: '雨夜车站', action: '列车驶入站台', duration: 6,
  })
  const second = await call<Scene>('POST', '/api/projects/legacy-project/script/scenes', {
    heading: '车厢', action: '主角进入车厢', dialogue: '有人吗？', duration: 7,
  })
  assert.equal(second.position, 1)
  const reordered = await call<Scene>('PATCH', `/api/script-scenes/${second.id}`, { position: 0, narration: '窗外风雨声' })
  assert.equal(reordered.position, 0)
  const saved = await call<Script>('PUT', '/api/projects/legacy-project/script', {
    outline: '寻找失踪的乘客', characters: '主角：林。', scenes: [
      { id: second.id, heading: '车厢', action: '林走过空座', duration: 7 },
      { id: first.id, heading: '站台', location: '雨夜车站', action: '列车驶入站台', duration: 6 },
    ],
  })
  assert.deepEqual(saved.scenes.map(scene => scene.id), [second.id, first.id])
  assert.equal(saved.outline, '寻找失踪的乘客')

  const other = await call<{ id: string }>('POST', '/api/projects', { name: '其他项目' })
  const foreign = await call<Scene>('POST', `/api/projects/${other.id}/script/scenes`, { heading: '别的场次' })
  const invalidSave = await app.inject({ method: 'PUT', url: '/api/projects/legacy-project/script', payload: {
    outline: '不应写入', characters: '', scenes: [
      { id: second.id, heading: '不应修改' }, { id: foreign.id, heading: '别的场次' },
    ],
  } })
  assert.equal(invalidSave.statusCode, 422)
  const afterRollback = await call<{ script: Script }>('GET', '/api/projects/legacy-project')
  assert.equal(afterRollback.script.outline, '寻找失踪的乘客')
  assert.equal(afterRollback.script.scenes[0]?.heading, '车厢')

  const converted = await call<{ shots: Shot[]; skipped_scene_ids: string[] }>('POST',
    '/api/projects/legacy-project/script/convert-to-shots', { scene_ids: [first.id, second.id] })
  assert.deepEqual(converted.skipped_scene_ids, [])
  assert.deepEqual(converted.shots.map(shot => shot.source_scene_id), [second.id, first.id])
  assert.deepEqual(converted.shots.map(shot => shot.position), [1, 2])
  const originalPrompt = converted.shots[0]!.prompt
  assert.match(originalPrompt, /林走过空座/)
  const secondShotForScene = await call<Shot>('POST', '/api/projects/legacy-project/shots', {
    title: '车厢特写', prompt: '林看向空座上的车票', duration: 4, source_scene_id: second.id,
  })
  assert.equal(secondShotForScene.source_scene_id, second.id)
  assert.equal(secondShotForScene.position, 3)
  const foreignShot = await app.inject({ method: 'POST', url: '/api/projects/legacy-project/shots', payload: {
    title: '错误关联', source_scene_id: foreign.id,
  } })
  assert.equal(foreignShot.statusCode, 422)
  const repeated = await call<{ shots: Shot[]; skipped_scene_ids: string[] }>('POST',
    '/api/projects/legacy-project/script/convert-to-shots', { scene_ids: [second.id, first.id] })
  assert.deepEqual(repeated.shots, [])
  assert.deepEqual(repeated.skipped_scene_ids, [second.id, first.id])

  await call('PATCH', `/api/script-scenes/${second.id}`, { action: '完全不同的动作' })
  const afterEdit = await call<{ shots: Shot[] }>('GET', '/api/projects/legacy-project')
  assert.equal(afterEdit.shots.find(shot => shot.id === converted.shots[0]!.id)?.prompt, originalPrompt)
  await call('DELETE', `/api/script-scenes/${second.id}`)
  const afterDelete = await call<{ shots: Shot[]; script: Script }>('GET', '/api/projects/legacy-project')
  assert.equal(afterDelete.shots.find(shot => shot.id === converted.shots[0]!.id)?.source_scene_id, null)
  assert.equal(afterDelete.shots.find(shot => shot.id === secondShotForScene.id)?.source_scene_id, null)
  assert.equal(afterDelete.shots.find(shot => shot.id === converted.shots[0]!.id)?.prompt, originalPrompt)
  assert.equal(afterDelete.script.scenes[0]?.position, 0)
})

test('script generation options migrate, persist, clear, and survive older saves', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '创作设定兼容' })
  const options = {
    genre: '悬疑', genre_fusion: '民俗与科幻', audience: '成年观众', era: '近未来',
    core_hook: '失踪的人每天寄回一封来自明天的信', visual_style: '冷色手绘动画',
    story_structure: '倒叙后在结尾闭环', character_notes: '主角与失踪者是多年未见的姐妹',
  }
  const saved = await call<{ generation_options: typeof options }>('PUT', `/api/projects/${project.id}/script`, {
    outline: '一封信引出失踪案', characters: '调查员和失踪者', generation_options: options,
  })
  assert.deepEqual(saved.generation_options, options)

  const detail = await call<{ script: { generation_options: typeof options } }>('GET', `/api/projects/${project.id}`)
  assert.deepEqual(detail.script.generation_options, options)

  const legacySave = await call<{ generation_options: typeof options }>('PUT', `/api/projects/${project.id}/script`, {
    outline: '旧客户端更新过的大纲', characters: '人物设定',
  })
  assert.deepEqual(legacySave.generation_options, options)

  const cleared = await call<{ generation_options: Record<string, string> }>('PUT', `/api/projects/${project.id}/script`, {
    outline: '清空设定', characters: '', generation_options: {},
  })
  assert.deepEqual(cleared.generation_options, {})

  const invalid = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script`, payload: {
    outline: '无效设定', characters: '', generation_options: { genre: '题'.repeat(301) },
  } })
  assert.equal(invalid.statusCode, 422)
})

test('script commit writes the full project document atomically', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '完整剧本文档' })
  const committed = await call<{ outline: string; scenes: Scene[]; artifacts: Array<{ artifact_type: string; content: string }> }>(
    'PUT', `/api/projects/${project.id}/script/commit`, {
      brief: '一座会记住每次告别的车站',
      outline: '林在车站寻找失踪的姐姐。',
      characters: '林：记录员；姐姐：失踪的站务员。',
      generation_options: { genre: '悬疑', episode_count: 8 },
      scenes: [{ heading: '雨夜站台', location: '旧车站', action: '林发现一张没有日期的车票', duration: 6 }],
      artifacts: [
        { artifact_type: 'synopsis', title: '故事简述', content: '每次告别都会让车站多出一条时间线。', status: 'ready' },
        { artifact_type: 'world', title: '背景设定', content: '车站只在午夜出现。', status: 'ready' },
        { artifact_type: 'props', title: '道具设计', content: '没有日期的车票是进入下一条时间线的钥匙。', status: 'ready' },
      ],
    })
  assert.equal(committed.outline, '林在车站寻找失踪的姐姐。')
  assert.equal(committed.scenes.length, 1)
  assert.deepEqual(committed.artifacts?.map(artifact => artifact.artifact_type), ['synopsis', 'world', 'props'])

  const foreignProject = await call<{ id: string }>('POST', '/api/projects', { name: '外部项目' })
  const foreignScene = await call<Scene>('POST', `/api/projects/${foreignProject.id}/script/scenes`, { heading: '不属于当前项目' })
  const invalidCommit = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/commit`, payload: {
    brief: '不应覆盖', outline: '不应覆盖', characters: '',
    scenes: [{ id: foreignScene.id, heading: foreignScene.heading }],
    artifacts: [{ artifact_type: 'world', title: '错误内容', content: '不应写入', status: 'ready' }],
  } })
  assert.equal(invalidCommit.statusCode, 422)
  const afterRollback = await call<{ script: { outline: string; artifacts?: Array<{ artifact_type: string; content: string }> } }>('GET', `/api/projects/${project.id}`)
  assert.equal(afterRollback.script.outline, '林在车站寻找失踪的姐姐。')
  assert.equal(afterRollback.script.artifacts?.find(artifact => artifact.artifact_type === 'world')?.content, '车站只在午夜出现。')
  assert.equal(afterRollback.script.artifacts?.some(artifact => artifact.content === '不应写入'), false)
})

test('configured text model returns an unsaved script draft without writing temporary output', async t => {
  const bodies: unknown[] = []
  const catalogApi = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    bodies.push(JSON.parse(body))
    response.setHeader('Content-Type', 'application/json')
    const content = bodies.length === 1
      ? '<think>先梳理故事节奏。</think>\n```json\n{"outline":"夜行列车的秘密","characters":"林：调查员","scenes":[{"heading":"抵达站台","location":"车站","action":"林走下列车","duration":6}]}\n```'
      : '这是没有 JSON 的剧本'
    response.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  await new Promise<void>(resolve => catalogApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    catalogApi.closeAllConnections()
    await new Promise<void>(resolve => catalogApi.close(() => resolve()))
  })
  const address = catalogApi.address()
  if (!address || typeof address === 'string') throw new Error('测试接口地址不可用')
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '剧本测试', base_url: `http://127.0.0.1:${address.port}/v1`,
  })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '文本模型', remote_id: 'test-text',
    modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: 'choices.0.message.content',
    },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '新剧本', brief: '原创意' })
  const generationOptions = {
    genre: '悬疑', genre_fusion: '民俗与科幻', audience: '成年观众', era: '近未来',
    core_hook: '失踪的人每天寄回一封来自明天的信', visual_style: '冷色手绘动画',
    story_structure: '倒叙后在结尾闭环', character_notes: '主角与失踪者是多年未见的姐妹',
  }
  const preview = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/generate/prompt`, {
    idea: '临时创意', target_duration: 12, generation_options: generationOptions,
  })
  assert.match(preview.prompt, /临时创意/)
  for (const value of Object.values(generationOptions)) assert.ok(preview.prompt.includes(value))
  const draft = await call<{ outline: string; scenes: Array<{ heading: string; location: string; time_of_day: string }> }>(
    'POST', `/api/projects/${project.id}/script/generate`, {
      model_id: model.id, idea: '临时创意', target_duration: 12, generation_options: generationOptions,
    })
  assert.equal(draft.outline, '夜行列车的秘密')
  assert.equal(draft.scenes[0]?.heading, '抵达站台')
  assert.equal(draft.scenes[0]?.time_of_day, '')
  assert.match(JSON.stringify(bodies[0]), /临时创意/)
  assert.equal((bodies[0] as { stream: boolean }).stream, true)
  const submitted = (bodies[0] as { messages: Array<{ content: string }> }).messages[0]!.content
  assert.match(submitted, /本次结构化返回契约/)
  assert.equal(submitted.split('【原始任务与资料】\n')[1], preview.prompt)
  assert.deepEqual((await call<{ script: Script; shots: Shot[] }>('GET', `/api/projects/${project.id}`)).script,
    { outline: '', characters: '', generation_options: {}, scenes: [] })
  await assert.rejects(readdir(join(testData, 'media', project.id)), { code: 'ENOENT' })

  const malformed = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/generate`, payload: {
    model_id: model.id, prompt_override: '请写一部阴雨车站悬疑剧。',
  } })
  assert.equal(malformed.statusCode, 422)
  assert.equal((bodies[1] as { messages: Array<{ content: string }> }).messages[0]?.content.split('【原始任务与资料】\n')[1], '请写一部阴雨车站悬疑剧。')
  assert.equal(bodies.length, 3, 'malformed model output receives one format correction')
  assert.match(malformed.json<{ raw_output: string }>().raw_output, /没有 JSON/)
  await assert.rejects(readdir(join(testData, 'media', project.id)), { code: 'ENOENT' })
  assert.equal(one<{ outline: string }>('SELECT outline FROM scripts WHERE project_id=?', project.id), undefined)
})

test('director chat uses project and script context without persisting the conversation', async t => {
  let submittedPrompt = ''
  let modelReply = '林收到的信来自她失踪多年的姐姐。先决定姐姐消失前留下了什么线索？'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    submittedPrompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0]?.content || ''
    return new Response(JSON.stringify({ choices: [{ message: { content: submittedPrompt.includes('本次独立调用只理解创作者意图') ? JSON.stringify({ action: 'discuss', settings_patch: {} }) : modelReply } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '导演对话测试', base_url: 'https://director-chat.example/v1',
  })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '导演文本模型', remote_id: 'director-chat',
    modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: 'choices.0.message.content',
    },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '明日来信', brief: '调查员收到一封来自未来的信' })
  await call('PUT', `/api/projects/${project.id}/script`, {
    outline: '失踪者每天寄回一封来自明天的信。', characters: '林：调查员；姐姐：十二年前失踪。',
    generation_options: { genre: '悬疑', core_hook: '未来寄来的信件' },
  })
  const projectBefore = await call<{ updated_at: string }>('GET', `/api/projects/${project.id}`)
  const scriptBefore = await call<{ script: Script }>('GET', `/api/projects/${project.id}`)
  const result = await call<{ reply: string }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', generation_options: { visual_style: '冷色手绘动画' },
    messages: [
      { role: 'assistant', text: '我们先确定故事的悬念核心。' },
      { role: 'user', text: '姐姐可能还活着，但她为什么不能直接回来？' },
    ],
  })
  assert.equal(result.reply, '林收到的信来自她失踪多年的姐姐。先决定姐姐消失前留下了什么线索？')
  assert.match(submittedPrompt, /明日来信/)
  assert.match(submittedPrompt, /调查员收到一封来自未来的信/)
  assert.match(submittedPrompt, /十二年前失踪/)
  assert.match(submittedPrompt, /冷色手绘动画/)
  assert.match(submittedPrompt, /姐姐可能还活着/)
  assert.match(submittedPrompt, /编剧视角讨论故事结构/)
  assert.match(submittedPrompt, /"kind":"choices"/)
  assert.match(submittedPrompt, /供底部选择按钮使用的 title/)
  assert.match(submittedPrompt, /不能把创作者尚未确认的默认值称为已确认/)
  assert.match(submittedPrompt, /不要用字母、数字、项目符号等普通文本列表代替这个结构/)
  const scriptAfter = await call<{ script: Script }>('GET', `/api/projects/${project.id}`)
  assert.deepEqual(scriptAfter.script, scriptBefore.script)
  const projectAfter = await call<{ updated_at: string }>('GET', `/api/projects/${project.id}`)
  assert.equal(projectAfter.updated_at, projectBefore.updated_at)

  modelReply = `悬疑故事可以从角色最害怕失去的东西切入，再让线索逐步逼近这个弱点。\n${JSON.stringify({
    kind: 'choices', question: '姐姐留下了什么线索？',
    options: [
      { id: 'voice-message', title: '未来语音', text: '一段标注明日日期的语音留言' },
      { id: 'train-ticket', text: '一张指向旧车站的褪色车票' },
      { id: 'family-photo', text: '一张多出陌生身影的家庭合照' },
    ],
  })}`
  const choices = await call<{ reply: string }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', focus_artifact: 'all', generation_options: {},
    messages: [{ role: 'user', text: '给我几个线索方向选。' }],
  })
  assert.deepEqual(JSON.parse(choices.reply), {
    kind: 'choices', question: '姐姐留下了什么线索？',
    intro: '悬疑故事可以从角色最害怕失去的东西切入，再让线索逐步逼近这个弱点。',
    options: [
      { id: 'voice-message', title: '未来语音', text: '一段标注明日日期的语音留言' },
      { id: 'train-ticket', text: '一张指向旧车站的褪色车票' },
      { id: 'family-photo', text: '一张多出陌生身影的家庭合照' },
    ],
  })

  modelReply = '可以考虑：其一是录音，其二是车票，最后也可以使用一张照片。'
  const freeform = await call<{ reply: string }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', focus_artifact: 'all', generation_options: {},
    messages: [{ role: 'user', text: '简要说说不同的线索可能性。' }],
  })
  assert.equal(freeform.reply, modelReply)

  const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'all', messages: [{ role: 'assistant', text: '没有新的创作者消息' }],
  } })
  assert.equal(invalid.statusCode, 422)
})

test('episode document migration preserves old IDs and supports separate episode documents', async () => {
  const migrated = one<{ id: string; content: string; episode_number: number }>('SELECT * FROM script_artifacts WHERE id=?', 'legacy-artifact')
  assert.equal(migrated?.content, '保留旧正文及ID')
  assert.equal(migrated?.episode_number, 0)
  const saved = await call<{ artifacts: Array<{ id: string; episode_number: number }> }>('PUT', '/api/projects/migration-project/script/artifacts', {
    artifacts: [1, 2].map(episode_number => ({ artifact_type: 'episode_script', episode_number, title: `第${episode_number}集`, content: '新正文', status: 'ready' })),
  })
  assert.equal(saved.artifacts.length, 3)
  assert.equal(saved.artifacts.find(item => item.episode_number === 0)?.id, 'legacy-artifact')
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('workflow generation preserves complete documents while continuing missing drafts, streams selected episodes and never writes them', async t => {
  const outlineArtifacts = scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}：林照追查明日报纸。` }))
  let modelReply = JSON.stringify({ artifacts: outlineArtifacts, scenes: [] })
  let submittedPrompt = '', generationReplies = 0
  let workflowStage: 'outline' | 'episode' = 'outline'
  let workflowOperation: 'create' | 'regenerate' = 'create'
  const generationPrompts: string[] = []
  const continuedTypes: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const completeness = draftCompletenessFixtureResponse(init); if (completeness) return completeness
    submittedPrompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0]?.content || ''
    const intent = submittedPrompt.includes('本次独立调用只理解创作者意图')
    if (!intent) generationPrompts.push(submittedPrompt)
    let reply: string
    if (intent) reply = JSON.stringify({ action: 'draft', operation: workflowOperation, workflow: { stage: workflowStage, ...(workflowStage === 'episode' ? { episode_number: 2 } : {}) }, creative_brief: '林照追查明日报纸，遵守已确认资料。' })
    else {
      generationReplies++
      if (submittedPrompt.includes('【输出截断后的创作接续任务】')) {
        const target = /当前目标：([a-z_]+)/.exec(submittedPrompt)?.[1]
        const artifact = outlineArtifacts.find(item => item.artifact_type === target)
        assert.ok(artifact, `unexpected continuation target: ${target}`)
        assert.ok(submittedPrompt.includes(JSON.stringify(outlineArtifacts[0])), 'every continuation receives the original complete document verbatim')
        assert.doesNotMatch(submittedPrompt, /【一次格式修正】/, 'retained prose must not trigger a competing whole-stage rewrite')
        continuedTypes.push(artifact.artifact_type)
        reply = JSON.stringify({ blocks: [{ id: `artifact:${target}`, title: artifact.title, content: artifact.content, scenes: [] }], complete: true })
      } else {
        const value = JSON.parse(modelReply)
        if (workflowStage === 'outline' && workflowOperation === 'create') {
          const types = workflowFixtureTypes(submittedPrompt)
          value.artifacts = value.artifacts.filter((item: { artifact_type: string }) => types.includes(item.artifact_type as any))
          if (types.includes('synopsis')) value.artifacts = value.artifacts.slice(0, 1)
        }
        reply = JSON.stringify(value)
      }
    }
    return Response.json({ choices: [{ message: { content: reply } }] })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '阶段生成测试', base_url: 'https://workflow.example/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '阶段文本', remote_id: 'workflow', modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
    },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '借光的人', brief: '改变未来就会失去记忆' })
  const request = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '总共3集，每集60秒，先整理大纲' }], generation_options: { episode_count: 3 }, workflow: { stage: 'outline', intent: 'stage_design' } }
  const draft = await call<{ reply: string; draft: { stage: string; scenes: Scene[]; artifacts: typeof outlineArtifacts } }>('POST', `/api/projects/${project.id}/script/director/chat`, request)
  assert.equal(generationReplies, 6, 'five dependency groups plus one continuation of the partial narrative group')
  assert.deepEqual(continuedTypes, ['structure'], 'only the unfinished document in the narrative group is continued')
  assert.ok(generationPrompts.some(prompt => /输出截断后的创作接续任务[\s\S]*当前目标：structure/.test(prompt)))
  assert.equal(draft.draft.stage, 'outline')
  assert.deepEqual(draft.draft.artifacts, outlineArtifacts)
  assert.deepEqual(draft.draft.scenes, [])
  assert.match(submittedPrompt, /episode_outline/)
  assert.doesNotMatch(submittedPrompt, /"kind":"choices"/)
  assert.equal((await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script.outline, '')
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, draft.draft)
  const savedOutline = await call<{ script: { artifacts: typeof outlineArtifacts } }>('GET', `/api/projects/${project.id}`)
  assert.deepEqual(savedOutline.script.artifacts.map(doc => doc.artifact_type), [...scriptStageArtifacts.outline])
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    ...[...scriptStageArtifacts.characters, ...scriptStageArtifacts.locations].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '已确认的人物与空间资料', status: 'ready' })),
    { artifact_type: 'props', title: '道具设计', content: '红色齿轮挂件，边缘有缺口', status: 'ready' },
    { artifact_type: 'episode_script', episode_number: 1, title: '第1集', content: '上一集末尾林照忘记弟弟的名字。', status: 'ready' },
  ] })
  modelReply = JSON.stringify({ artifacts: [{ artifact_type: 'episode_script', title: '模型标题', content: '第二集：报纸改变。' }], scenes: [
    { heading: '修车铺', location: '修车铺', action: '林照抓住红色挂件', duration: 20 },
    { heading: '出租车', action: '报纸字迹改变', dialogue: '你认识我吗？', duration: 25 },
    { heading: '天桥', action: '陌生乘客出现', duration: 15 },
  ] })
  const before = await call<{ script: Script }>('GET', `/api/projects/${project.id}`)
  workflowStage = 'episode'
  const streamed = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
    ...request, workflow: { stage: 'episode', episode_number: 2, target_duration: 60 }, messages: [{ role: 'user', text: '开始写第2集' }],
  } })
  assert.equal(streamed.statusCode, 200, streamed.body)
  const events = streamed.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  const done = events.find(event => event.type === 'done')
  assert.ok(done?.draft, JSON.stringify(events))
  assert.equal(done?.draft.episode_number, 2)
  assert.equal(done?.draft.artifacts[0].title, '模型标题')
  assert.equal(done?.draft.scenes.reduce((sum: number, scene: Scene) => sum + scene.duration, 0), 60)
  assert.match(submittedPrompt, /只写第 2 集，不写其他集/)
  assert.match(submittedPrompt, /上一集末尾林照忘记弟弟的名字/)
  assert.match(submittedPrompt, /红色齿轮挂件/)
  assert.deepEqual((await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script, before.script)
  modelReply = JSON.stringify({ artifacts: [{ artifact_type: 'props', title: '错误阶段', content: '不应该保存' }], scenes: [] })
  workflowStage = 'outline'
  workflowOperation = 'regenerate'
  const malformed = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { ...request, workflow: { stage: 'outline', operation: workflowOperation } } })
  assert.equal(malformed.statusCode, 422)
  assert.deepEqual((await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script, before.script)
})

test('design JSON continues missing subdocuments without rewriting retained text and whole-script generation repairs its full output', async t => {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '设计子文档验证', base_url: 'https://design.example/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '设计文本', remote_id: 'design', modality: 'text', protocol: 'chat_completions', settings: {
    structured_output_mode: 'json_schema', request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '车站与怀表' })
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [...scriptStageArtifacts.outline, ...scriptStageArtifacts.characters].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '已确认的故事与人物资料', status: 'ready' })) })
  let stage: 'locations' | 'props' = 'locations', whole = false, attempts = 0
  let operation: 'create' | 'regenerate' = 'create'
  const prompts: string[] = []
  const continuedTypes: string[] = []
  const artifactsFor = (value: 'locations' | 'props') => scriptStageArtifacts[value].map(artifact_type => ({ artifact_type, title: `车站故事 · ${scriptArtifactLabels[artifact_type]}`, content: `${scriptArtifactLabels[artifact_type]}：第1集车站里的怀表。` }))
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const completeness = draftCompletenessFixtureResponse(init); if (completeness) return completeness
    const body = JSON.parse(String(init?.body)), prompt: string = body.messages[0].content
    if (prompt.includes('本次独立调用只理解创作者意图')) return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'draft', operation, workflow: { stage }, creative_brief: '整理车站与怀表资料。' }) } }] })
    prompts.push(prompt)
    const all = whole ? [...artifactsFor('locations'), ...artifactsFor('props')] : artifactsFor(stage)
    const complete = whole ? all : all.filter(item => workflowFixtureTypes(prompt, scriptStageArtifacts[stage]).includes(item.artifact_type))
    attempts++
    const contract = body.response_format.json_schema
    if (contract.name === 'script_stage_blocks') {
      assert.equal(whole, false, 'only staged generation continues individual documents')
      assert.deepEqual(contract.schema.required, ['blocks', 'complete'])
      assert.equal(contract.schema.properties.blocks.items.properties.scenes.maxItems, 0, 'design documents cannot generate episode scenes')
      const target = /当前目标：([a-z_]+)/.exec(prompt)?.[1]
      const artifact = complete.find(item => item.artifact_type === target)
      assert.ok(artifact, `unexpected continuation target: ${target}`)
      assert.ok(prompt.includes(JSON.stringify(complete[0])), 'the initially retained document remains exact throughout continuation')
      assert.doesNotMatch(prompt, /【一次格式修正】/, 'a missing document cannot cause a whole-stage rewrite after prose was retained')
      continuedTypes.push(artifact.artifact_type)
      return Response.json({ choices: [{ message: { content: JSON.stringify({ blocks: [{ id: `artifact:${target}`, title: artifact.title, content: artifact.content, scenes: [] }], complete: true }) } }] })
    }
    const schema = JSON.stringify(contract.schema)
    for (const type of whole ? [...scriptStageArtifacts.locations, ...scriptStageArtifacts.props] : workflowFixtureTypes(prompt, scriptStageArtifacts[stage])) assert.ok(schema.includes(`"${type}"`), type)
    const artifacts = attempts === 1 ? complete.slice(0, whole ? 7 : 1) : complete
    const result = whole ? { outline: '车站主线', characters: '林：调查员', scenes: [{ heading: '车站', duration: 8 }], artifacts } : { artifacts, scenes: [] }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  for (const value of ['locations', 'props'] as const) {
    stage = value; attempts = 0; prompts.length = 0; continuedTypes.length = 0
    const before = (await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script
    const result = await call<{ draft: { stage: string; episode_number: number; artifacts: ReturnType<typeof artifactsFor>; scenes: Scene[] } }>('POST', `/api/projects/${project.id}/script/director/chat`, {
      model_id: model.id, mode: 'script', workflow: { stage, episode_number: 7 }, messages: [{ role: 'user', text: `整理${stage === 'locations' ? '场景' : '道具'}设计` }],
    })
    assert.equal(attempts, 3, 'two dependency groups plus one continuation preserve the first complete document')
    assert.deepEqual(continuedTypes, [stage === 'locations' ? 'location_layouts' : 'prop_functions'])
    assert.match(prompts[1], /输出截断后的创作接续任务/)
    for (const type of workflowFixtureTypes(prompts[0], scriptStageArtifacts[stage])) assert.ok(prompts[0].includes(`${type}（${scriptArtifactLabels[type]}）`))
    assert.equal(result.draft.episode_number, 0)
    assert.deepEqual(result.draft.artifacts, artifactsFor(stage))
    assert.deepEqual((await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script, before)
    await call('PUT', `/api/projects/${project.id}/script/director/draft`, result.draft)
    const saved = (await call<{ script: Script }>('GET', `/api/projects/${project.id}`)).script
    for (const artifact of artifactsFor(stage)) assert.ok(saved.artifacts!.some(doc => doc.artifact_type === artifact.artifact_type && doc.title === artifact.title && doc.content === artifact.content))
    assert.deepEqual(saved.scenes, [])
    const task = await call<{ source_artifact_ids: string[] }>('POST', `/api/projects/${project.id}/asset-tasks`, { focus_artifact: stage === 'locations' ? 'location' : 'prop' })
    for (const type of scriptStageArtifacts[stage]) assert.ok(task.source_artifact_ids.includes(saved.artifacts!.find(doc => doc.artifact_type === type)!.id))
  }
  stage = 'locations'; operation = 'regenerate'; attempts = 0; prompts.length = 0
  await call('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', workflow: { stage, operation }, messages: [{ role: 'user', text: '按全剧空间与道具一致性重新设计场景' }] })
  assert.ok(prompts[0].includes('"artifact_type":"prop_continuity"'), 'the last of 19 global documents must remain in the writer context')
  whole = true; attempts = 0; prompts.length = 0
  const preview = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/generate/prompt`, {})
  for (const type of [...scriptStageArtifacts.locations, ...scriptStageArtifacts.props]) assert.ok(preview.prompt.includes(type))
  const generated = await call<{ artifacts: ReturnType<typeof artifactsFor> }>('POST', `/api/projects/${project.id}/script/generate`, { model_id: model.id })
  assert.equal(attempts, 2)
  assert.match(prompts[1], /一次格式修正[\s\S]*归属与状态流转/)
  assert.equal(generated.artifacts.length, 8)
})

test('confirming stages preserves other documents, episodes, scene IDs and existing shots', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '分阶段保存' })
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, {
    stage: 'outline', source_version: null, brief: '追查失踪的弟弟', generation_options: { episode_count: 3 },
    artifacts: [{ artifact_type: 'outline', title: '故事大纲', content: '三次改变未来' }],
  })
  const characterDraft = { stage: 'characters', source_version: null, artifacts: [{ artifact_type: 'characters', title: '人物小传', content: '林照：夜班司机。' }] }
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, characterDraft)
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'props', source_version: null, artifacts: [{ artifact_type: 'props', title: '道具', content: '明日报纸' }] })
  const episodeDraft = (episode_number: number, action: string) => ({ stage: 'episode', episode_number, source_version: null,
    artifacts: [{ artifact_type: 'episode_script', title: `第${episode_number}集剧本`, content: action }],
    scenes: [{ heading: '出租车', action, duration: 12 }],
  })
  const first = await call<{ scenes: Scene[]; artifacts: Array<{ id: string; episode_number: number; content: string }> }>('PUT', `/api/projects/${project.id}/script/director/draft`, episodeDraft(1, '第一集正文'))
  const sceneId = first.scenes[0]!.id
  const docId = first.artifacts.find(item => item.episode_number === 1)!.id
  const shots = await call<{ shots: Shot[] }>('POST', `/api/projects/${project.id}/script/convert-to-shots`, { scene_ids: [sceneId] })
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, episodeDraft(2, '第二集正文'))
  const revised = await call<{ outline: string; characters: string; scenes: Array<Scene & { episode_number: number }>; artifacts: Array<{ id: string; artifact_type: string; episode_number: number; content: string }> }>('PUT', `/api/projects/${project.id}/script/director/draft`, episodeDraft(1, '第一集修订'))
  assert.equal(revised.outline, '三次改变未来')
  assert.equal(revised.characters, '林照：夜班司机。')
  assert.equal(revised.scenes.length, 2)
  assert.equal(revised.scenes[0]?.id, sceneId)
  assert.equal(revised.scenes[1]?.action, '第二集正文')
  assert.equal(revised.artifacts.find(item => item.episode_number === 1)?.id, docId)
  assert.equal(revised.artifacts.find(item => item.episode_number === 2)?.content, '第二集正文')
  assert.equal(revised.artifacts.find(item => item.artifact_type === 'props')?.content, '明日报纸')
  const detail = await call<{ script: typeof revised; shots: Shot[] }>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shots[0]?.source_scene_id, sceneId)
  assert.equal(detail.shots[0]?.prompt, shots.shots[0]?.prompt)
  const invalid = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/director/draft`, payload: { ...characterDraft, scenes: [{ heading: '不该出现', duration: 5 }] } })
  assert.equal(invalid.statusCode, 422)
  assert.deepEqual((await call<{ script: typeof revised }>('GET', `/api/projects/${project.id}`)).script, detail.script)
  const full = await call<{ artifacts: typeof revised.artifacts }>('PUT', `/api/projects/${project.id}/script/commit`, { outline: revised.outline, characters: revised.characters, scenes: revised.scenes, artifacts: revised.artifacts.map(({ artifact_type, episode_number, content }) => ({ artifact_type, episode_number, content, title: `${artifact_type}${episode_number}` })) })
  assert.equal(full.artifacts.length, revised.artifacts.length)
  assert.equal(full.artifacts.find(item => item.episode_number === 1)?.id, docId)
})

test('script director conversations persist per project and replace their messages atomically', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '对话保存' })
  const saved = await call<{ id: string; label: string; messages: Array<{ role: string; text: string }> }>(
    'PUT', `/api/projects/${project.id}/script/conversations`, {
      id: 'saved-conversation', label: '林收到一封来信', messages: [
        { id: 'm1', role: 'user', text: '写一段悬疑故事' },
        { id: 'm2', role: 'assistant', text: '信封上没有寄件人。' },
      ],
    },
  )
  assert.equal(saved.id, 'saved-conversation')
  assert.equal(saved.label, '林收到一封来信')
  const restored = await call<{ conversations: Array<typeof saved> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.deepEqual(restored.conversations[0]?.messages.map(({ role, text }) => ({ role, text })), saved.messages.map(({ role, text }) => ({ role, text })))

  await call('PUT', `/api/projects/${project.id}/script/conversations`, {
    id: saved.id, label: saved.label, messages: [{ id: 'm3', role: 'user', text: '把结尾改成开放式' }],
  })
  const replaced = await call<{ conversations: Array<{ messages: Array<{ text: string }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.deepEqual(replaced.conversations[0]?.messages.map(message => message.text), ['把结尾改成开放式'])

  const otherProject = await call<{ id: string }>('POST', '/api/projects', { name: '另一个项目' })
  const foreign = await app.inject({ method: 'PUT', url: `/api/projects/${otherProject.id}/script/conversations`, payload: {
    id: saved.id, messages: [{ role: 'user', text: '不能跨项目覆盖' }],
  } })
  assert.equal(foreign.statusCode, 422)
})

test('planned shots are reviewed before insertion and preserve existing work', async t => {
  let modelOutput = ''
  let modelReplies: string[] = [], modelCalls = 0
  let submittedPrompt = ''
  const textApi = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    submittedPrompt = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]?.content || ''
    modelCalls++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: modelReplies.shift() ?? modelOutput } }] }))
  })
  await new Promise<void>(resolve => textApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    textApi.closeAllConnections()
    await new Promise<void>(resolve => textApi.close(() => resolve()))
  })
  const address = textApi.address()
  if (!address || typeof address === 'string') throw new Error('测试接口地址不可用')
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '分镜测试', base_url: `http://127.0.0.1:${address.port}/v1`,
  })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '分镜文本模型', remote_id: 'shot-planner',
    modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: 'choices.0.message.content',
    },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '雨停之后', brief: '雨后街角' })
  const first = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '雨渐停', action: '空街上雨丝渐停', duration: 6,
  })
  const second = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '阳光', action: '第一束阳光照亮街道', duration: 5,
  })
  const third = await call<Scene>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '尾声', action: '街道安静下来', duration: 2,
  })
  const initial = await call<{ shots: Shot[] }>('POST', `/api/projects/${project.id}/script/convert-to-shots`, {
    scene_ids: [first.id, third.id],
  })
  const silentAudio: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const rainAudio: VideoAudioPlan = { version: 1, speech: [], sound_effects: ['逐渐稀疏的雨声'], music: '', silent: false }
  modelOutput = JSON.stringify({ scenes: [
    { scene_id: second.id, shots: [
      { title: '云开', prompt: '广角镜头中云层缓慢散开', image_prompt: '云层遮挡天空的静态广角首帧', video_prompt: '云层缓慢散开，镜头平稳上仰', duration: 3, audio_plan: silentAudio },
      { title: '日光', prompt: '暖光照亮街角小店湿路面', duration: 2, audio_plan: silentAudio },
    ] },
    { scene_id: first.id, shots: [
      { title: '街角', prompt: '蓝灰色空街与暖色店铺灯光', duration: 2, audio_plan: rainAudio },
      { title: '雨丝', prompt: '雨丝在店铺门前逐渐稀疏', duration: 2, audio_plan: rainAudio },
      { title: '反光', prompt: '湿路面倒映橱窗的暖黄色灯', duration: 2, audio_plan: rainAudio },
    ] },
  ] })
  const planPreview = await call<{ prompt: string }>('POST', `/api/projects/${project.id}/script/plan-shots/prompt`, {
    scene_ids: [second.id, first.id], shots_per_scene: 3,
  })
  assert.match(planPreview.prompt, /雨渐停/)
  const planningInput = { model_id: model.id, scene_ids: [second.id, first.id], shots_per_scene: 3,
    prompt_override: `${planPreview.prompt}\n额外要求：保持雨夜冷暖对比。` }
  const planned = await call<{ scenes: Array<{ scene_id: string; scene_duration: number; shots: Array<{ title: string; prompt: string; image_prompt: string; video_prompt: string; duration: number; audio_plan: VideoAudioPlan }> }> }>(
    'POST', `/api/projects/${project.id}/script/plan-shots`, planningInput)
  assert.match(submittedPrompt, /本次结构化返回契约/)
  assert.equal(submittedPrompt.split('【原始任务与资料】\n')[1], `${planPreview.prompt}\n额外要求：保持雨夜冷暖对比。`)
  assert.deepEqual(planned.scenes.map(scene => scene.scene_id), [first.id, second.id])
  assert.deepEqual(planned.scenes.map(scene => scene.shots.reduce((sum, shot) => sum + shot.duration, 0)), [6, 5])
  assert.deepEqual(planned.scenes[1]!.shots.map(shot => shot.duration), [3, 2], 'valid model timing is preserved without redistribution')
  assert.equal(planned.scenes[0]?.shots[0]?.title, '街角')
  assert.match(planned.scenes[0]!.shots[0]!.image_prompt, /单幅首帧/)
  assert.match(planned.scenes[0]!.shots[0]!.video_prompt, /连续视频/)
  assert.equal(planned.scenes[1]!.shots[0]!.image_prompt, '云层遮挡天空的静态广角首帧')
  assert.equal(planned.scenes[1]!.shots[0]!.video_prompt, '云层缓慢散开，镜头平稳上仰')
  assert.equal((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots.length, 2)

  const incorrectTiming = JSON.parse(modelOutput)
  incorrectTiming.scenes[0].shots[1].duration = 3
  const incorrectOutput = JSON.stringify(incorrectTiming), beforeCorrection = modelCalls
  modelReplies = [incorrectOutput, modelOutput]
  const corrected = await call<typeof planned>('POST', `/api/projects/${project.id}/script/plan-shots`, planningInput)
  assert.equal(modelCalls, beforeCorrection + 2, 'a 3+3 second model draft for a 5 second scene requires model correction')
  assert.match(submittedPrompt, /一次格式修正[\s\S]*镜头时长总和必须为 5 秒/)
  assert.deepEqual(corrected.scenes[1]!.shots.map(shot => shot.duration), [3, 2])
  const beforeFailure = modelCalls
  modelReplies = [incorrectOutput, incorrectOutput]
  const failedTiming = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/plan-shots`, payload: planningInput })
  assert.equal(failedTiming.statusCode, 422, failedTiming.body)
  assert.equal(modelCalls, beforeFailure + 2)
  assert.match(failedTiming.json().detail, /镜头时长总和必须为 5 秒/)
  assert.deepEqual(JSON.parse(failedTiming.json().raw_output).scenes[0].shots.map((shot: { duration: number }) => shot.duration), [3, 3],
    'an invalid uncorrected plan fails with its original timing instead of being silently rescaled')
  assert.equal((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots.length, 2, 'planning and failed correction never insert shots')

  const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/create-planned-shots`, payload: {
    request_id: randomUUID(),
    scenes: [{ scene_id: first.id, shots: [{ title: '错误时长', prompt: '短镜头', duration: 1 }] }],
  } })
  assert.equal(invalid.statusCode, 422)
  assert.equal((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots.length, 2)

  const requestId = randomUUID()
  const createPayload = {
    request_id: requestId,
    scenes: planned.scenes.map(scene => ({ scene_id: scene.scene_id, shots: scene.shots })),
  }
  const result = await call<{ shots: Shot[] }>('POST', `/api/projects/${project.id}/script/create-planned-shots`, createPayload)
  assert.equal(result.shots.length, 5)
  assert.equal(result.shots[3]!.image_prompt, planned.scenes[1]!.shots[0]!.image_prompt)
  assert.equal(result.shots[3]!.video_prompt, planned.scenes[1]!.shots[0]!.video_prompt)
  assert.deepEqual(result.shots[0]!.audio_plan, rainAudio)
  assert.deepEqual(result.shots[3]!.audio_plan, silentAudio)
  assert.deepEqual(one<{ audio_plan: VideoAudioPlan }>('SELECT audio_plan FROM shots WHERE id=?', result.shots[0]!.id)!.audio_plan, rainAudio)
  const repeated = await call<{ shots: Shot[]; replayed: boolean; payload_changed: boolean }>('POST',
    `/api/projects/${project.id}/script/create-planned-shots`, createPayload)
  assert.deepEqual(repeated.shots.map(shot => shot.id), result.shots.map(shot => shot.id))
  assert.equal(repeated.replayed, true)
  assert.equal(repeated.payload_changed, false)
  const saved = await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)
  assert.deepEqual(saved.shots.map(shot => shot.title), [
    initial.shots[0]!.title, '街角', '雨丝', '反光', '云开', '日光', initial.shots[1]!.title,
  ])
  assert.equal(saved.shots[0]?.prompt, initial.shots[0]?.prompt)
  assert.deepEqual(saved.shots.map(shot => shot.position), [0, 1, 2, 3, 4, 5, 6])
  const changedRetry = await call<{ shots: Shot[]; replayed: boolean; payload_changed: boolean }>('POST',
    `/api/projects/${project.id}/script/create-planned-shots`, {
    request_id: requestId,
    scenes: [{ scene_id: first.id, shots: [{ title: '另一份规划', prompt: '雨后街角', duration: 6 }] }],
  })
  assert.deepEqual(changedRetry.shots.map(shot => shot.id), result.shots.map(shot => shot.id))
  assert.equal(changedRetry.replayed, true)
  assert.equal(changedRetry.payload_changed, true)
  assert.equal((await call<{ shots: Shot[] }>('GET', `/api/projects/${project.id}`)).shots.length, 7)

  const otherProject = await call<{ id: string }>('POST', '/api/projects', { name: '另一个项目' })
  const foreign = await call<Scene>('POST', `/api/projects/${otherProject.id}/script/scenes`, { heading: '外部场次' })
  const foreignResult = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/create-planned-shots`, payload: {
    request_id: randomUUID(),
    scenes: [{ scene_id: foreign.id, shots: [{ title: '不应创建', prompt: '别的项目', duration: 5 }] }],
  } })
  assert.equal(foreignResult.statusCode, 422)
})
