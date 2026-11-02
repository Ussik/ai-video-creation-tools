import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project } from '../src/infrastructure/database/db.js'
import { scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import { workflowFixtureTypes } from './fixtures/script-workflow.js'

const directory = await mkdtemp(join(tmpdir(), 'script-intent-style-flow-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, one } = await import('../src/infrastructure/database/db.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

async function fixture(seedSettings = true) {
  const project = await call<Project>('POST', '/api/projects', { name: '画风确认意图回归' })
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '本地画风测试提供商', base_url: 'https://style-flow.invalid/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '画风意图模型', remote_id: 'style-flow', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' },
  })
  if (seedSettings) await saveSettings(project.id, { genre: '都市悬疑', episode_count: 12, visual_style: '真人写实', visual_style_details: { medium: '摄影', palette: '低饱和冷色' } })
  return { project, model }
}

async function saveSettings(projectId: string, generation_options: object) {
  return call('PUT', `/api/projects/${projectId}/script`, { outline: '林舟追查失踪的姐姐。', characters: '林舟：调查记者。', generation_options })
}

function modelReply(value: unknown) {
  return Response.json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }] })
}

function styleIntent(message_index: number, quote: string, extra: object = {}) {
  return { action: 'discuss', visual_style_only: true, settings_patch: { visual_style: '日漫二维动画' }, visual_style_source: { message_index, quote }, ...extra }
}

function savedSettings(projectId: string) {
  return JSON.parse(one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', projectId)!.generation_options)
}

function assertDocumentsPreserved(projectId: string) {
  const script = one<{ outline: string; characters: string }>('SELECT outline,characters FROM scripts WHERE project_id=?', projectId)!
  assert.equal(script.outline, '林舟追查失踪的姐姐。')
  assert.equal(script.characters, '林舟：调查记者。')
  for (const table of ['script_artifacts', 'script_tool_drafts', 'script_source_revisions', 'jobs']) {
    assert.equal(all(`SELECT * FROM ${table} WHERE project_id=?`, projectId).length, 0, `${table} must remain unchanged`)
  }
}

async function chat(projectId: string, body: object, stream = false) {
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/director/chat${stream ? '/stream' : ''}`, payload: body })
  assert.equal(response.statusCode, 200, response.body)
  if (!stream) return response.json()
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.equal(events.some(event => event.type === 'error'), false, response.body)
  return { ...events.find(event => event.type === 'done'), transportEvents: events }
}

test('an explicit style-only message is saved with one model request in JSON and SSE, without a get/set tool loop', async t => {
  for (const use_tools of [true, false]) for (const stream of [false, true]) {
    const { project, model } = await fixture()
    const text = '我希望是日漫的画风。'
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.match(String(url), /^https:\/\/style-flow\.invalid\/v1\/chat\/completions$/)
      requests++
      assert.equal(requests, 1, 'saving a confirmed style must not require a second model round')
      const prompt = JSON.parse(String(init.body)).messages[0].content as string
      assert.match(prompt, /本次独立调用只理解创作者意图/)
      const context = JSON.parse(prompt.split('上下文：\n')[1]!)
      assert.equal(context.messages.at(-1).text, text)
      return modelReply(styleIntent(2, text))
    })
    const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools, messages: [
      { role: 'user', text: '先确定故事方向。' },
      { role: 'assistant', text: '也可以考虑真人写实，但还未选择。' },
      { role: 'user', text },
    ] }, stream)
    assert.equal(requests, 1)
    assert.match(result.reply, /已.*保存.*日漫二维动画|日漫二维动画.*已.*保存/)
    assert.equal(projectVisualStyle(project.id).label, '日漫二维动画')
    assert.deepEqual(projectVisualStyle(project.id).details, {}, 'a new style clears unconfirmed details from the previous style')
    const options = savedSettings(project.id)
    assert.equal(options.genre, '都市悬疑')
    assert.equal(options.episode_count, 12)
    assert.equal(result.project_changed, true, 'the caller must refresh persisted project settings after the shortcut')
    assert.deepEqual(result.generation_options, options)
    if (stream) {
      const intentIndex = result.transportEvents.findIndex((event: any) => event.type === 'intent' && event.generation_options?.visual_style === '日漫二维动画')
      const doneIndex = result.transportEvents.findIndex((event: any) => event.type === 'done')
      assert.ok(intentIndex >= 0 && intentIndex < doneIndex, 'the SSE client receives updated settings before completion')
    }
    const decision = one<{ source_text: string; basis: string; content: string }>('SELECT source_text,basis,content FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!
    assert.equal(decision.source_text, text)
    assert.equal(decision.basis, 'creator_confirmed')
    assert.match(decision.content, /日漫二维动画/)
    assertDocumentsPreserved(project.id)
    t.mock.restoreAll()
  }
})

test('a mixed style and story discussion continues, and its first native tool reads the newly saved style', async t => {
  const { project, model } = await fixture()
  const text = '采用日漫二维动画画风，并继续分析姐姐失踪的动机，不要生成文档。'
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests++
    if (requests === 1) return modelReply(styleIntent(0, '采用日漫二维动画画风', { visual_style_only: false }))
    assert.equal(projectVisualStyle(project.id).label, '日漫二维动画', 'persist before the discussion model can read project settings')
    if (requests === 2) {
      assert.ok(body.tools.some((tool: any) => tool.function?.name === 'get_project_visual_style'))
      return Response.json({ choices: [{ message: { tool_calls: [{ id: 'style-read', type: 'function', function: { name: 'get_project_visual_style', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
    }
    assert.equal(requests, 3)
    const tool = JSON.parse(body.messages.findLast((message: any) => message.role === 'tool').content)
    assert.equal(tool.ok, true)
    assert.equal(tool.result.label, '日漫二维动画')
    assert.deepEqual(tool.result.details, {})
    return modelReply('姐姐主动失踪能让调查线与她的保护动机形成冲突。')
  })
  const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text }] })
  assert.equal(requests, 3)
  assert.match(result.reply, /姐姐主动失踪/)
  assert.equal(result.project_changed, true)
  assert.equal(savedSettings(project.id).visual_style, '日漫二维动画', 'discussion completion must not overwrite the new persisted style')
  assert.equal(one<{ source_text: string }>('SELECT source_text FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!.source_text, text, 'store the complete real creator message, not just its quote')
  assertDocumentsPreserved(project.id)
})

test('missing, assistant, old-user and invented-quote provenance cannot trigger an automatic style save', async t => {
  const cases = [
    { name: 'missing', source: undefined },
    { name: 'assistant', source: { message_index: 1, quote: '建议采用日漫二维动画。' } },
    { name: 'old user', source: { message_index: 0, quote: '我在考虑日漫二维动画。' } },
    { name: 'invented quote', source: { message_index: 2, quote: '我已经决定采用日漫二维动画。' } },
  ]
  for (const item of cases) {
    const { project, model } = await fixture()
    const before = projectVisualStyle(project.id)
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      const body = JSON.parse(String(init.body))
      if (requests === 1) return modelReply({ action: 'discuss', visual_style_only: true, settings_patch: { visual_style: '日漫二维动画' }, ...(item.source ? { visual_style_source: item.source } : {}) })
      assert.ok(body.tools, `${item.name} provenance must continue the ordinary discussion path`)
      return modelReply('当前继续讨论，尚未确认新画风。')
    })
    const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools: true, messages: [
      { role: 'user', text: '我在考虑日漫二维动画。' },
      { role: 'assistant', text: '建议采用日漫二维动画。' },
      { role: 'user', text: '画风先不选，继续讨论故事。' },
    ] })
    assert.equal(requests, 2, item.name)
    assert.match(result.reply, /尚未确认新画风/)
    assert.deepEqual(projectVisualStyle(project.id), before, item.name)
    assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', project.id).length, 0)
    assertDocumentsPreserved(project.id)
    t.mock.restoreAll()
  }
})

test('a rejected style or an unselected model suggestion does not alter the confirmed project style', async t => {
  for (const text of ['不要日漫画风，现有画风保持不变。', '日漫和三维动画暂时都不选，先讨论剧情。']) {
    const { project, model } = await fixture()
    const before = projectVisualStyle(project.id)
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      const body = JSON.parse(String(init.body))
      if (requests === 1) {
        assert.match(body.messages[0].content, /否定|未选/)
        return modelReply({ action: 'discuss', settings_patch: {} })
      }
      return modelReply('沿用已确认画风，继续讨论主线。')
    })
    await chat(project.id, { model_id: model.id, mode: 'script', use_tools: true, messages: [
      { role: 'assistant', text: '可以考虑日漫或三维动画。' }, { role: 'user', text },
    ] })
    assert.equal(requests, 2)
    assert.deepEqual(projectVisualStyle(project.id), before)
    assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', project.id).length, 0)
    t.mock.restoreAll()
  }
})

test('a concurrent confirmed style update during intent recognition wins and the stale intent returns 409', async t => {
  const { project, model } = await fixture()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    assert.equal(requests, 1, 'a stale style write must fail without a native tool retry')
    await saveSettings(project.id, { genre: '都市悬疑', episode_count: 12, visual_style: '水彩动画', visual_style_details: { medium: '水彩绘制' } })
    return modelReply(styleIntent(0, '采用日漫二维动画。'))
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: '采用日漫二维动画。' }],
  } })
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /画风已更新/)
  assert.equal(projectVisualStyle(project.id).label, '水彩动画')
  assert.deepEqual(projectVisualStyle(project.id).details, { medium: '水彩绘制' })
  assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', project.id).length, 0)
  assertDocumentsPreserved(project.id)
})

test('a new project saves a detailed first style or an accepted earlier proposal with its actual creator source in one model request', async t => {
  const name = '国风3D动画，卡通渲染，厚涂质感，水墨晕染的高反差光影'
  const details = { medium: '三维动画', rendering: '卡通渲染，厚涂质感', linework: '水墨晕染', palette: '高反差光影', exclusions: ['真人摄影'] }
  const scenarios = [
    [{ role: 'user', text: `本项目采用${name}，不要真人摄影。` }],
    [{ role: 'assistant', text: `我建议采用${name}，媒介为三维动画，不要真人摄影。` }, { role: 'user', text: '就按你说的这个画风' }],
  ] as const
  for (const messages of scenarios) {
    const { project, model } = await fixture(false)
    assert.equal(projectVisualStyle(project.id).source, 'unspecified')
    const message_index = messages.length - 1, text = messages[message_index]!.text
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      assert.equal(requests, 1)
      const prompt = JSON.parse(String(init.body)).messages[0].content as string
      assert.match(prompt, /本次独立调用只理解创作者意图/)
      const context = JSON.parse(prompt.split('上下文：\n')[1]!)
      assert.equal(context.messages.at(-1).text, text)
      return modelReply({ action: 'discuss', visual_style_only: true,
        settings_patch: { visual_style: name, visual_style_details: details }, visual_style_source: { message_index, quote: text } })
    })
    const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools: true, messages })
    assert.equal(requests, 1)
    assert.match(result.reply, /已保存项目画风/)
    assert.equal(projectVisualStyle(project.id).label, name)
    assert.deepEqual(projectVisualStyle(project.id).details, details)
    assert.deepEqual(result.generation_options, savedSettings(project.id))
    assert.equal(result.project_changed, true)
    assert.equal(one<{ source_text: string }>('SELECT source_text FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!.source_text, text)
    const script = await call('GET', `/api/projects/${project.id}`)
    assert.equal(script.script.outline, '')
    assert.equal(script.script.characters, '')
    assert.equal(script.script.scenes.length, 0)
    for (const table of ['script_artifacts', 'script_tool_drafts', 'jobs']) assert.equal(all(`SELECT * FROM ${table} WHERE project_id=?`, project.id).length, 0)
    t.mock.restoreAll()
  }
})

test('a mixed explicit style and outline request saves the style and still generates the complete reviewable outline', async t => {
  const { project, model } = await fixture(false)
  const text = '采用日漫二维动画画风，并生成全剧大纲：林舟追查失踪的姐姐，发现她为保护家人主动隐去身份。'
  let intentRequests = 0, writingRequests = 0, reviewRequests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const review = draftCompletenessFixtureResponse(init)
    if (review) { reviewRequests++; return review }
    const prompt = JSON.parse(String(init.body)).messages[0].content as string
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      intentRequests++
      return modelReply({ action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline' },
        creative_brief: text, settings_patch: { visual_style: '日漫二维动画' }, visual_style_source: { message_index: 0, quote: '采用日漫二维动画画风' } })
    }
    writingRequests++
    assert.equal(projectVisualStyle(project.id).label, '日漫二维动画', 'the explicit writer receives the persisted style')
    assert.match(prompt, /日漫二维动画/)
    return modelReply({ artifacts: workflowFixtureTypes(prompt).map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `${scriptArtifactLabels[artifact_type]}：林舟追查姐姐的行踪，发现她主动隐去身份以保护家人。兄妹最终合作揭开威胁。` })), scenes: [] })
  })
  const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text }] })
  assert.equal(intentRequests, 1)
  assert.equal(writingRequests, 1, 'the mixed request must not terminate at the style confirmation')
  assert.ok(reviewRequests > 0, 'the generated document draft still goes through independent review')
  assert.equal(result.workflow.stage, 'outline')
  assert.equal(result.tool_draft.status, 'pending')
  assert.deepEqual(result.tool_draft.documents.map((doc: any) => doc.artifact_type), ['outline'])
  assert.equal(result.project_changed, true)
  assert.equal(savedSettings(project.id).visual_style, '日漫二维动画')
  const script = (await call('GET', `/api/projects/${project.id}`)).script
  assert.equal(script.outline, '')
  assert.equal(script.characters, '')
  assert.equal(script.scenes.length, 0)
  assert.equal((script.artifacts || []).length, 0, 'generation cannot save formal documents')
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  assert.equal(one<{ source_text: string }>('SELECT source_text FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!.source_text, text)
})

test('a typed outline workflow bypasses interpretation and retains its already confirmed style', async t => {
  const { project, model } = await fixture(false)
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', generation_options: { visual_style: '日漫二维动画' } })
  const text = '沿用已确认的画风，按已选择的按钮生成全剧大纲，主线是林舟寻找姐姐。'
  let intentRequests = 0, writingRequests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const review = draftCompletenessFixtureResponse(init)
    if (review) return review
    const prompt = JSON.parse(String(init.body)).messages[0].content as string
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      intentRequests++
      return modelReply(styleIntent(0, '采用日漫二维动画'))
    }
    writingRequests++
    assert.equal(projectVisualStyle(project.id).label, '日漫二维动画')
    return modelReply({ artifacts: workflowFixtureTypes(prompt).map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '林舟找到姐姐，兄妹合作保护家人。' })), scenes: [] })
  })
  const result = await chat(project.id, { model_id: model.id, mode: 'script', use_tools: false, workflow: { stage: 'outline' }, messages: [{ role: 'user', text }] })
  assert.equal(intentRequests, 0)
  assert.equal(writingRequests, 1)
  assert.equal(result.draft.stage, 'outline')
  assert.deepEqual(result.draft.artifacts.map((artifact: any) => artifact.artifact_type), ['outline'])
  assert.equal(savedSettings(project.id).visual_style, '日漫二维动画')
  const script = (await call('GET', `/api/projects/${project.id}`)).script
  assert.equal(script.outline, '')
  assert.equal((script.artifacts || []).length, 0)
})

test('a persistent mixed style and outline task resumes its failed review without rewriting the style or repeating the writer', async t => {
  for (const externalStyleChange of [false, true]) {
    const { project, model } = await fixture(false)
    const text = '采用日漫二维动画画风，并生成全剧大纲：林舟寻找姐姐，最终揭开她为保护家人主动失踪的真相。'
    const taskId = crypto.randomUUID(), conversationId = crypto.randomUUID()
    const taskUrl = `/api/projects/${project.id}/script/director/tasks/${taskId}`
    const body = { model_id: model.id, mode: 'script', focus_artifact: 'all', use_tools: false, messages: [{ role: 'user', text }],
      task: { id: taskId, conversation: { id: conversationId, messages: [{ id: `question-${taskId}`, role: 'user', text }] },
        execution: { title: '画风与全剧大纲', request: text, started_at: Date.now(), focus_artifact: 'all', mode: 'script' } } }
    let intentRequests = 0, writingRequests = 0, reviewRequests = 0, failReview = true
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const reviewed = draftCompletenessFixtureResponse(init)
      if (reviewed) {
        reviewRequests++
        return failReview ? Response.json({ error: { message: 'fixture review unavailable' } }, { status: 400 }) : reviewed
      }
      const prompt = JSON.parse(String(init.body)).messages[0].content as string
      if (prompt.includes('本次独立调用只理解创作者意图')) {
        intentRequests++
        if (intentRequests > 1) await new Promise(resolve => setTimeout(resolve, 5))
        return modelReply({ action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline' },
          creative_brief: text, settings_patch: { visual_style: '日漫二维动画' }, visual_style_source: { message_index: 0, quote: '采用日漫二维动画画风' } })
      }
      writingRequests++
      assert.equal(projectVisualStyle(project.id).label, '日漫二维动画')
      return modelReply({ artifacts: workflowFixtureTypes(prompt).map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
        content: `${scriptArtifactLabels[artifact_type]}：林舟追查姐姐的行踪，发现她主动隐去身份以保护家人。兄妹最终合作揭开威胁。` })), scenes: [] })
    })
    const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
    assert.equal(first.statusCode, 200, first.body)
    const failed = await call('GET', taskUrl)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.can_resume, true, 'a confirmed style synchronization must not disable read-only review recovery')
    assert.equal(intentRequests, 1)
    assert.equal(writingRequests, 1)
    assert.ok(reviewRequests > 0)
    const decision = one<{ source_text: string; updated_at: string }>('SELECT source_text,updated_at FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!
    assert.equal(decision.source_text, text)
    assert.equal(projectVisualStyle(project.id).label, '日漫二维动画')
    const checkpoint = one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id)
    assert.ok(checkpoint, 'the completed writer must retain a recovery checkpoint after review failure')

    if (externalStyleChange) {
      await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', generation_options: { visual_style: '水彩动画' } })
      const refused = await app.inject({ method: 'POST', url: `${taskUrl}/continue`, payload: {} })
      assert.equal(refused.statusCode, 409, refused.body)
      assert.match(refused.body, /已变化/)
      assert.equal(projectVisualStyle(project.id).label, '水彩动画', 'a stale recovery must not switch an external style edit back')
      assert.equal(intentRequests, 1)
      assert.equal(writingRequests, 1)
    } else {
      failReview = false
      const continued = await call('POST', `${taskUrl}/continue`, {})
      assert.equal(continued.id, taskId)
      const replay = await app.inject({ method: 'GET', url: `${taskUrl}/stream` })
      assert.equal(replay.statusCode, 200, replay.body)
      const finished = await call('GET', taskUrl)
      assert.equal(finished.status, 'succeeded', JSON.stringify(finished.events))
      assert.equal(finished.can_resume, false)
      const completion = finished.events.find((event: any) => event.type === 'done')
      assert.equal(completion.draft.stage, 'outline')
      assert.deepEqual(completion.draft.artifacts.map((artifact: any) => artifact.artifact_type), ['outline'])
      assert.equal(writingRequests, 1, 'resume only reruns the failed review and reuses the completed writer checkpoint')
      assert.equal(projectVisualStyle(project.id).label, '日漫二维动画')
      assert.equal(one<{ updated_at: string }>('SELECT updated_at FROM script_story_decisions WHERE project_id=? AND topic=?', project.id, '视觉风格')!.updated_at,
        decision.updated_at, 'retrying the same style and creator source must not rewrite its decision timestamp')
      const syncs = finished.events.find((event: any) => event.type === 'activity')?.activity.filter((activity: any) => activity.step_id === 'confirmed_visual_style_sync')
      // Recovery resumes the typed outline task, so it does not interpret the message again; the confirmed style is
      // already saved. What must hold is that the style was written exactly once (the original run), never again.
      assert.equal(syncs.filter((activity: any) => activity.status === 'succeeded' && !activity.reused).length, 1, 'the style is saved once')
      assert.ok(!syncs.some((activity: any) => activity.status === 'failed'), 'recovery never re-attempts or fails a style write')
    }
    const script = (await call('GET', `/api/projects/${project.id}`)).script
    assert.equal(script.outline, '')
    assert.equal(script.characters, '')
    assert.equal((script.artifacts || []).length, 0)
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
    t.mock.restoreAll()
  }
})
