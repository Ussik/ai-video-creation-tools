import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'studio-reply-classification-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db } = await import('../src/db.js')
const { replyClassificationVersion, parseReplyClassifications, replyClassificationPrompt } = await import('../src/script-reply-classification.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '回复识别', base_url: 'https://classification.example/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '文本识别', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '识别测试' })
  return { project, model }
}
type Result = { messages: Array<{ id: string; classification: { type: string; episode_number?: number } }> }

test('model classifies replies independently; results survive conversation reload and are cached by exact content', async t => {
  const { model, project } = await fixture()
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.match(prompt, /本次独立任务只识别/)
    assert.doesNotMatch(prompt, /影视编剧。/)
    const sources = JSON.parse(prompt.split('待识别消息：\n')[1]!) as Array<{ id: string; text: string }>
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: sources.map(source => ({
      id: source.id, classification: source.id === 'body' ? { type: 'episode_script', episode_number: 2 }
        : source.id === 'setup' ? { type: 'episode_preparation', episode_number: 3 } : { type: 'other' },
    })) }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const messages = [
    { id: 'discussion', text: '第一集可以切黑收尾，但先讨论主角，不要写正文。第1集完只是格式示例。' },
    { id: 'notice', text: '第2集剧本已保存。' },
    { id: 'summary', text: '第二集大纲：发现车票，然后前往站台。' },
    { id: 'body', text: '雨夜候车室。林拿起听筒。\n朋友：去第三站台。\n林攥紧旧车票，转身奔向站台。' },
    { id: 'setup', text: '第三集设定和试写已整理，可展开完整正文。' },
  ]
  const url = `/api/projects/${project.id}/script/replies/classify`
  const first = await call<Result>('POST', url, { model_id: model.id, messages })
  assert.equal(first.messages.filter(item => item.classification.type === 'episode_script').length, 1)
  assert.equal(first.messages.find(item => item.id === 'body')!.classification.episode_number, 2)
  assert.equal(calls, 1)
  await call('POST', url, { model_id: model.id, messages })
  assert.equal(calls, 1, 'same message text must reuse cache')
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'conversation', messages: messages.map(message => ({ ...message, role: 'assistant' })) })
  const reload = await call<{ conversations: Array<{ messages: Result['messages'] }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal(reload.conversations[0]!.messages.find(item => item.id === 'body')!.classification.type, 'episode_script')
  assert.equal(reload.conversations[0]!.messages.find(item => item.id === 'setup')!.classification.type, 'episode_preparation')
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'conversation', messages: [{ id: 'body', role: 'assistant', text: '改为讨论这张车票的用途。' }] })
  const changed = await call<{ conversations: Array<{ messages: Array<{ classification?: unknown }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal(changed.conversations[0]!.messages[0]!.classification, undefined)
  await call('POST', url, { model_id: model.id, messages: [{ id: 'body', text: '改为讨论这张车票的用途。' }] })
  assert.equal(calls, 2, 'changed content must be analyzed again')
})

test('invalid, missing or invented classification IDs fail closed without caching a positive flag', async t => {
  const { model, project } = await fixture()
  const originalFetch = globalThis.fetch
  let output: unknown = { messages: [{ id: 'invented', classification: { type: 'episode_script', episode_number: 1 } }] }
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = originalFetch })
  const url = `/api/projects/${project.id}/script/replies/classify`
  const payload = { model_id: model.id, messages: [{ id: 'actual', text: '这是普通讨论。' }] }
  for (const invalid of [output, { messages: [] }, { messages: [{ id: 'actual', classification: { type: 'episode_script', episode_number: 0 } }] },
    { messages: [{ id: 'actual', classification: { type: 'choice_request', status: 'pending', question: '选哪个？', options: [
      { id: 'a', title: '祖母', text: '亲缘' }, { id: 'a', title: '养母', text: '孤立' },
    ] } }] }]) {
    output = invalid
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 502)
  }
  output = { messages: [{ id: 'actual', classification: { type: 'other' } }] }
  assert.equal((await call<Result>('POST', url, payload)).messages[0]!.classification.type, 'other')
  const duplicate = await app.inject({ method: 'POST', url, payload: { ...payload, messages: [payload.messages[0], payload.messages[0]] } })
  assert.equal(duplicate.statusCode, 422)
})

test('choice status is model judged, cached with follow-up context, and restored only for matching conversation', async t => {
  const { model, project } = await fixture()
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.match(prompt, /不能靠问号、列表符号/)
    assert.match(prompt, /不新增、拆分、合并/)
    const sources = JSON.parse(prompt.split('待识别消息：\n')[1]!) as Array<{ id: string; following_messages?: unknown[] }>
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: sources.map(source => ({
      id: source.id, classification: { type: 'choice_request', status: source.following_messages?.length ? 'answered' : 'pending',
        question: '你倾向哪条？', options: [{ id: 'a', title: '祖母', text: '亲缘温暖' }, { id: 'b', title: '养母', text: '孤立感' }] },
    })) }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const source = { id: 'choice', text: '祖母强调亲缘，养母强调孤立感。你倾向哪条？' }
  const url = `/api/projects/${project.id}/script/replies/classify`
  const classify = (following_messages: Array<{ role: 'user'; text: string }>) => call<{ classification_version: number; messages: Array<{ classification: { status: string } }> }>('POST', url, { model_id: model.id, messages: [{ ...source, following_messages }] })
  assert.equal((await classify([])).messages[0]!.classification.status, 'pending')
  await classify([])
  assert.equal(calls, 1)
  const followup = [{ role: 'user' as const, text: '我决定选养母。' }]
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'choice-chat', messages: [{ ...source, role: 'assistant' }, { id: 'answer', ...followup[0] }] })
  const reload = () => call<{ conversations: Array<{ messages: Array<{ text: string; classification?: { status: string }; classification_context?: string }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal((await reload()).conversations[0]!.messages[0]!.classification, undefined, 'stale pending cache must not reopen an answered question')
  const result = await classify(followup)
  assert.equal(result.classification_version, replyClassificationVersion)
  assert.equal(result.messages[0]!.classification.status, 'answered')
  await classify(followup)
  assert.equal(calls, 2)
  const restored = (await reload()).conversations[0]!.messages[0]!
  assert.equal(restored.classification!.status, 'answered')
  assert.equal(restored.classification_context, JSON.stringify(followup))
  assert.equal(restored.text, source.text)
})

test('preparation metadata identifies an episode operation separately from adoptable prose', () => {
  const sources = [{ id: 'setup', text: '第一集设定及重场戏试写，下一步可以展开全文。' }]
  const prompt = replyClassificationPrompt(sources)
  assert.match(prompt, /episode_preparation/)
  assert.match(prompt, /必须由创作者点击才执行/)
  assert.match(prompt, /不能仅凭提到集数/)
  assert.deepEqual(parseReplyClassifications(JSON.stringify({ messages: [{ id: 'setup', classification: { type: 'episode_preparation', episode_number: 1 } }] }), ['setup']),
    [{ id: 'setup', classification: { type: 'episode_preparation', episode_number: 1 } }])
  for (const episode_number of [0, 201, 1.5, undefined]) {
    assert.throws(() => parseReplyClassifications(JSON.stringify({ messages: [{ id: 'setup', classification: { type: 'episode_preparation', episode_number } }] }), ['setup']))
  }
})

test('mixed open and bounded questions are sent to the model again after an old other cache, with detail controls restored on reload', async t => {
  const { model, project } = await fixture()
  const source = { id: 'mixed', text: '关系结构已确认。亲属写哪几位？外人是律师、管家、医生都保留还是只选其中一两个？', following_messages: [] }
  const oldHash = createHash('sha256').update(JSON.stringify([3, source.text, null])).digest('hex')
  db.prepare('INSERT INTO script_reply_classifications (project_id,message_id,text_hash,classification,model_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(project.id, source.id, oldHash, JSON.stringify({ type: 'other' }), model.id, new Date().toISOString())
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'mixed-chat', messages: [{ id: source.id, role: 'assistant', text: source.text }] })
  const reload = () => call<{ conversations: Array<{ messages: Array<{ classification?: unknown }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal((await reload()).conversations[0]!.messages[0]!.classification, undefined, 'old negative judgments must not suppress the new interaction')
  let calls = 0
  const classification = { type: 'choice_request', status: 'pending', question: '外人如何保留？', options: [
    { id: 'all', title: '全部保留', text: '律师、管家、医生全部保留' },
    { id: 'subset', title: '只保留一到两人', text: '只选其中一两个', requires_details: true },
  ] }
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.match(prompt, /混合追问不能整体归为 other/)
    assert.match(prompt, /不能继承上轮问题的 answered/)
    assert.match(prompt, /不排列原文没有给出的组合/)
    const sources = JSON.parse(prompt.split('待识别消息：\n')[1]!)
    assert.deepEqual(sources, [source])
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: [{ id: source.id, classification }] }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const url = `/api/projects/${project.id}/script/replies/classify`
  assert.deepEqual((await call<Result>('POST', url, { model_id: model.id, messages: [source] })).messages[0]!.classification, classification)
  await call('POST', url, { model_id: model.id, messages: [source] })
  assert.equal(calls, 1)
  assert.deepEqual((await reload()).conversations[0]!.messages[0]!.classification, classification)
})

test('writer structured choices preserve required detail controls through reply normalization', async t => {
  const { model, project } = await fixture()
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const choices = { kind: 'choices', question: '随队顾问如何保留？', options: [
    { id: 'all', title: '全部保留', text: '全部顾问保留' },
    { id: 'subset', title: '只保留部分', text: '只保留部分顾问', requires_details: true },
  ] }
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const intent = prompt.includes('本次独立调用只理解创作者意图')
    if (!intent) assert.match(prompt, /不要将数个开放追问和选择题塞进同一段/)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent ? { action: 'discuss', settings_patch: {} } : choices) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const result = await call<{ reply: string }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '先讨论保留哪些顾问' }],
  })
  assert.deepEqual(JSON.parse(result.reply), choices)
})

test('explicit reclassification bypasses and replaces both negative and positive cache entries without modifying text', async t => {
  const { project, model } = await fixture()
  const source = { id: 'retry', text: '保留全部顾问还是只保留医生？', following_messages: [] }
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'retry-conversation', messages: [{ id: source.id, role: 'assistant', text: source.text }] })
  let output: unknown = { type: 'other' }
  let calls = 0
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: [{ id: source.id, classification: output }] }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const url = `/api/projects/${project.id}/script/replies/classify`
  const payload = { model_id: model.id, messages: [source] }
  await call('POST', url, payload)
  await call('POST', url, payload)
  assert.equal(calls, 1)
  output = { type: 'choice_request', status: 'pending', question: '保留哪些顾问？', options: [{ id: 'all', title: '全部', text: '保留全部顾问' }, { id: 'doctor', title: '医生', text: '只保留医生' }] }
  await call('POST', url, { ...payload, force: true })
  const loaded = () => call<{ conversations: Array<{ messages: Array<{ text: string; classification: unknown }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.deepEqual((await loaded()).conversations[0].messages[0].classification, output)
  output = { type: 'other' }
  await call('POST', url, { ...payload, force: true })
  const message = (await loaded()).conversations[0].messages[0]
  assert.deepEqual(message.classification, output, 'an old positive cache must not override an explicit negative correction')
  assert.equal(message.text, source.text)
  assert.equal(calls, 3)
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, force: true, messages: [source, { ...source, id: 'another' }] } })).statusCode, 422)
})

test('open creator questions migrate old negative cache to input fields and status follows actual later conversation', async t => {
  const { model, project } = await fixture()
  const source = { id: 'open', text: '直系亲属具体写哪几位？姻亲是谁（比如儿媳/女婿、嫂子/妹夫等）？' }
  const fields = [{ id: 'family', label: '直系亲属' }, { id: 'inlaw', label: '姻亲身份', suggestions: ['儿媳', '女婿', '嫂子', '妹夫'] }]
  const oldHash = createHash('sha256').update(JSON.stringify([4, source.text, null])).digest('hex')
  db.prepare('INSERT INTO script_reply_classifications (project_id,message_id,text_hash,classification,model_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(project.id, source.id, oldHash, JSON.stringify({ type: 'other' }), model.id, new Date().toISOString())
  let calls = 0
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const sources = JSON.parse(prompt.split('待识别消息：\n')[1]!)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: sources.map((s: { id: string; following_messages?: unknown[] }) => ({ id: s.id,
      classification: { type: 'input_request', status: s.following_messages?.length ? 'answered' : 'pending', question: '确定亲属身份', fields },
    })) }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const url = `/api/projects/${project.id}/script/replies/classify`
  const classify = (following_messages: unknown[]) => call<Result>('POST', url, { model_id: model.id, messages: [{ ...source, following_messages }] })
  assert.deepEqual((await classify([])).messages[0].classification, { type: 'input_request', status: 'pending', question: '确定亲属身份', fields })
  await classify([])
  assert.equal(calls, 1)
  const followup = [{ role: 'user', text: '直系亲属：父亲、女儿。姻亲：女婿。' }]
  await call('PUT', `/api/projects/${project.id}/script/conversations`, { id: 'open-chat', messages: [{ ...source, role: 'assistant' }, { id: 'open-answer', ...followup[0] }] })
  const load = () => call<{ conversations: Array<{ messages: Array<{ classification?: unknown; classification_context?: string }> }> }>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal((await load()).conversations[0].messages[0].classification, undefined, 'old pending form cannot survive a new answer')
  await classify(followup)
  const reloaded = (await load()).conversations[0].messages[0]
  assert.deepEqual(reloaded.classification, { type: 'input_request', status: 'answered', question: '确定亲属身份', fields })
  assert.equal(reloaded.classification_context, JSON.stringify(followup))
  assert.equal(calls, 2)
  for (const invalid of [[], [fields[0], fields[0]], [{ id: 'a', label: '身份', suggestions: [4] }]]) {
    assert.throws(() => parseReplyClassifications(JSON.stringify({ messages: [{ id: source.id, classification: { type: 'input_request', status: 'pending', question: '确定身份', fields: invalid } }] }), [source.id]))
  }
})

test('writer structured input requests preserve fields and surrounding prose through normalization', async t => {
  const { model, project } = await fixture()
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const form = { kind: 'input_request', question: '确定人物身份', intro: '请确定家族关系。', fields: [{ id: 'family', label: '直系亲属' }, { id: 'inlaw', label: '姻亲', suggestions: ['儿媳', '女婿'] }], trailing: '确定后推进大纲。' }
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const intent = prompt.includes('本次独立调用只理解创作者意图')
    if (!intent) assert.match(prompt, /开放追问用 input_request/)
    return new Response(JSON.stringify({ choices: [{ message: { content: intent ? JSON.stringify({ action: 'discuss', settings_patch: {} }) : '说明\n' + JSON.stringify(form) + '\n补充' } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const result = await call<{ reply: string }>('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '先讨论具体亲属身份' }] })
  assert.deepEqual(JSON.parse(result.reply), { ...form, intro: '说明\n\n请确定家族关系。', trailing: '确定后推进大纲。\n\n补充' })
})
