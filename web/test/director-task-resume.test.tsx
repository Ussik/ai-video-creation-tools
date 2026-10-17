import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import { skillStageOptions } from '../src/shared/api/skills-api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const detail = { id: 'director-resume', name: '恢复测试', brief: '', ratio: '9:16', script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'model', provider_id: 'provider', name: '测试模型', modality: 'text', enabled: true, settings: {} } as Model
const provider = { id: 'provider', enabled: true, adapter: 'http' } as Provider
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const policies = { policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) }
async function mount(focusArtifact: 'all' | 'character' = 'all') {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={[model]} providers={[provider]} focusArtifact={focusArtifact} onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function typeMessage(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 20)) }) }

test('a remounted conversation reattaches to its running task and shows the final reply without resubmitting it', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  let task: any = null, submitted = 0, cancelled = 0, stream: ReadableStreamDefaultController<Uint8Array> | null = null
  const encode = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ task_persistence: true, tasks: task ? [{ id: task.id, conversation_id: task.conversation.id,
      message_id: task.id, started_at: task.execution.started_at, execution: task.execution }] : [],
      conversations: task ? [{ id: task.conversation.id, label: '讨论人物', messages: [...task.conversation.messages, {
        id: task.id, role: 'assistant', text: '正在处理创作任务…', pending: true, execution: task.execution, task_id: task.id,
      }] }] : [] })
    if (path.endsWith('/chat/stream')) {
      submitted++
      task = JSON.parse(String(init?.body)).task
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; controller.enqueue(encode.encode(event({ type: 'task', task_id: task.id }))) },
        cancel() { cancelled++ },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path.endsWith(`/tasks/${task?.id}/stream`)) return new Response(event({ type: 'task', task_id: task.id }) + event({ type: 'done', reply: '主角二十六岁，职业是调查记者。' }), { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected ${path}`)
  })
  const first = await mount()
  await act(() => typeMessage('讨论人物年龄'))
  await act(() => { const button = first.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!; button.click() })
  await settle()
  assert.equal(submitted, 1); assert.ok(stream); assert.match(first.container.textContent!, /处理中/)
  await first.destroy()
  assert.equal(cancelled, 1, 'unmount detaches the viewer')
  const second = await mount()
  try {
    await settle()
    assert.equal(submitted, 1, 'reentry never starts another provider request')
    assert.match(second.container.textContent!, /主角二十六岁，职业是调查记者/)
    assert.doesNotMatch(second.container.textContent!, /已停止生成/)
  } finally { await second.destroy() }
})

test('stop generation calls the server cancellation endpoint and displays its terminal result', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  let taskId = '', cancelled = 0, viewer: ReadableStreamDefaultController<Uint8Array> | null = null
  const encode = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ conversations: [], task_persistence: true, tasks: [] })
    if (path.endsWith('/chat/stream')) {
      taskId = JSON.parse(String(init?.body)).task.id
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        viewer = controller; controller.enqueue(encode.encode(event({ type: 'task', task_id: taskId })))
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path.endsWith(`/tasks/${taskId}/cancel`)) {
      cancelled++
      viewer!.enqueue(encode.encode(event({ type: 'error', task_status: 'cancelled', message: '已停止生成。' })))
      viewer!.close()
      return Response.json({ status: 'cancelled' })
    }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await act(() => typeMessage('讨论人物年龄'))
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
    await settle()
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')!.click())
    await settle()
    assert.equal(cancelled, 1)
    assert.match(view.container.textContent!, /已停止生成/)
    assert.equal(view.container.querySelector('.sd-message-failure'), null)
  } finally { await view.destroy() }
})

test('a resumed task failure has one styled diagnostic at its reply, with partial text, timing and retry preserved', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  const reason = '负岳玄龟参与终局，但缺少众人如何找到并说服它的核心因果。'
  const execution = { title: '生成全剧大纲', request: '生成故事大纲', started_at: Date.now() - 60000 }
  const task = { id: 'resumed-failed', message_id: 'reply-failed', conversation_id: 'failed-conversation', started_at: execution.started_at, execution }
  let finished = false
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ task_persistence: true, tasks: finished ? [] : [task], conversations: [{ id: task.conversation_id, label: '生成大纲', messages: [
      { id: 'request', role: 'user', text: '生成故事大纲' },
      { id: task.message_id, role: 'assistant', text: finished ? reason : '正在处理创作任务…', pending: !finished, failed: finished, task_id: task.id,
        execution: finished ? { ...execution, outcome: { kind: 'failed', summary: reason } } : execution, processing_duration_ms: finished ? 61000 : undefined },
    ] }] })
    if (path.endsWith(`/tasks/${task.id}/stream`)) {
      finished = true
      return new Response(event({ type: 'delta', text: '已完成的开场：主角进入山林寻找援手。' }) + event({ type: 'error', task_status: 'failed', message: reason }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await settle()
    const reply = view.container.querySelector(`[data-message-id="${task.message_id}"]`)!
    assert.equal(reply.querySelectorAll('.sd-message-failure').length, 1)
    assert.equal(view.container.querySelector('.script-director-error'), null)
    assert.equal(reply.querySelectorAll('.sd-message-timing').length, 1)
    assert.match(reply.querySelector('.script-director-bubble')!.textContent!, /已完成的开场/)
    assert.equal(reply.querySelector('.sd-message-failure .script-message-content')!.textContent, reason)
    assert.ok([...reply.querySelectorAll('button')].some(button => button.textContent === '重试本轮'))
    assert.equal(reply.textContent!.split(reason).length - 1, 1)
  } finally { await view.destroy() }
  const restored = await mount()
  try {
    await settle()
    const reply = restored.container.querySelector(`[data-message-id="${task.message_id}"]`)!
    assert.equal(reply.querySelectorAll('.sd-message-failure').length, 1)
    assert.equal(reply.querySelector('.script-director-bubble'), null)
    assert.equal(restored.container.querySelector('.script-director-error'), null)
    assert.match(reply.querySelector('.sd-message-timing')!.textContent!, /1 分 1 秒/)
  } finally { await restored.destroy() }
})

test('independent asset discussion starts once after conversation history is loaded', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  let release!: (value: Response) => void, submissions = 0
  const history = new Promise<Response>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return history
    if (path.endsWith('/chat/stream')) {
      submissions++
      const taskId = JSON.parse(String(init?.body)).task.id
      return new Response(event({ type: 'task', task_id: taskId }) + event({ type: 'done', reply: '人物设定已整理。' }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount('character')
  try {
    await settle(); assert.equal(submissions, 0)
    await act(() => release(Response.json({ task_persistence: true, conversations: [], tasks: [] })))
    await settle(); assert.equal(submissions, 1)
    assert.match(view.container.textContent!, /人物设定已整理/)
  } finally { await view.destroy() }
})

test('a restored running task can still be stopped while source analysis blocks new messages', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  const taskId = 'restored-task', conversationId = 'restored-conversation'
  const execution = { title: '剧本创作对话', request: '整理故事', started_at: Date.now(), focus_artifact: 'all', mode: 'script' }
  let viewer: ReadableStreamDefaultController<Uint8Array> | null = null, cancelled = 0, submitted = 0
  const encode = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/source')) return Response.json({ project_id: detail.id, filename: '原稿.txt', content: '原稿正文', updated_at: 'version',
      analysis: { id: 'analysis', status: 'running', completed_chunks: 0, total_chunks: 1, sections: [] } })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ task_persistence: true,
      tasks: [{ id: taskId, conversation_id: conversationId, message_id: taskId, started_at: execution.started_at, execution }],
      conversations: [{ id: conversationId, label: '整理故事', messages: [
        { id: 'question', role: 'user', text: '整理故事' },
        { id: taskId, role: 'assistant', text: '正在处理创作任务…', pending: true, execution, task_id: taskId },
      ] }] })
    if (path.endsWith(`/tasks/${taskId}/stream`)) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      viewer = controller; controller.enqueue(encode.encode(event({ type: 'task', task_id: taskId })))
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
    if (path.endsWith(`/tasks/${taskId}/cancel`)) {
      cancelled++
      viewer!.enqueue(encode.encode(event({ type: 'error', task_status: 'cancelled', message: '已停止生成。' })))
      viewer!.close()
      return Response.json({ status: 'cancelled' })
    }
    if (path.endsWith('/chat/stream')) { submitted++; throw new Error('must not resubmit restored task') }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await settle()
    const stop = view.container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')!
    assert.ok(stop); assert.equal(stop.disabled, false)
    await act(() => stop.click()); await settle()
    assert.equal(cancelled, 1); assert.equal(submitted, 0)
    assert.match(view.container.textContent!, /已停止生成/)
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, true)
  } finally { await view.destroy() }
})

const pendingResolution = { id: 'resolution-1', version: 'v1', stage: 'outline', episode_number: 0, document_count: 9,
  findings: [{ source_key: 'outline', kind: 'missing_core_setting', quote: '龟龙在终局协助主角。', explanation: '缺少龟龙主动合作的动机。', suggestion: '补齐相遇、争取合作和承担风险的原因。' },
    { source_key: 'world', kind: 'contradiction', quote: '三日后出发。当天抵达。', explanation: '期限前后矛盾。', suggestion: '统一相关时间线。' }] }
function resolutionButton(text: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  assert.ok(value, text); return value
}
function typeResolution(index: number, text: string) {
  const field = document.querySelectorAll<HTMLTextAreaElement>('[role="dialog"] textarea')[index]!
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}
function setupResolution(t: any, chat: (body: any) => object) {
  dom.window.localStorage.clear(); dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  let resolution: any = structuredClone(pendingResolution), draft: any = null, discarded = 0
  const requests: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft, decisions: [], draft_resolution: resolution })
    if (path.endsWith('/source')) return Response.json(null)
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ conversations: [], task_persistence: true, tasks: [] })
    if (path.endsWith('/resolutions/resolution-1/discard')) { assert.deepEqual(body, { version: resolution.version }); resolution = null; discarded++; return Response.json({}) }
    if (path.endsWith('/chat/stream')) {
      requests.push(body); const result: any = chat(body)
      if (result.draft_resolution !== undefined) resolution = result.draft_resolution
      if (result.tool_draft) draft = result.tool_draft
      return new Response(event({ type: result.type || 'done', ...result }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected ${path}`)
  })
  return { requests, discarded: () => discarded }
}

test('restored findings can be deferred and reopened, manual answers resume the same candidate and AI proceeds to preview', async t => {
  const fixture = setupResolution(t, body => fixture.requests.length === 1 ? { reply: '还需补齐时间线。', draft_resolution: { ...pendingResolution, version: 'v2', findings: pendingResolution.findings.slice(1).map(finding => ({ ...finding, previous_answer: '统一为三日后出发。', repair_attempts: 1 })) }, execution_outcome: { kind: 'question' } }
    : { reply: '已补齐，等待确认。', draft_resolution: null, tool_draft: { id: 'ready-draft', version: 'd1', status: 'pending', kind: 'create', summary: '补齐合作与期限。', workflow: { stage: 'outline', scope: 'project', episode_number: 0, scenes: [], artifacts: [] },
      documents: [{ id: 'new-outline', artifact_type: 'outline', episode_number: 0, title: '全剧大纲', content: '全剧60集。龟龙为守护河道自愿合作，三日后出发。', original_content: '', version: 'doc1', replacements: [] }], scenes: [] } })
  const view = await mount()
  try {
    await settle()
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /缺少龟龙主动合作/)
    assert.equal(resolutionButton('按填写内容补齐').disabled, true)
    await act(() => typeResolution(0, '龟龙为了守护河道自愿合作，保留60集。'))
    await act(() => resolutionButton('稍后处理').click()); await settle()
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(view.container.textContent!, /草稿有 2 项待处理/)
    await act(() => resolutionButton('处理问题').click())
    assert.equal(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value, '龟龙为了守护河道自愿合作，保留60集。')
    await act(() => typeResolution(1, '统一为三日后出发。'))
    await act(() => resolutionButton('按填写内容补齐').click()); await settle()
    assert.deepEqual(fixture.requests[0].draft_resolution, { id: 'resolution-1', version: 'v1', strategy: 'manual', answers: ['龟龙为了守护河道自愿合作，保留60集。', '统一为三日后出发。'] })
    assert.equal(fixture.requests[0].workflow, undefined); assert.equal(fixture.requests[0].question_response, undefined)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /时间线/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value, '统一为三日后出发。')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已带入你之前填写的方案/)
    assert.equal(resolutionButton('按填写内容补齐').disabled, false)
    await act(() => resolutionButton('全部交给 AI 决定').click()); await settle()
    assert.deepEqual(fixture.requests[1].draft_resolution, { id: 'resolution-1', version: 'v2', strategy: 'ai' })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(view.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /确认后写入项目/)
    assert.doesNotMatch(view.container.textContent!, /草稿有 \d 项待处理/)
  } finally { await view.destroy() }
})

test('failed AI resolution retains the entry and candidate across remount, then supports versioned discard', async t => {
  const fixture = setupResolution(t, () => ({ type: 'error', task_status: 'failed', message: '核对模型暂不可用', draft_resolution: {
    ...pendingResolution, run: { strategy: 'ai', status: 'interrupted', completed: 1, total: 2, message: '核对模型暂不可用' },
  } }))
  const first = await mount()
  await settle()
  await act(() => resolutionButton('全部交给 AI 决定').click()); await settle()
  assert.equal(document.querySelector('[role="dialog"]'), null, 'technical failure never reopens a decision modal')
  assert.match(first.container.textContent!, /草稿处理尚未完成/)
  assert.match(first.container.textContent!, /1\/2/)
  await first.destroy()
  const second = await mount()
  try {
    await settle(); assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(fixture.requests.length, 1, 'remount never resubmits AI repair')
    await act(() => resolutionButton('查看问题').click()); await settle()
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已有方案和授权已保留/)
    await act(() => resolutionButton('放弃候选稿').click()); await settle()
    assert.equal(fixture.discarded(), 1); assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.doesNotMatch(second.container.textContent!, /草稿有 \d 项待处理/)
  } finally { await second.destroy() }
})

test('an interrupted resolution continues the retained authorization without another decision or automatic submission', async t => {
  const fixture = setupResolution(t, () => fixture.requests.length === 1 ? { type: 'error', task_status: 'failed', message: '连接中断',
    draft_resolution: { ...pendingResolution, run: { strategy: 'manual', status: 'interrupted', completed: 1, total: 2 },
      findings: pendingResolution.findings.map(finding => ({ ...finding, previous_answer: '沿用三日后出发，保留60集。' })) } }
    : { reply: '已按原方案修订，待保存。', draft_resolution: null })
  const first = await mount()
  await settle()
  await act(() => typeResolution(0, '龟龙主动保护河道。'))
  await act(() => typeResolution(1, '三日后出发。'))
  await act(() => resolutionButton('按填写内容补齐').click()); await settle()
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await first.destroy()
  const reopened = await mount()
  try {
    await settle()
    assert.equal(fixture.requests.length, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(() => resolutionButton('继续处理').click()); await settle()
    assert.deepEqual(fixture.requests[1].draft_resolution, { id: pendingResolution.id, version: pendingResolution.version, strategy: 'continue' })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.doesNotMatch(reopened.container.textContent!, /草稿处理尚未完成/)
  } finally { await reopened.destroy() }
})

test('source repair previews survive reopening and both save paths commit the visible source version', async t => {
  for (const native of [true, false]) await t.test(native ? 'native source edit' : 'JSON source edit', async t => {
    dom.window.localStorage.clear(); dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
    const original = { project_id: detail.id, filename: '原稿.txt', content: '全剧60集。龟龙合作，动机待补齐。', updated_at: 'original-version' }
    const repaired = '全剧60集。龟龙为守护河道合作。', manual = '全剧60集。龟龙为守护河道合作，每晚轮流巡查。'
    const sourceUpdate = { id: 'source-revision', base_version: 'base', original_content: original.content, content: repaired,
      replacements: [{ find: '动机待补齐。', replace: '为守护河道。', reason: '补齐合作动机' }] }
    const workflow = { stage: 'outline', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'outline', title: '全剧大纲', content: repaired }], scenes: [] }
    let pending: any = native ? { id: 'draft-source', version: 'v1', kind: 'create', status: 'pending', summary: '补齐动机', workflow, source_update: sourceUpdate,
      documents: [{ id: 'outline', artifact_type: 'outline', episode_number: 0, title: '全剧大纲', content: repaired, original_content: '', version: '', replacements: [] }] } : null
    let effective: any = original, resolution: any = pendingResolution, commits = 0, originalReads = 0, failSave = !native
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (path.endsWith('/skills/defaults')) return Response.json(policies)
      if (path.endsWith('/tools-state')) return Response.json({ draft: resolution ? null : pending, decisions: [], draft_resolution: resolution })
      if (path.endsWith('/source/original')) { originalReads++; return Response.json(original) }
      if (path.endsWith('/source')) return Response.json(effective)
      if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
      if (path.endsWith('/conversations')) return Response.json({ conversations: [], task_persistence: false, tasks: [] })
      if (path.endsWith('/chat/stream')) {
        resolution = null
        return new Response(event({ type: 'done', reply: '已补齐待确认', draft_resolution: null, ...(native ? { tool_draft: pending } : { draft: workflow, source_update: sourceUpdate }) }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (path.endsWith('/tool-drafts/draft-source') && init?.method === 'PUT') {
        assert.equal(body.source_content, manual); assert.equal(body.version, 'v1')
        pending = { ...pending, version: 'v2', source_update: { ...pending.source_update, content: body.source_content } }; return Response.json(pending)
      }
      if (path.endsWith('/commit') || path.endsWith('/director/draft')) {
        commits++
        if (native) { assert.equal(body.version, 'v2'); assert.equal(pending.source_update.content, manual) }
        else { assert.equal(body.source_update.content, manual); assert.equal(body.source_update.base_version, 'base') }
        if (failSave) { failSave = false; return Response.json({ error: '保存暂不可用' }, { status: 503 }) }
        effective = { ...original, content: manual, revision: 1, updated_at: 'revised-version', analysis: null }
        const saved = native ? { ...pending, status: 'saved' } : { ...detail.script, outline: repaired, artifacts: [{ artifact_type: 'outline', episode_number: 0, content: repaired }] }
        pending = null; return Response.json(saved)
      }
      throw new Error(`Unexpected ${path}`)
    })
    const first = await mount()
    await settle()
    assert.equal(first.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, true, 'new messages wait for source analysis while candidate completion remains available')
    await act(() => resolutionButton('全部交给 AI 决定').click()); await settle()
    assert.match(first.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /确认保存将同时更新当前有效稿/)
    assert.equal(commits, 0); assert.equal(effective.content, original.content)
    await act(() => resolutionButton('编辑').click())
    await act(() => {
      const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑草稿：文稿修订 · 当前有效稿"]')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, manual)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.match(first.container.querySelector('.sd-change-preview')!.textContent!, /动机待补齐/)
    assert.match(first.container.querySelector('.sd-change-preview')!.textContent!, /每晚轮流巡查/)
    await first.destroy()
    const reopened = await mount()
    try {
      await settle()
      assert.match(reopened.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /每晚轮流巡查/)
      await act(() => resolutionButton('确认保存').click()); await settle()
      if (!native) {
        assert.equal(effective.content, original.content, 'failed confirmation keeps committed source unchanged')
        await act(() => resolutionButton('确认保存').click()); await settle()
      }
      assert.equal(effective.content, manual); assert.match(reopened.container.textContent!, /当前有效稿 · 第 1 次修订/)
      await act(() => document.querySelector<HTMLButtonElement>('button[aria-label="查看当前有效稿：原稿.txt"]')!.click()); await settle()
      assert.match(document.querySelector('[role="dialog"]')!.textContent!, /每晚轮流巡查/)
      const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === '上传原稿')!
      await act(() => tab.click())
      assert.match(document.getElementById(tab.getAttribute('aria-controls')!)!.textContent!, /动机待补齐/); assert.ok(originalReads > 0)
    } finally { await reopened.destroy() }
  })
})

test('continue remaining steps uses the saved task rather than submitting a new chat request', async t => {
  dom.window.localStorage.clear()
  const execution = { title: '生成故事大纲', request: '保留水墨风格', started_at: Date.now() - 60000, outcome: { kind: 'failed', summary: '复核连接中断' } }
  const task = { id: 'continue-existing', message_id: 'continue-existing', conversation_id: 'continue-conversation', started_at: execution.started_at, execution }
  let continued = 0, attached = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ task_persistence: true, tasks: [], conversations: [{ id: task.conversation_id, label: '生成大纲', messages: [
      { id: 'request', role: 'user', text: '保留水墨风格' },
      { id: task.id, role: 'assistant', text: '复核连接中断', failed: true, task_id: task.id, task_can_resume: true, execution },
    ] }] })
    if (path.endsWith(`/tasks/${task.id}/continue`)) { continued++; return Response.json({ ...task, execution: { ...execution, outcome: undefined } }) }
    if (path.endsWith(`/tasks/${task.id}/stream`)) { attached++; return new Response(event({ type: 'task', task_id: task.id }) + event({ type: 'done', reply: '已复用生成结果并完成独立复核，待确认保存。' }), { headers: { 'Content-Type': 'text/event-stream' } }) }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await settle()
    const button = [...view.container.querySelectorAll('button')].find(button => button.textContent === '继续未完成步骤')!
    assert.ok(button)
    await act(() => button.click())
    await settle()
    assert.equal(continued, 1); assert.equal(attached, 1)
    assert.match(view.container.textContent!, /完成独立复核/)
  } finally { await view.destroy() }
})

test('sixty seconds without events reconnects the acknowledged task and does not fail or resubmit it', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('script-director-model:director-resume', model.id)
  let submitted = 0, reattached = 0, taskId = ''
  t.mock.method(Math, 'random', () => 0.5)
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ task_persistence: true, tasks: [], conversations: [] })
    if (path.endsWith('/chat/stream')) {
      submitted++; taskId = JSON.parse(String(init?.body)).task.id
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event({ type: 'task', task_id: taskId }))) } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path.endsWith(`/tasks/${taskId}/stream`)) {
      reattached++
      return new Response(event({ type: 'done', reply: '原任务已完成，创作要求完整保留。' }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await settle()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await act(() => typeMessage('讨论水墨画风'))
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
    await act(async () => { t.mock.timers.tick(60000) })
    assert.match(view.container.textContent!, /重新连接当前任务/)
    assert.equal(view.container.querySelector('.sd-message-failure'), null)
    await act(async () => { t.mock.timers.tick(1000) })
    assert.equal(submitted, 1); assert.equal(reattached, 1)
    assert.match(view.container.textContent!, /创作要求完整保留/)
  } finally { await view.destroy() }
})
