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
