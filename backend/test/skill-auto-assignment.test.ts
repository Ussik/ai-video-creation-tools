import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-model-skills-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
const { installSkillBundle, configureSkill, skillContext, skillPolicy, setSkillDefault } = await import('../src/modules/skills/skills.js')
const { documentTools, runScriptTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const result = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
function install(name: string, description: string, stages: Parameters<typeof configureSkill>[2]) {
  const skill = installSkillBundle({ repo: 'test/model-skills', path: name, name, description, license: null, revision: 'a'.repeat(40),
    tool_requirements: [], suggested_stages: stages, url: '', files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\nRULE_${name}` }] })
  configureSkill(skill.id, true, stages)
  return skill.id
}
const write = install('short-drama-write', '创作完整短剧正文，推进冲突和人物行动。', ['script'])
const analyze = install('source-structure', '理解已有材料的人物关系、事件因果和叙事结构。', ['script'])
const board = install('shot-planning', '把场景规划成可拍摄的镜头与连续动作。', ['storyboard'])
const video = install('motion-detail', '编写镜头运动与人物动作的视频提示词。', ['video_prompt'])
setSkillDefault('script', { primary_id: write, auxiliary_ids: [] })
setSkillDefault('storyboard', { primary_id: board, auxiliary_ids: [] })
const ids = (context: ReturnType<typeof skillContext>) => context.skills.map(skill => skill.id)
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '模型选技' })
  const snapshot = () => ({ outline: '', characters: '', generation_options: {},
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', project.id),
    scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', project.id) })
  const context = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => ({ project, script: snapshot,
    stage: directorStageContext(snapshot()), skillSelections: {}, messages: [{ role: 'user' as const, text: '先弄清这份材料中每个人为什么这样做，以及事情怎样连在一起。' }],
    checkApproval: async () => false, onEvent: () => {}, ...extra })
  return { project, snapshot, context }
}
const provider = { adapter: 'http' as const, base_url: 'https://model-skills.invalid/v1' }
const model: GenerationModel = { id: 'mock', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
  settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] } } }
function toolCall(name: string, args: unknown, id = name) {
  return Response.json({ choices: [{ message: { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
}
const finalReply = () => Response.json({ choices: [{ message: { content: '已完成分析，尚未创建或保存文档。' }, finish_reason: 'stop' }] })

test('automatic catalog exposes eligible descriptions and defaults without eagerly loading rules', async () => {
  const { project, context } = await fixture()
  const disabled = install('disabled-analysis', '不可用的技能', ['script'])
  configureSkill(disabled, false, ['script'])
  const before = all('SELECT * FROM skill_stage_defaults')
  const state = await documentTools(context()).execute('get_creation_state', {}) as any
  const script = state.creation_skills.find((item: any) => item.stage === 'script')
  assert.equal(script.mode, 'model'); assert.equal(script.loaded, false); assert.equal(script.selected_ids, null)
  assert.deepEqual(script.default_ids, [write])
  assert.equal(script.eligible_skills.find((item: any) => item.id === analyze).description, '理解已有材料的人物关系、事件因果和叙事结构。')
  assert.ok(!script.eligible_skills.some((item: any) => item.id === disabled || item.id === video))
  assert.deepEqual(state.selected_skills, [])
  assert.doesNotMatch(JSON.stringify(state), /RULE_/)
  assert.deepEqual(all('SELECT * FROM skill_stage_defaults'), before)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('automatic choices require IDs and a reason, validate eligibility and freeze the chosen rules for this request', async () => {
  const { context } = await fixture(), tools = documentTools(context())
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script' }), /skill_ids.*reason/)
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: [analyze] }), /skill_ids.*reason/)
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: [video], reason: '不合适' }), /未启用或不适用/)
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: ['missing'], reason: '不存在' }), /未启用或不适用/)
  const before = all('SELECT * FROM skill_stage_defaults')
  const chosen = await tools.execute('load_creation_skills', { stage: 'script', skill_ids: [analyze], reason: '本轮需要理解已有材料的事件因果。' }) as any
  assert.deepEqual(ids(chosen), [analyze]); assert.match(chosen.text, /RULE_source-structure/)
  assert.equal(chosen.reason, '本轮需要理解已有材料的事件因果。')
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: [write], reason: '切换' }), /冻结/)
  configureSkill(analyze, false, ['script'])
  const reused = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  assert.deepEqual(ids(reused), [analyze]); assert.equal(reused.text, chosen.text)
  configureSkill(analyze, true, ['script'])
  assert.deepEqual(all('SELECT * FROM skill_stage_defaults'), before)
})

test('manual choices and explicit base rules remain locked while read-only operations need no selection', async () => {
  const { context } = await fixture()
  for (const selected of [[write], []]) {
    const tools = documentTools(context({ skillSelections: { script: selected } }))
    const state = await tools.execute('get_creation_state', {}) as any
    assert.equal(state.creation_skills[0].mode, 'manual')
    assert.deepEqual(state.creation_skills[0].locked_ids, selected)
    await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: [analyze], reason: '切换' }), /手动锁定/)
    const rules = await tools.execute('load_creation_skills', { stage: 'script' }) as any
    assert.deepEqual(ids(rules), selected)
  }
  const tools = documentTools(context())
  await tools.execute('get_document_review_context', {})
  await assert.rejects(tools.execute('submit_document_review', {}), /load_creation_skills/)
  const state = await tools.execute('get_creation_state', {}) as any
  assert.deepEqual(state.selected_skills, [])
})

test('script and resource drafting require loaded rules but still create only an authorized unsaved draft', async () => {
  const { project, context } = await fixture()
  const tools = documentTools(context({ workflow: 'outline', stage: directorStageContext(context().script(), { explicit: { stage: 'outline', episode_number: 0 } }),
    taskContract: { intent: 'stage_design', artifact_types: ['outline'] } }))
  const draft = { stage: 'outline', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'outline', title: '城市旧案', content: '林晚调查车站失踪案，循着录音追查旧日事故。' }], scenes: [] }
  await assert.rejects(tools.execute('create_document_draft', draft), /load_creation_skills/)
  await assert.rejects(tools.execute('propose_document_patch', {}), /load_creation_skills/)
  await tools.execute('load_creation_skills', { stage: 'script', skill_ids: [], reason: '按已确认内容整理单份大纲，使用基础规则。' })
  const result = await tools.execute('create_document_draft', draft) as any
  assert.ok(result.draft_id); assert.equal(result.saved, false)
  assert.equal(all('SELECT * FROM script_artifacts WHERE project_id=?', project.id).length, 0)
  const other = await fixture(), scene = await call('POST', `/api/projects/${other.project.id}/script/scenes`, { heading: '车站' })
  const resources = documentTools(other.context({ authorizeResource: async () => true }))
  const read = await resources.execute('get_storyboard_context', { scene_ids: [scene.id] }) as any
  const proposal = { summary: '车站镜头', scenes: [{ scene_id: scene.id, base_version: read.objects[0].version,
    shots: [{ title: '入站', prompt: '人物走入', image_prompt: '站在入口', video_prompt: '走入车站', duration: 5 }] }] }
  await assert.rejects(resources.execute('propose_shot_plan', proposal), /load_creation_skills/)
  await resources.execute('load_creation_skills', { stage: 'storyboard', skill_ids: [board], reason: '需要把车站行动整理成镜头。' })
  assert.equal((await resources.execute('propose_shot_plan', proposal) as any).saved, false)
  assert.equal(all('SELECT * FROM jobs WHERE project_id IN (?,?)', project.id, other.project.id).length, 0)
})

test('native Function Calling lets the model read the catalog, choose by meaning and expose its brief reason', async t => {
  const { context } = await fixture(), before = all('SELECT * FROM skill_stage_defaults')
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'load_creation_skills'))
    if (requests === 1) return toolCall('get_creation_state', {})
    const output = JSON.parse(body.messages.at(-1).content)
    if (requests === 2) {
      assert.equal(output.result.creation_skills[0].loaded, false)
      assert.ok(output.result.creation_skills[0].eligible_skills.some((skill: any) => skill.id === analyze && skill.description.includes('事件因果')))
      return toolCall('load_creation_skills', { stage: 'script', skill_ids: [analyze], reason: '当前请求关注人物动机和事件关系，适合已有材料分析。' })
    }
    assert.deepEqual(ids(output.result), [analyze]); assert.match(output.result.text, /RULE_source-structure/)
    return finalReply()
  })
  const result = await runScriptTools({ ...context(), model, provider, prompt: '按当前请求判断所需技能。', resolveKey: () => '' })
  assert.equal(requests, 3)
  assert.ok(result.activity.some(item => item.name === 'load_creation_skills' && item.summary.includes('人物动机和事件关系')))
  assert.equal(result.tool_draft, undefined)
  assert.deepEqual(all('SELECT * FROM skill_stage_defaults'), before)
})

test('native stage-generation tool visibility includes model selection before draft creation', async t => {
  const { context } = await fixture()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'load_creation_skills'))
    assert.doesNotMatch(body.messages[0].content, /不要重复加载技能/)
    if (requests === 1) return toolCall('load_creation_skills', { stage: 'script', skill_ids: [write], reason: '生成阶段大纲，使用短剧创作方法。' })
    return finalReply()
  })
  await runScriptTools({ ...context({ workflow: 'outline' }), model, provider, prompt: '生成当前大纲。', resolveKey: () => '' })
  assert.equal(requests, 2)
})

test('director initial prompt exposes the catalog without auto rules, while manual selections remain injected', async t => {
  const { project } = await fixture()
  const p = await call('POST', '/api/providers', { name: '导演模型选技', base_url: 'https://director-model-skills.invalid/v1' })
  const m = await call('POST', '/api/models', { provider_id: p.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const prompts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); prompts.push(body.messages[0].content)
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'load_creation_skills'))
    return finalReply()
  })
  const request = { model_id: m.id, mode: 'script', use_tools: true, question_response: { status: 'answered', question: '本次需要做什么？' },
    messages: [{ role: 'user', text: '帮我弄清每个人为什么这样做。' }] }
  await call('POST', `/api/projects/${project.id}/script/director/chat`, request)
  assert.match(prompts[0], /creation_skills/); assert.match(prompts[0], /事件因果/); assert.doesNotMatch(prompts[0], /RULE_/)
  await call('POST', `/api/projects/${project.id}/script/director/chat`, { ...request, skill_selections: { script: [write] } })
  assert.match(prompts[1], /RULE_short-drama-write/); assert.doesNotMatch(prompts[1], /RULE_source-structure/)
  await call('POST', `/api/projects/${project.id}/script/director/chat`, { ...request, skill_selections: { script: [] } })
  assert.doesNotMatch(prompts[2], /RULE_/)
  assert.equal(skillPolicy(project.id)[0].primary_id, write)
})

test('director fallback uses a native selection call and freezes the returned IDs for actual generation', async t => {
  const { project } = await fixture()
  const p = await call('POST', '/api/providers', { name: '兼容导演选技', base_url: 'https://fallback-model-skills.invalid/v1' })
  const m = await call('POST', '/api/models', { provider_id: p.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let selections = 0, generations = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools?.some((tool: any) => tool.function.name === 'select_creation_skills')) {
      selections++; assert.doesNotMatch(body.messages[0].content, /RULE_/)
      return toolCall('select_creation_skills', { skill_ids: [analyze], reason: '这次讨论关心已有材料中的动机和因果。' })
    }
    generations++; assert.match(body.messages[0].content, /RULE_source-structure/); assert.doesNotMatch(body.messages[0].content, /RULE_short-drama-write/)
    return finalReply()
  })
  await call('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: m.id, mode: 'script', use_tools: false,
    question_response: { status: 'answered', question: '本次需要做什么？' }, messages: [{ role: 'user', text: '帮我弄清每个人为什么这样做。' }] })
  assert.equal(selections, 1); assert.equal(generations, 1)
  assert.equal(skillPolicy(project.id)[0].primary_id, write)
  assert.equal(all('SELECT * FROM script_artifacts WHERE project_id=?', project.id).length, 0)
})

test('durable director requests preserve a non-default model choice across interruption and resume', async t => {
  for (const native of [false, true]) await t.test(native ? 'native tools' : 'director fallback', async t => {
    const { project } = await fixture()
    const p = await call('POST', '/api/providers', { name: '恢复选技', base_url: 'https://resume-model-skills.invalid/v1' })
    const m = await call('POST', '/api/models', { provider_id: p.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
      settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
    if (native) await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'outline', title: '旧案', content: '林晚追查车站旧案。', status: 'ready' }] })
    let selections = 0, interrupted = false, recovering = false, generations = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content
      if (native && !recovering && !selections) {
        selections++
        return toolCall('load_creation_skills', { stage: 'script', skill_ids: [analyze], reason: '先核对原有故事中的动机与因果，再处理要求。' })
      }
      if (!native && body.tools?.some((tool: any) => tool.function.name === 'select_creation_skills')) {
        selections++
        assert.equal(recovering, false, 'a resumed task must reuse its frozen choice without asking the selector again')
        return toolCall('select_creation_skills', { skill_ids: [analyze], reason: '本次需要分析已有故事的因果。' })
      }
      generations++
      if (!native || recovering) assert.match(prompt, /RULE_source-structure/)
      if (!recovering) {
        interrupted = true
        return Response.json({ error: { message: 'fixture interrupted', type: 'invalid_request_error' } }, { status: 400 })
      }
      assert.doesNotMatch(prompt, /RULE_short-drama-write/)
      return finalReply()
    })
    const taskId = crypto.randomUUID(), taskUrl = `/api/projects/${project.id}/script/director/tasks/${taskId}`
    const payload = { model_id: m.id, mode: 'script', use_tools: native,
      ...(native ? { workflow: { stage: 'outline', scope: 'project', episode_number: 0, operation: 'revise' } }
        : { question_response: { status: 'answered', question: '本次需要做什么？' } }),
      messages: [{ role: 'user', text: '先核对原有材料中的人物动机和事件因果。' }],
      task: { id: taskId, conversation: { id: crypto.randomUUID(), messages: [{ id: 'question', role: 'user', text: '先核对原有材料。' }] },
        execution: { title: '选技恢复', request: '核对原有材料', started_at: Date.now(), mode: 'script' } } }
    const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload })
    assert.equal(first.statusCode, 200, first.body); assert.equal(interrupted, true, first.body)
    const failed = await call('GET', taskUrl)
    assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
    const stored = all<{ request_payload: string }>('SELECT request_payload FROM script_director_tasks WHERE id=?', taskId)[0]!
    assert.deepEqual(JSON.parse(stored.request_payload).skill_selections.script, [analyze])
    assert.equal(skillPolicy(project.id)[0].primary_id, write)
    recovering = true
    await call('POST', taskUrl + '/continue', {})
    const resumed = await app.inject({ method: 'GET', url: taskUrl + '/stream' })
    assert.equal(resumed.statusCode, 200, resumed.body)
    const finished = await call('GET', taskUrl)
    assert.equal(finished.status, 'succeeded')
    assert.equal(selections, 1); assert.equal(generations, 2)
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  })
})

test('typed stage recovery reuses its generated checkpoint and the non-default chosen rules', async t => {
  const { draftCompletenessFixtureResponse } = await import('./fixtures/script-draft-completeness.js')
  const { project } = await fixture()
  const alternate = install('alternate-writer', '用另一套专业方法创作完整大纲和短剧正文。', ['script'])
  t.after(() => configureSkill(alternate, false, ['script']))
  const p = await call('POST', '/api/providers', { name: '阶段恢复选技', base_url: 'https://stage-resume-skills.invalid/v1' })
  const m = await call('POST', '/api/models', { provider_id: p.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let selections = 0, drafts = 0, reviews = 0, failReview = true
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools?.some((tool: any) => tool.function.name === 'select_creation_skills')) {
      selections++
      return toolCall('select_creation_skills', { skill_ids: [alternate], reason: '本次大纲采用另一套完整创作方法。' })
    }
    const reviewed = draftCompletenessFixtureResponse(init)
    if (reviewed) {
      reviews++
      if (failReview) return Response.json({ error: { message: 'review interrupted', type: 'invalid_request_error' } }, { status: 400 })
      return reviewed
    }
    drafts++
    assert.match(body.messages[0].content, /RULE_alternate-writer/)
    assert.doesNotMatch(body.messages[0].content, /RULE_short-drama-write/)
    const typeSchema = body.response_format.json_schema.schema.properties.artifacts.items.properties.artifact_type
    const types = typeSchema.enum || [typeSchema.const]
    return Response.json({ choices: [{ message: { content: JSON.stringify({ artifacts: types.map((artifact_type: string) => ({ artifact_type, title: '城市旧案', content: '林晚收到一盘录音，查明车站旧案，揭穿伪证并将真相公之于众。' })), scenes: [] }) }, finish_reason: 'stop' }] })
  })
  const taskId = crypto.randomUUID(), taskUrl = `/api/projects/${project.id}/script/director/tasks/${taskId}`
  const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
    model_id: m.id, mode: 'script', use_tools: true, workflow: { stage: 'outline', scope: 'project', episode_number: 0 },
    messages: [{ role: 'user', text: '生成林晚调查车站旧案的全剧大纲。' }],
    task: { id: taskId, conversation: { id: crypto.randomUUID(), messages: [{ id: 'question', role: 'user', text: '生成全剧大纲。' }] },
      execution: { title: '大纲恢复选技', request: '生成全剧大纲', started_at: Date.now(), mode: 'script' } },
  } })
  assert.equal(first.statusCode, 200, first.body)
  const failed = await call('GET', taskUrl)
  assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
  assert.equal(selections, 1); assert.equal(drafts, 1)
  assert.deepEqual(JSON.parse(all<{ request_payload: string }>('SELECT request_payload FROM script_director_tasks WHERE id=?', taskId)[0]!.request_payload).skill_selections.script, [alternate])
  assert.equal(all('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id).length, 1)
  failReview = false
  await call('POST', taskUrl + '/continue', {})
  await app.inject({ method: 'GET', url: taskUrl + '/stream' })
  const completed = await call('GET', taskUrl)
  assert.equal(completed.status, 'succeeded')
  assert.equal(selections, 1, 'resume must not select skills again')
  assert.equal(drafts, 1, 'the generated stage checkpoint must retain its identity and be reused')
  assert.equal(reviews, 2)
  assert.equal(skillPolicy(project.id)[0].primary_id, write)
})

test('native resource skill revision drift invalidates a durable recovery key before any model request', async t => {
  const { installedSkillDetail } = await import('../src/modules/skills/skills.js')
  const original = installedSkillDetail(board)
  t.after(() => installSkillBundle(original, board))
  const { project } = await fixture()
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [{ artifact_type: 'outline', title: '旧案', content: '林晚追查车站旧案。', status: 'ready' }] })
  const p = await call('POST', '/api/providers', { name: '资源技能恢复', base_url: 'https://resource-resume-skills.invalid/v1' })
  const m = await call('POST', '/api/models', { provider_id: p.id, name: '模拟文本', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    if (requests === 1) return toolCall('load_creation_skills', { stage: 'storyboard', skill_ids: [board], reason: '核对故事与后续镜头连续性的关联。' })
    return Response.json({ error: { message: 'fixture interrupted', type: 'invalid_request_error' } }, { status: 400 })
  })
  const taskId = crypto.randomUUID(), taskUrl = `/api/projects/${project.id}/script/director/tasks/${taskId}`
  const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
    model_id: m.id, mode: 'script', use_tools: true, workflow: { stage: 'outline', scope: 'project', episode_number: 0, operation: 'revise' },
    messages: [{ role: 'user', text: '核对大纲行动与后续镜头的连续性，先讨论修改。' }],
    task: { id: taskId, conversation: { id: crypto.randomUUID(), messages: [{ id: 'question', role: 'user', text: '核对连续性。' }] },
      execution: { title: '资源技能恢复', request: '核对连续性', started_at: Date.now(), mode: 'script' } },
  } })
  assert.equal(first.statusCode, 200, first.body)
  const failed = await call('GET', taskUrl)
  assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
  assert.deepEqual(JSON.parse(all<{ request_payload: string }>('SELECT request_payload FROM script_director_tasks WHERE id=?', taskId)[0]!.request_payload).skill_selections.storyboard, [board])
  installSkillBundle({ ...original, revision: 'a'.repeat(39) + 'b' }, board)
  const resumed = await app.inject({ method: 'POST', url: taskUrl + '/continue', payload: {} })
  assert.equal(resumed.statusCode, 409, resumed.body)
  assert.match(resumed.json().detail, /模型配置已变化|不能续用旧任务/)
  assert.equal(requests, 2, 'a changed resource skill must reject resume before selecting or invoking the model')
})
