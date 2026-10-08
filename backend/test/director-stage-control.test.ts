import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { directorStageContext, type DirectorStageContext } from '../src/script-workflow.js'
import { directorStageContext as frontendContext } from '../../web/src/script-workflow.ts'
import { activeReplyChoice, replyWorkflowAction, replyClassificationVersion } from '../../web/src/script-reply.ts'

const testData = await mkdtemp(join(tmpdir(), 'studio-director-stages-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db } = await import('../src/db.js')
const { installSkillBundle, configureSkill } = await import('../src/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '阶段测试', base_url: 'https://stages.example.invalid/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '阶段对话' })
  return { project, model }
}
function mock(t: { after: (callback: () => void) => void }, reply: (prompt: string) => unknown) {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, init) => new Response(JSON.stringify({ choices: [{ message: { content: (() => {
    const output = reply(JSON.parse(String(init?.body)).messages[0].content)
    return typeof output === 'string' ? output : JSON.stringify(output)
  })() } }] }), { headers: { 'Content-Type': 'application/json' } })
}
type Reply = { reply: string; draft?: { stage: string }; stage_context: DirectorStageContext }
async function chat(project: string, body: unknown, stream = false): Promise<Reply> {
  if (!stream) return call('POST', `/api/projects/${project}/script/director/chat`, body)
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project}/script/director/chat/stream`, payload: body })
  assert.equal(response.statusCode, 200, response.body)
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.equal(events.some(event => event.type === 'error'), false, response.body)
  return events.find(event => event.type === 'done')
}
function intentContext(prompt: string) { return JSON.parse(prompt.split('上下文：\n')[1]!) }

test('new-project discussion is scoped to outline in both transports, keeps Skills and gates structured interactions', async t => {
  const { project, model } = await fixture()
  const skill = installSkillBundle({ repo: 'test/stage-skill', path: 'script', name: '编剧规则', description: '测试', license: null,
    revision: 'a'.repeat(40), files: [{ path: 'script/SKILL.md', content: '---\nname: 编剧规则\ndescription: 测试\n---\n阶段测试Skill标记：人物动机必须支撑主线。' }], tool_requirements: [], suggested_stages: ['script'], url: 'https://example.invalid' })
  configureSkill(skill.id, true, ['script'])
  let interaction = { stage: 'outline', purpose: 'setting' }
  mock(t, prompt => {
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      assert.equal(intentContext(prompt).stage_context.stage, 'outline')
      return { action: 'discuss' }
    }
    assert.match(prompt, /阶段测试Skill标记/)
    assert.match(prompt, /程序确定的当前创作阶段/)
    assert.match(prompt, /第一份正式成果应是全剧大纲/)
    assert.match(prompt, /stage 指该问题服务的正式成果/)
    return { kind: 'confirmation', question: '主角寻找姐姐作为主线可以吗？', interaction, intro: '已整理主线。' }
  })
  const body = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '我想写一个寻找姐姐的故事' }] }
  for (const stream of [false, true]) {
    const result = await chat(project.id, body, stream)
    assert.deepEqual(result.stage_context, directorStageContext({}))
    assert.deepEqual(JSON.parse(result.reply).interaction, interaction)
    const message = { id: 'reply', role: 'assistant' as const, text: result.reply, stage_context: result.stage_context }
    assert.ok(activeReplyChoice([message], {}, null, result.stage_context))
  }
  interaction = { stage: 'characters', purpose: 'generate' }
  const incorrect = await chat(project.id, body)
  const message = { id: 'wrong', role: 'assistant' as const, text: incorrect.reply, stage_context: incorrect.stage_context }
  assert.equal(activeReplyChoice([message], {}, null, incorrect.stage_context), null)
  assert.equal(replyWorkflowAction([message], incorrect.stage_context), null)
})

test('ordinary continuation cannot generate another stage or redo saved characters; explicit text and buttons can', async t => {
  const { project, model } = await fixture()
  let decision: Record<string, unknown> = { action: 'draft', operation: 'create', workflow: { stage: 'characters' }, creative_brief: '补全人物' }
  let writerCalls = 0
  mock(t, prompt => {
    if (prompt.includes('本次独立调用只理解创作者意图')) return decision
    writerCalls++
    return { artifacts: [{ artifact_type: 'characters', title: '人物', content: '姐姐与弟弟' }], scenes: [] }
  })
  const body = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '继续' }] }
  for (const stream of [false, true]) {
    const blocked = await chat(project.id, body, stream)
    assert.equal(blocked.draft, undefined)
    assert.match(blocked.reply, /当前应先完成全剧故事大纲/)
  }
  assert.equal(writerCalls, 0)
  decision = { ...decision, authorization: 'explicit' }
  assert.equal((await chat(project.id, { ...body, messages: [{ role: 'user', text: '先生成全剧人物设定' }] })).draft?.stage, 'characters')
  assert.equal((await chat(project.id, { ...body, workflow: { stage: 'characters' } })).draft?.stage, 'characters')
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'characters', artifacts: [{ artifact_type: 'characters', title: '人物', content: '已保存人物' }] })
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'outline', artifacts: [{ artifact_type: 'outline', title: '大纲', content: '已保存大纲' }] })
  decision = { ...decision, authorization: 'continue' }
  const blocked = await chat(project.id, body)
  assert.match(blocked.reply, /当前应先完成全剧场景设计/)
  assert.equal(blocked.draft, undefined)
  assert.equal(writerCalls, 2)
})

test('confirmed saving alone advances each default stage and keeps frontend/backend stage policies identical', async t => {
  const { project, model } = await fixture()
  let stage = 'outline'
  mock(t, prompt => prompt.includes('本次独立调用只理解创作者意图')
    ? { action: 'draft', operation: 'create', workflow: { stage, episode_number: stage === 'episode' ? 1 : 0 }, creative_brief: '整理当前阶段' }
    : { artifacts: [{ artifact_type: stage === 'episode' ? 'episode_script' : stage, title: stage, content: '已确认故事事实' }],
      scenes: stage === 'episode' ? [{ heading: '老宅', action: '寻找姐姐', duration: 5 }] : [] })
  const body = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '整理当前阶段草稿' }] }
  const stages = ['outline', 'characters', 'locations', 'props', 'episode']
  for (const [index, target] of stages.entries()) {
    stage = target
    const before = (await call<{ script: Record<string, unknown> }>('GET', `/api/projects/${project.id}`)).script
    assert.equal(directorStageContext(before).stage, target)
    const result = await chat(project.id, body)
    assert.equal(result.draft?.stage, target)
    const afterGeneration = (await call<{ script: Record<string, unknown> }>('GET', `/api/projects/${project.id}`)).script
    assert.deepEqual(afterGeneration, before, 'generation does not save or advance')
    const saved = await call<Record<string, unknown>>('PUT', `/api/projects/${project.id}/script/director/draft`, {
      ...result.draft, generation_options: { episode_count: 1 },
    })
    assert.equal(directorStageContext(saved).stage, stages[index + 1] || null)
    assert.deepEqual(frontendContext(saved), directorStageContext(saved))
  }
})

test('explicit discussion scope survives answers, skips and reload, then expires when saved progress changes', async t => {
  const { project, model } = await fixture()
  let decision: unknown = { action: 'discuss', discussion: { stage: 'props' } }
  mock(t, prompt => {
    if (prompt.includes('本次独立调用只理解创作者意图')) return decision
    return { kind: 'input_request', question: '关键道具的材质？', interaction: { stage: 'props', purpose: 'setting' }, fields: [{ id: 'material', label: '材质' }] }
  })
  const body = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '先讨论道具设计' }] }
  const result = await chat(project.id, body)
  assert.equal(result.stage_context.mode, 'explicit')
  assert.equal(result.stage_context.stage, 'props')
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'scope', messages: [{ id: 'scope-reply', role: 'assistant', text: result.reply, stage_context: result.stage_context }] })
  const reload = await call<{ conversations: Array<{ messages: Array<{ stage_context: DirectorStageContext }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  const restored = reload.conversations[0].messages[0].stage_context
  assert.deepEqual(restored, result.stage_context)
  const answering = await chat(project.id, { ...body, question_response: { status: 'skipped', question: '关键道具的材质？' }, intent_context: { discussion: restored } }, true)
  assert.deepEqual(answering.stage_context, restored)
  assert.equal(answering.draft, undefined)
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'outline', artifacts: [{ artifact_type: 'outline', title: '大纲', content: '已确认主线' }] })
  decision = { action: 'discuss' }
  const current = await chat(project.id, { ...body, intent_context: { discussion: restored } })
  assert.equal(current.stage_context.stage, 'characters')
  assert.equal(current.stage_context.mode, 'default')
})

test('pending draft keeps review mode and setting answers cannot authorize new document generation', async t => {
  const { project, model } = await fixture()
  let calls = 0
  mock(t, prompt => {
    calls++
    assert.match(prompt, /当前草稿待确认/)
    return { kind: 'workflow_action', interaction: { stage: 'outline', purpose: 'generate' }, intro: '生成新大纲？' }
  })
  for (const status of ['answered', 'skipped']) {
    const result = await chat(project.id, { model_id: model.id, mode: 'script', intent_context: { pending_draft: { stage: 'outline' } },
      question_response: { status, question: '接受寻找姐姐的主线吗？' }, messages: [{ role: 'user', text: status === 'answered' ? '接受' : '交给模型决定' }] })
    assert.equal(result.stage_context.mode, 'review')
    assert.equal(result.draft, undefined)
    assert.equal(replyWorkflowAction([{ id: status, role: 'assistant', text: result.reply, stage_context: result.stage_context }], result.stage_context), null)
  }
  assert.equal(calls, 2, 'answers bypass intent routing and remain discussion calls')
})

test('semantic workflow actions preserve target metadata and cache context through conversation reload', async t => {
  const { project, model } = await fixture()
  const context = directorStageContext({})
  const source = { id: 'natural', text: '是否开始生成全剧人物设定？', following_messages: [], stage_context: context }
  let calls = 0
  mock(t, prompt => {
    calls++
    assert.match(prompt, /识别只忠实提取意图/)
    assert.match(prompt, /"stage_context"/)
    return { messages: [{ id: source.id, classification: { type: 'workflow_action', interaction: { stage: 'characters', purpose: 'generate' } } }] }
  })
  const url = `/api/projects/${project.id}/script/replies/classify`
  await call('POST', url, { model_id: model.id, messages: [source] })
  await call('POST', url, { model_id: model.id, messages: [source] })
  assert.equal(calls, 1)
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'semantic', messages: [{ ...source, following_messages: undefined, role: 'assistant' }] })
  const reload = await call<{ conversations: Array<{ messages: Array<{ id: string; role: 'assistant'; text: string; stage_context: DirectorStageContext; classification: { type: 'workflow_action'; interaction: { stage: 'characters'; purpose: 'generate' } }; classification_version: number }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  const message = reload.conversations[0].messages[0]
  assert.equal(message.classification_version, replyClassificationVersion)
  assert.equal(replyWorkflowAction([message], context), null)
  const explicit = directorStageContext({}, { explicit: { stage: 'characters', episode_number: 0 } })
  await call('POST', url, { model_id: model.id, messages: [{ ...source, stage_context: explicit }] })
  assert.equal(calls, 2, 'same text under a different discussion scope is independently recognized')
  assert.equal(replyWorkflowAction([{ ...message, stage_context: explicit }], explicit)?.stage, 'characters')
})

test('controlled recognition repairs old missing tags and fails visibly instead of exposing unvalidated buttons', async t => {
  const { project, model } = await fixture()
  const source = { id: 'untagged', text: '是否接受寻找姐姐的主线？', following_messages: [] }
  let classification: Record<string, unknown> = { type: 'confirmation_request', status: 'pending', question: source.text }
  mock(t, () => ({ messages: [{ id: source.id, classification }] }))
  const url = `/api/projects/${project.id}/script/replies/classify`
  const body = { model_id: model.id, messages: [source] }
  await call('POST', url, body)
  const unvalidated = await app.inject({ method: 'POST', url, payload: { ...body, stage_controlled: true } })
  assert.equal(unvalidated.statusCode, 502)
  assert.match(unvalidated.body, /交互入口保持隐藏/)
  classification = { ...classification, interaction: { stage: 'outline', purpose: 'setting' } }
  const corrected = await call<{ messages: Array<{ classification: typeof classification }> }>('POST', url, { ...body, stage_controlled: true })
  assert.deepEqual(corrected.messages[0].classification, classification)
})
