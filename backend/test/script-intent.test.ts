import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'studio-intent-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db } = await import('../src/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '意图测试', base_url: 'https://intent.example/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '测试文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '分集意图测试' })
  return { project, model }
}
const episode = { artifacts: [{ artifact_type: 'episode_script', title: '第1集', content: '完整剧本文字' }], scenes: [
  { heading: '雨夜门厅', location: '旅馆', characters: '林', action: '林接起电话', dialogue: '别让他们走', duration: 10 },
] }

test('project generation after episode one ignores stale episode state, reads all episodes and only commits project documents', async t => {
  const { model, project } = await fixture()
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', scenes: [
    { ...episode.scenes[0], episode_number: 1 }, { ...episode.scenes[0], heading: '第五集结尾', episode_number: 5 },
  ] })
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'episode_script', episode_number: 1, title: '已保存第一集', content: '第一集确认事实', status: 'ready' },
    { artifact_type: 'episode_script', episode_number: 5, title: '已保存第五集', content: '远集标记：第五集已确认事实', status: 'ready' },
  ] })
  const before = (await call<{ script: { scenes: unknown[]; artifacts: Array<{ artifact_type: string; episode_number: number }> } }>('GET', `/api/projects/${project.id}`)).script
  const originalFetch = globalThis.fetch
  let selectedStage = 'outline'
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    let content: unknown
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      assert.ok(prompt.includes(`"explicit_workflow":{"stage":"${selectedStage}","scope":"project","episode_number":0}`))
      assert.doesNotMatch(prompt, /"selected_episode":2/)
      // The coordinator's target must not override a typed project button.
      content = { action: 'draft', operation: 'create', workflow: { stage: 'episode', episode_number: 9 }, creative_brief: '继续第二集，按已确认事实补全资料。' }
    } else {
      assert.match(prompt, /任务范围：整个项目的全剧资料，不属于任何单集/)
      assert.ok(prompt.includes('远集标记：第五集已确认事实'), 'project tasks see saved episodes beyond the selected and previous episode')
      assert.ok(prompt.includes(`"task_scope":{"stage":"${selectedStage}","scope":"project","episode_number":0}`))
      assert.doesNotMatch(prompt, /只写第 2 集|本集总时长目标/)
      content = { artifacts: [{ artifact_type: selectedStage, title: `全剧${selectedStage}`, content: '全剧确认资料' }], scenes: [] }
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const stage of ['outline', 'characters', 'locations', 'props']) {
    selectedStage = stage
    for (const suffix of ['', '/stream']) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: {
        model_id: model.id, mode: 'script', workflow: { stage, episode_number: 2, target_duration: 300 },
        intent_context: { selected_episode: 2 }, messages: [{ role: 'assistant', text: '第1集已保存，下次可以开始第2集。' }, { role: 'user', text: '生成全剧资料。' }],
      } })
      assert.equal(response.statusCode, 200, response.body)
      const result = suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
      assert.equal(result.draft.stage, stage)
      assert.equal(result.draft.scope, 'project')
      assert.equal(result.draft.episode_number, 0)
      assert.equal(result.draft.target_duration, undefined)
      assert.deepEqual((await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)).script, before, 'draft generation never saves implicitly')
      if (stage === 'props' && suffix === '/stream') {
        const saved = await call<typeof before>('PUT', `/api/projects/${project.id}/script/director/draft`, result.draft)
        assert.deepEqual(saved.scenes, before.scenes)
        assert.deepEqual(saved.artifacts.filter(item => item.episode_number > 0), before.artifacts)
        assert.equal(saved.artifacts.find(item => item.artifact_type === 'props')?.episode_number, 0)
      }
    }
  }
})

test('incompatible workflow scope and a zero target episode are rejected before any model request', async () => {
  const { model, project } = await fixture()
  for (const workflow of [{ stage: 'outline', scope: 'episode', episode_number: 2 }, { stage: 'episode', scope: 'project', episode_number: 2 }, { stage: 'episode', scope: 'episode', episode_number: 0 }]) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
      model_id: model.id, mode: 'script', workflow, messages: [{ role: 'user', text: '生成文档' }],
    } })
    assert.equal(response.statusCode, 422, response.body)
  }
})

test('skip delegates a concrete decision in both chat transports without drafting or saving', async t => {
  const { model, project } = await fixture()
  const question = '主人公与搭档的关系是什么？'
  const prompts: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).messages[0].content)
    return new Response(JSON.stringify({ choices: [{ message: { content: '我决定让他们成为曾经决裂的师兄弟，这能让合作与旧怨形成冲突。接下来确定开场地点。' } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const before = (await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)).script
  const payload = { model_id: model.id, mode: 'script', question_response: { status: 'skipped', question },
    intent_context: { pending_draft: { stage: 'episode', episode_number: 1 } },
    messages: [{ role: 'assistant', text: question }, { role: 'user', text: `关于“${question}”，我交给你决定，选定具体方案并继续推进。` }] }
  for (const suffix of ['', '/stream']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload })
    assert.equal(response.statusCode, 200, response.body)
    const result = suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    assert.match(result.reply, /我决定让他们成为曾经决裂的师兄弟/)
    assert.equal(result.draft, undefined)
  }
  assert.equal(prompts.length, 2, 'one discussion call per skip, no intent classifier or drafting call')
  for (const prompt of prompts) {
    assert.match(prompt, /本轮创作者点击了“跳过”/)
    assert.ok(prompt.includes(question))
    assert.match(prompt, /有备选方案时选定最合适的一项，需要具体信息时自行补齐完整设定/)
    assert.match(prompt, /不要把这项保留待定/)
    assert.match(prompt, /不要重复询问这个问题或要求创作者再次确认/)
    assert.match(prompt, /不要把未提交的选择或填写内容当成创作者的确认/)
    assert.match(prompt, /这次操作只继续讨论，不自动生成或保存文档/)
    assert.doesNotMatch(prompt, /这项保留待定，跳过不等于/)
  }
  assert.deepEqual((await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)).script, before)
})

test('delegated decisions reach later outline and episode drafts through the intent brief over both transports', async t => {
  const { model, project } = await fixture()
  const question = '故事开场发生在哪里？'
  const decision = '我决定开场设在雨夜车站，因为封闭空间适合悬疑。'
  const before = (await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)).script
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let stage = 'outline'
  let intentCalls = 0
  let draftCalls = 0
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    let content: unknown
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      intentCalls++
      assert.match(prompt, /模型在创作者明确授权下已经作出的具体决定/)
      assert.match(prompt, /沿用这些决定，不重新追问、不标为待定/)
      assert.ok(prompt.includes(decision))
      content = { action: 'draft', operation: 'create', workflow: { stage, episode_number: stage === 'episode' ? 1 : 0 },
        creative_brief: '沿用授权模型决定的雨夜车站开场。' }
    } else if (prompt.includes('本轮为“')) {
      draftCalls++
      assert.match(prompt, /沿用授权模型决定的雨夜车站开场/)
      assert.match(prompt, /创作者明确授权模型决定后已经作出的具体设定应沿用，不标为待定/)
      assert.match(prompt, /其他未知且未授权模型决定的设定标为待定/)
      assert.doesNotMatch(prompt, /未选方案：古代山寨/)
      content = stage === 'episode' ? episode : { artifacts: [{ artifact_type: 'outline', title: '故事大纲', content: '雨夜车站开场。' }], scenes: [] }
    } else {
      assert.match(prompt, /明确授权你决定该项/)
      content = decision
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  for (const suffix of ['', '/stream']) {
    const request = async (payload: unknown) => {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload })
      assert.equal(response.statusCode, 200, response.body)
      return suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    }
    const messages = [{ role: 'assistant', text: `未选方案：古代山寨。${question}` },
      { role: 'user', text: `关于“${question}”，我交给你决定。后续沿用你的具体决定。` }]
    const delegated = await request({ model_id: model.id, mode: 'script', question_response: { status: 'skipped', question }, messages })
    assert.equal(delegated.reply, decision)
    assert.equal(delegated.draft, undefined)
    for (stage of ['outline', 'episode']) {
      const generated = await request({ model_id: model.id, mode: 'script', workflow: { stage, episode_number: stage === 'episode' ? 1 : 0 },
        messages: [...messages, { role: 'assistant', text: delegated.reply }, { role: 'user', text: stage === 'episode' ? '开始写第一集' : '生成全剧大纲' }] })
      assert.equal(generated.draft.stage, stage)
      assert.deepEqual((await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)).script, before)
    }
  }
  assert.equal(intentCalls, 4)
  assert.equal(draftCalls, 4)
})

test('skip cannot be combined with document operations or visual-asset routing', async () => {
  const { model, project } = await fixture()
  const payload = { model_id: model.id, mode: 'script', question_response: { status: 'skipped', question: '选哪个方向？' }, messages: [{ role: 'user', text: '跳过' }] }
  for (const extra of [{ workflow: { stage: 'episode', episode_number: 1 } }, { adopt_source: { text: '正文', episode_number: 1 } }, { focus_artifact: 'character' }, { question_response: { status: 'answered', question: '选哪个方向？' } }]) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { ...payload, ...extra } })
    assert.equal(response.statusCode, 422, response.body)
  }
})

test('long Chinese conversations above 40 KB can continue or skip over either transport with full selected messages', async t => {
  const { model, project } = await fixture()
  const question = '主角的姓名和性别如何确定？'
  const history = Array.from({ length: 20 }, (_, index) => ({ id: `long-history-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
    text: `完整历史${index}：${'项目背景'.repeat(400)}` }))
  assert.ok(history.reduce((total, message) => total + Buffer.byteLength(message.text), 0) > 40_000)
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: `long-${project.id}`, messages: history })
  const before = await call<unknown>('GET', `/api/projects/${project.id}/script/conversations`)
  const prompts: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    prompts.push(prompt)
    const content = prompt.includes('本次独立调用只理解创作者意图') ? JSON.stringify({ action: 'discuss' }) : '已接续讨论。'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const skip of [false, true]) for (const suffix of ['', '/stream']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: {
      model_id: model.id, mode: 'script',
      ...(skip ? { question_response: { status: 'skipped', question } } : {}),
      messages: [...history.map(({ role, text }) => ({ role, text })), { role: 'assistant', text: question }, { role: 'user', text: skip ? '这项跳过，请继续。' : '主角为男性，先暂用林远。' }],
    } })
    assert.equal(response.statusCode, 200, response.body)
    const result = suffix ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    assert.equal(result.reply, '已接续讨论。')
    assert.equal(result.draft, undefined)
  }
  assert.equal(prompts.length, 6)
  for (const prompt of prompts) {
    assert.ok(prompt.includes(history[0]!.text), 'the first selected message reaches the model intact')
    assert.ok(prompt.includes(history.at(-1)!.text), 'the last selected message reaches the model intact')
    assert.ok(prompt.includes(question))
  }
  assert.deepEqual(await call<unknown>('GET', `/api/projects/${project.id}/script/conversations`), before, 'request windowing must not alter saved history')
})

test('oversized caller-supplied context is still rejected before any provider call', async () => {
  const { model, project } = await fixture()
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', messages: Array.from({ length: 32 }, () => ({ role: 'user', text: '中'.repeat(8000) })),
  } })
  assert.equal(response.statusCode, 422)
  assert.match(response.body, /256 KB/)
})

test('valid long text with full references is not rejected by the default transport body limit after JSON escaping', async t => {
  const { model, project } = await fixture()
  const messages = Array.from({ length: 31 }, (_, index) => ({ role: 'user', text: '\\'.repeat(8000),
    ...(index < 2 ? { reference_documents: Array.from({ length: 3 }, (_, reference) => ({ key: `doc-${index}-${reference}`, title: '参考资料', artifact_type: 'outline', episode_number: 0, content: 'x'.repeat(99700) })) } : {}),
  }))
  const payload = { model_id: model.id, mode: 'script', question_response: { status: 'skipped', question: '选择方向？' }, messages }
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '继续讨论。' } }] }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = originalFetch })
  for (const suffix of ['', '/stream']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload })
    assert.equal(response.statusCode, 200, response.body)
    assert.ok(response.body.includes('继续讨论。'))
  }
})

// These tests check that model decisions, rather than matching request wording,
// control execution, and that the resulting drafts remain reviewable and scoped.
test('model intent routes colloquial requests, confirmed settings and selected episode into isolated drafting', async t => {
  const { model, project } = await fixture()
  const prompts: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    prompts.push(prompt)
    const content = prompt.includes('本次独立调用只理解创作者意图') ? {
      action: 'draft', operation: 'create', workflow: { stage: 'episode', episode_number: 1 },
      creative_brief: '按已选封闭旅馆悬疑写第一集；保留完整故事。', settings_patch: { episode_count: 20, episode_duration: 300 },
    } : episode
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const result = await call<{ draft: { stage: string; episode_number: number; target_duration: number }; generation_options: { episode_count: number; episode_duration: number } }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', messages: [
      { role: 'assistant', text: '未选的另一个方向：喜剧。请问从哪集开始？' },
      { role: 'user', text: '第一集开始，整剧二十集，每集五分钟，先做三十秒片段' },
    ], intent_context: { selected_episode: 1 },
  })
  assert.equal(result.draft.stage, 'episode')
  assert.equal(result.draft.episode_number, 1)
  assert.equal(result.draft.target_duration, 300)
  assert.deepEqual(result.generation_options, { episode_count: 20, episode_duration: 300 })
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!, /第一集开始/)
  assert.doesNotMatch(prompts[1]!, /未选的另一个方向/)
  assert.match(prompts[1]!, /本次创作要求/)
  const unchanged = await call<{ script: { scenes: unknown[]; artifacts?: unknown[] } }>('GET', `/api/projects/${project.id}`)
  assert.equal(unchanged.script.scenes.length, 0)
  assert.equal(unchanged.script.artifacts?.length || 0, 0)
})

test('negation, discussion and ambiguous continuation respect model decisions without document generation', async t => {
  const { model, project } = await fixture()
  let decision: unknown = { action: 'discuss' }
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    return new Response(JSON.stringify({ choices: [{ message: { content: prompt.includes('本次独立调用只理解创作者意图') ? JSON.stringify(decision) : '先讨论开场，尚未生成正文。' } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const text of ['第一集先别写', '第一集怎么写更好']) {
    const result = await call<{ reply: string; draft?: unknown }>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', messages: [{ role: 'user', text }] })
    assert.equal(result.draft, undefined)
    assert.equal(result.reply, '先讨论开场，尚未生成正文。')
  }
  decision = { action: 'clarify', reply: '继续修改第1集，还是开始写第2集？' }
  const before = calls
  const clarify = await call<{ reply: string; draft?: unknown }>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '继续' }] })
  assert.match(clarify.reply, /第2集/)
  assert.equal(clarify.draft, undefined)
  assert.equal(calls - before, 1)
})

test('pending drafts block new writing before the writing call and malformed routing fails closed', async t => {
  const { model, project } = await fixture()
  let raw = JSON.stringify({ action: 'draft', operation: 'create', workflow: { stage: 'episode', episode_number: 2 }, creative_brief: '写第二集' })
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }), { headers: { 'Content-Type': 'application/json' } }) }
  t.after(() => { globalThis.fetch = originalFetch })
  const body = { model_id: model.id, mode: 'all', messages: [{ role: 'user', text: '往下写' }] }
  const blocked = await call<{ reply: string; draft?: unknown }>('POST', `/api/projects/${project.id}/script/director/chat`, { ...body, intent_context: { pending_draft: { stage: 'episode', episode_number: 1 } } })
  assert.match(blocked.reply, /先保存或放弃/)
  assert.equal(blocked.draft, undefined)
  assert.equal(calls, 1)
  raw = '随便生成第一集吧'
  const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: body })
  assert.equal(invalid.statusCode, 502)
  assert.equal(calls, 2)
})

test('adopting existing text preserves it verbatim and saves an editable episode with scenes only on confirmation', async t => {
  const { model, project } = await fixture()
  const source = '## 第一集《旧录音》\n\n林接起电话。\n\n电话：别让他们走。\n\n第1集完'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(episode) } }] }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = originalFetch })
  const result = await call<{ draft: { artifacts: Array<{ content: string }>; scenes: Array<{ heading: string }>; episode_number: number } }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '采用正文' }], adopt_source: { text: source, episode_number: 1 },
  })
  assert.equal(result.draft.artifacts[0]!.content, source)
  assert.equal(result.draft.scenes.length, 1)
  assert.equal(result.draft.episode_number, 1)
  const before = await call<{ script: { scenes: unknown[] } }>('GET', `/api/projects/${project.id}`)
  assert.equal(before.script.scenes.length, 0)
  const saved = await call<{ artifacts: Array<{ content: string; episode_number: number }>; scenes: Array<{ episode_number: number; id: string }> }>('PUT', `/api/projects/${project.id}/script/director/draft`, result.draft)
  assert.equal(saved.artifacts[0]!.content, source)
  assert.equal(saved.scenes[0]!.episode_number, 1)
  const handoff = await call<{ shots: unknown[] }>('POST', `/api/projects/${project.id}/script/convert-to-shots`, { scene_ids: saved.scenes.map(scene => scene.id) })
  assert.equal(handoff.shots.length, 1)
})

test('stream routing announces document mode before chunks and returns a structured draft', async t => {
  const { model, project } = await fixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const content = prompt.includes('本次独立调用只理解创作者意图') ? { action: 'draft', operation: 'create', workflow: { stage: 'episode', episode_number: 2 }, creative_brief: '继续写第二集' } : episode
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { model_id: model.id, mode: 'script', messages: [{ role: 'assistant', text: '第1集已保存，下一集待写。' }, { role: 'user', text: '接着来' }] } })
  assert.equal(result.statusCode, 200)
  const events = result.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  const intentIndex = events.findIndex(event => event.type === 'intent')
  const deltaIndex = events.findIndex(event => event.type === 'delta')
  assert.ok(intentIndex < deltaIndex)
  assert.equal(events[intentIndex].workflow.episode_number, 2)
  assert.equal(events.find(event => event.type === 'done').draft.episode_number, 2)
})

test('natural-language adoption uses the model-selected assistant message and rejects a user message reference', async t => {
  const { model, project } = await fixture()
  const source = '第一集正文：林推开车站门，旧电话响起。'
  let sourceIndex = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const content = prompt.includes('本次独立调用只理解创作者意图') ? {
      action: 'draft', operation: 'adopt', workflow: { stage: 'episode', episode_number: 1 },
      source_message_index: sourceIndex, creative_brief: '采用已写正文，保留原文。',
    } : episode
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const body = { model_id: model.id, mode: 'script', messages: [{ role: 'assistant', text: source }, { role: 'user', text: '就用这版，整理到第一集里' }] }
  const adopted = await call<{ draft: { artifacts: Array<{ content: string }> } }>('POST', `/api/projects/${project.id}/script/director/chat`, body)
  assert.equal(adopted.draft.artifacts[0]!.content, source)
  sourceIndex = 1
  const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: body })
  assert.equal(invalid.statusCode, 422)
  assert.match(invalid.body, /已有助手消息/)
})

test('explicit workflow selections retain confirmed conversational context without trusting model target changes', async t => {
  const { model, project } = await fixture()
  let draftingPrompt = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    let content: unknown
    if (prompt.includes('本次独立调用只理解创作者意图')) {
      assert.match(prompt, /"explicit_workflow"/)
      assert.match(prompt, /只选择雨夜车站/)
      content = { action: 'draft', operation: 'create', workflow: { stage: 'episode', episode_number: 9 }, creative_brief: '只写雨夜车站，主人公林，第一集电话线索。' }
    } else { draftingPrompt = prompt; content = episode }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const result = await call<{ draft: { episode_number: number } }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', workflow: { stage: 'episode', episode_number: 1 }, messages: [
      { role: 'assistant', text: '未选方案是古代山寨，另一方案是雨夜车站。' },
      { role: 'user', text: '只选择雨夜车站，主人公林' }, { role: 'user', text: '开始写第1集' },
    ],
  })
  assert.equal(result.draft.episode_number, 1)
  assert.match(draftingPrompt, /只写雨夜车站/)
  assert.doesNotMatch(draftingPrompt, /未选方案是古代山寨/)
})
