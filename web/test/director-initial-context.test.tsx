import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import { skillStageOptions, type SkillPolicy } from '../src/shared/api/skills-api'
import { directorStageContext } from '../src/features/script/script-workflow'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { replyClassificationVersion } from '../src/features/script/script-reply'
import { skillTaskDefinitions } from '@video-studio/shared/skills/skill-recommendation'
import { rememberModelSelection, rememberedModelId } from '../src/features/models/model-selection-store'
import { chooseCombobox } from './component-controls'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
after(() => dom.window.close())

const detail = { id: 'context-project', name: '上下文测试', brief: '', ratio: '9:16',
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
  shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text-model', provider_id: 'provider', name: '文本模型', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const provider = { id: 'provider', name: '提供商', enabled: true, adapter: 'http' } as Provider

async function mount(t: TestContext, initialContext: string, savedInput = '', savedReferences: unknown[] = [], savedMessages: unknown[] = [], chatResponse?: Promise<Response>, options: {
  remoteConversations?: unknown[]; failConversationSave?: boolean; notices?: string[]; refresh?: () => Promise<unknown>
  draft?: unknown; progressDiscard?: (body: unknown) => Response
} = {}) {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem(`script-director-input:${detail.id}`, savedInput)
  dom.window.localStorage.setItem(`script-director-references:${detail.id}`, JSON.stringify(savedReferences))
  if (chatResponse) dom.window.localStorage.setItem(`script-director-model:${detail.id}`, model.id)
  if (savedMessages.length) dom.window.localStorage.setItem(`script-director-conversations:${detail.id}`, JSON.stringify({ messages: savedMessages, history: [] }))
  if (options.draft) dom.window.localStorage.setItem(`script-director-draft:${detail.id}`, JSON.stringify(options.draft))
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (init?.method && init.method !== 'GET') writes.push(path)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) {
      if (init?.method && init.method !== 'GET') {
        if (options.failConversationSave) throw new Error('mock conversation save failure')
        return Response.json({})
      }
      return Response.json({ conversations: options.remoteConversations || [] })
    }
    if (path.endsWith('/chat/stream') && chatResponse) return chatResponse
    if (path.endsWith('/generation-progress/discard') && options.progressDiscard) return options.progressDiscard(JSON.parse(String(init?.body)))
    throw new Error(`Unexpected ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (context = initialContext) => { await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={chatResponse ? [model] : []} providers={chatResponse ? [provider] : []} initialContext={context}
    onRefresh={options.refresh || (async () => {})} onClose={() => {}} onOpenModels={() => {}} onNotice={(notice) => options.notices?.push(notice)} /></MantineProvider>)) }
  await update()
  return { container, update, writes, async destroy() { await act(() => root.unmount()); container.remove() } }
}
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
const storedReferences = () => JSON.parse(dom.window.localStorage.getItem(`script-director-references:${detail.id}`) || '[]')

test('discarding a restored edited JSON preview targets its original checkpoint and refreshes the canvas', async t => {
  const token = { checkpoint_key: 'original-generation-key', updated_at: '2026-11-09T10:00:00.000Z' }
  const discarded: unknown[] = []
  let refreshes = 0
  const view = await mount(t, '', '', [], [], undefined, {
    draft: { workflow: { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['outline'] },
      generation_checkpoint: token, outline: '已在预览中编辑的正文。', characters: '', scenes: [],
      artifacts: [{ artifact_type: 'outline', title: '已编辑标题', content: '已在预览中编辑的正文。' }] },
    refresh: async () => { refreshes++ },
    progressDiscard: body => { discarded.push(body); return Response.json({ discarded: true }) },
  })
  try {
    const discard = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '放弃草稿')
    assert.ok(discard)
    await act(async () => discard.click())
    assert.deepEqual(discarded, [token], 'local preview edits and a reload preserve the original generation version')
    assert.equal(refreshes, 1)
    assert.equal(dom.window.localStorage.getItem(`script-director-draft:${detail.id}`), null)
  } finally { await view.destroy() }
})

test('completed columns refresh the canvas before the task finishes and repeated stream snapshots are deduplicated', async t => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
  let refreshes = 0
  const encoder = new TextEncoder()
  const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const view = await mount(t, '生成故事大纲', '', [], [], Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })), {
    refresh: async () => { refreshes++; if (refreshes === 1) await refreshGate },
  })
  const column = (id: string, type: 'outline' | 'synopsis') => ({ id, kind: 'context', scope: 'task', label: `编写${type}`, summary: '本项成果已保留',
    status: 'succeeded', started_at: 1, artifact_preview: { stage: 'outline', scope: 'project', episode_number: 0,
      artifacts: [{ artifact_type: type, title: `${type}文档`, content: `${type}完整内容` }], scenes: [] } })
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    const first = column('first-column', 'outline'), second = column('second-column', 'synopsis')
    await act(async () => {
      send({ type: 'activity', activity: first })
      send({ type: 'activity', activity: [first, second] })
    })
    assert.equal(refreshes, 1, 'parallel column completions share the in-flight project refresh')
    assert.ok(view.container.querySelector('[aria-label="停止生成"]'), 'the generation task is still running')
    await act(async () => releaseRefresh())
    assert.equal(refreshes, 2, 'a completion arriving during refresh gets one trailing refresh')
    await act(async () => send({ type: 'activity', activity: [first, second] }))
    assert.equal(refreshes, 2, 'replayed activity snapshots do not refetch the same saved columns')
    const token = { checkpoint_key: 'stream-generation', updated_at: '2026-11-09T11:00:00.000Z' }
    await act(async () => {
      send({ type: 'done', reply: '所有栏目已完成，请确认草稿。', generation_checkpoint: token,
        draft: { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['outline', 'synopsis'],
          artifacts: [first.artifact_preview.artifacts[0], second.artifact_preview.artifacts[0]], scenes: [] },
        classification: { type: 'other' }, classification_version: replyClassificationVersion })
      controller.close()
    })
    assert.equal(refreshes, 3, 'the final transition refreshes persisted draft visibility')
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(`script-director-draft:${detail.id}`)!).generation_checkpoint, token)
  } finally { releaseRefresh(); await view.destroy() }
})

test('a resolution-only final result refreshes persisted canvas draft state', async t => {
  let refreshes = 0
  const result = { type: 'done', reply: '候选稿处理状态已更新。', draft_resolution: null,
    classification: { type: 'other' }, classification_version: replyClassificationVersion }
  const view = await mount(t, '继续处理候选稿', '', [], [], Promise.resolve(new Response(`data: ${JSON.stringify(result)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })), { refresh: async () => { refreshes++ } })
  try {
    await act(async () => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    assert.equal(refreshes, 1)
  } finally { await view.destroy() }
})

async function openHeaderDocuments(container: HTMLElement) {
  const more = container.querySelector<HTMLButtonElement>('[aria-label="更多剧本工具"]')
  assert.ok(more, 'the header exposes its tools menu')
  assert.equal(container.querySelector('.script-director-header [aria-label="项目文档"]'), null, 'document tools are grouped in the menu')
  await act(() => more.click())
  const documents = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="项目文档"]')
  assert.ok(documents, 'project documents remain reachable through the portaled menu')
  await act(() => documents.click())
}
async function openComposerOptions(container: HTMLElement) {
  const options = container.querySelector<HTMLButtonElement>('[aria-label="创作选项"]')!
  assert.ok(options)
  if (options.getAttribute('aria-expanded') !== 'true') await act(() => options.click())
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-label="创作选项面板"]')
  assert.ok(panel, 'creation options open in their own popover')
  assert.ok(panel.querySelector('[aria-label="剧本创作技能选择"]'))
  return panel
}
async function closeComposerOptions(container: HTMLElement) {
  const options = container.querySelector<HTMLButtonElement>('[aria-label="创作选项"]')!
  if (options.getAttribute('aria-expanded') === 'true') await act(() => options.click())
  assert.equal(options.getAttribute('aria-expanded'), 'false')
}
async function chooseCreationMode(panel: HTMLElement, label: string) {
  const group = panel.querySelector('[role="group"][aria-label="创作模式"]')!
  assert.ok(group)
  assert.equal(group.querySelectorAll('button').length, 3)
  const choice = group.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  assert.ok(choice, `creation mode: ${label}`)
  await act(() => choice.click())
  assert.equal(choice.getAttribute('aria-pressed'), 'true')
  assert.equal(group.querySelectorAll('[aria-pressed="true"]').length, 1)
}

test('incoming node context appends to an unsent draft once without sending or starting generation', async t => {
  const context = '【画布节点配置快照｜只读｜time-1】\n实际模型与提示词'
  const view = await mount(t, context, '尚未发送的创作要求')
  try {
    assert.equal(composer().value, `尚未发送的创作要求\n\n${context}`)
    await view.update()
    assert.equal(composer().value.split(context).length, 2)
    const second = '【画布节点配置快照｜只读｜time-2】\n新节点'
    await view.update(second)
    assert.equal(composer().value, `尚未发送的创作要求\n\n${context}\n\n${second}`)
    assert.deepEqual(view.writes, [])
  } finally { await view.destroy() }
  const remounted = await mount(t, context, `尚未发送的创作要求\n\n${context}`)
  try { assert.equal(composer().value.split(context).length, 2) }
  finally { await remounted.destroy() }
})

test('long snapshots use a complete reference and preserve the composer and prior references', async t => {
  const context = '【画布节点配置快照｜只读｜time-1】\n' + '长提示词😀'.repeat(3000)
  const saved = { key: 'existing', title: '已有引用', artifact_type: 'outline', episode_number: 0, content: '原内容' }
  const view = await mount(t, context, '保留我的要求', [saved])
  try {
    assert.equal(composer().value, '保留我的要求')
    assert.equal(storedReferences().length, 2)
    assert.deepEqual(storedReferences()[0], saved)
    assert.equal(storedReferences()[1].content, context)
    await view.update()
    assert.equal(storedReferences().length, 2)
    assert.ok(view.container.querySelector('[aria-label="查看引用文档：画布节点配置快照"]'))
    assert.deepEqual(view.writes, [])
  } finally { await view.destroy() }
})

test('full reference capacity rejects the new context explicitly while retaining existing work', async t => {
  const references = Array.from({ length: 4 }, (_, i) => ({ key: `existing-${i}`, title: `已有引用${i}`, artifact_type: 'outline', episode_number: 0, content: `原内容${i}` }))
  const view = await mount(t, '【画布节点配置快照｜只读｜time-1】' + '长'.repeat(9000), '待发送草稿', references)
  try {
    assert.equal(composer().value, '待发送草稿')
    assert.deepEqual(storedReferences(), references)
    assert.match(view.container.textContent!, /未能添加上下文，原输入已保留.*一次最多引用 4 份文档/)
    assert.deepEqual(view.writes, [])
  } finally { await view.destroy() }
})

test('a verified old director cache is recreated when a later conversation save fails', async t => {
  const cached = { id: 'cached-message', role: 'user', text: '已保存的创作要求' }
  const notices: string[] = []
  const chatResponse = Promise.resolve(new Response(`data: ${JSON.stringify({ type: 'done', reply: '新的回复已完成。' })}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  }))
  const view = await mount(t, '', '', [], [cached], chatResponse, {
    remoteConversations: [{ id: 'cached-conversation', label: '已保存的创作要求', messages: [cached] }],
    failConversationSave: true, notices,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(dom.window.localStorage.getItem(`script-director-conversations:${detail.id}`), null,
      'the duplicate cache is released only after the matching server snapshot is loaded')
    const field = composer()
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '继续补充新的要求')
    await act(() => field.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
    await new Promise(resolve => setTimeout(resolve, 500))
    const fallback = JSON.parse(dom.window.localStorage.getItem(`script-director-conversations:${detail.id}`) || 'null')
    assert.ok(fallback?.messages?.some((message: { text: string }) => message.text === '继续补充新的要求'))
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="关闭剧本导演"]')!.click())
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.match(notices.join('\n'), /对话已缓存在本机/)
  } finally { await view.destroy() }
})

test('incoming context reveals the composer while preserving an unanswered director question', async t => {
  const question = { id: 'question', role: 'assistant', text: JSON.stringify({ kind: 'choices', question: '选择故事方向',
    interaction: { stage: directorStageContext(detail.script).stage, purpose: 'setting' },
    options: [{ id: 'a', text: '调查列车失踪' }, { id: 'b', text: '寻找车站旧人' }] }) }
  const view = await mount(t, '', '', [], [question])
  try {
    assert.ok(!composer(), 'the unanswered question initially occupies the composer')
    const questionPanel = view.container.querySelector('[aria-label="当前待回答问题"]')!
    assert.ok(questionPanel.querySelector('[aria-label="创作选项"]'), 'questions keep the same creation options entry beside their controls')
    const options = await openComposerOptions(view.container)
    await chooseCreationMode(options, '导演执导')
    await closeComposerOptions(view.container)
    assert.equal(view.container.querySelector('[aria-label="当前待回答问题"]'), questionPanel, 'opening options preserves the pending question')
    assert.ok(!composer())
    const context = '【画布节点配置快照｜只读｜time-3】\n现在讨论这个节点'
    await view.update(context)
    assert.equal(composer().value, context)
    assert.match(view.container.textContent!, /调查列车失踪/)
    const field = composer()
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.ok(!composer(), 'the unanswered question returns after removing the context draft')
    assert.deepEqual(view.writes, [])
  } finally { await view.destroy() }
})

test('a failing older director request cannot replace a newly attached long node snapshot', async t => {
  let fail!: (reason: Error) => void
  const pending = new Promise<Response>((_resolve, reject) => { fail = reject })
  const oldReference = { key: 'old', title: '旧请求附件', artifact_type: 'outline', episode_number: 0, content: '旧内容' }
  const view = await mount(t, '', '先讨论原来的要求', [oldReference], [], pending)
  try {
    const send = view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!
    assert.ok(send && !send.disabled)
    await act(() => send.click())
    assert.equal(storedReferences().length, 0, 'the running request has consumed its original attachments')
    const context = '【画布节点配置快照｜只读｜time-4】' + '新快照'.repeat(3000)
    await view.update(context)
    assert.equal(storedReferences()[0].content, context)
    await act(async () => fail(new Error('mock connection failed')))
    assert.equal(storedReferences().length, 1)
    assert.equal(storedReferences()[0].content, context, 'the newer unsent snapshot stays intact on failure')
    assert.equal(composer().value, '先讨论原来的要求')
    assert.ok(view.writes.some(path => path.endsWith('/chat/stream')))
    assert.ok(view.writes.every(path => !path.endsWith('/generate')))
  } finally { await view.destroy() }
})

async function mountAutomaticDirector(t: TestContext, input: string, project = detail, sourceDocument: unknown = null,
  options: { models?: Model[]; rememberedModel?: string; legacyModel?: string; chatResponse?: () => Promise<Response> } = {}) {
  dom.window.localStorage.clear()
  if (options.rememberedModel) rememberModelSelection('text', options.rememberedModel)
  if (options.legacyModel) dom.window.localStorage.setItem(`script-director-model:${project.id}`, options.legacyModel)
  dom.window.localStorage.setItem(`script-director-input:${project.id}`, input)
  dom.window.localStorage.setItem(`script-director-model:${project.id}`, model.id)
  const requests: Array<{ path: string; body: any }> = []
  const policies: SkillPolicy[] = skillStageOptions.map(({ value: stage, label }) => ({ stage, label,
    primary_id: stage === 'script' ? 'script_write' : `${stage}-default`, auxiliary_ids: [], source: 'global', warning: '', skills: stage === 'script'
      ? skillTaskDefinitions.filter(task => task.stage === 'script').map(task => ({ id: task.kind, name: task.primary_name, description: task.label, revision: 'a'.repeat(40) })) : [
      { id: `${stage}-default`, name: `default-${stage}`, description: '默认创作方法', revision: 'a'.repeat(40) },
      { id: 'review', name: 'short-drama-review', description: '独立审查', revision: 'a'.repeat(40) },
    ] }))
  const taskPolicies = skillTaskDefinitions.map(task => ({ ...policies.find(policy => policy.stage === task.stage)!,
    task: task.kind, label: task.label, primary_id: task.stage === 'script' ? task.kind : `${task.stage}-default` }))
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies, task_policies: taskPolicies })
    if (path.endsWith('/script/source')) return Response.json(sourceDocument)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.includes('/conversations/')) return Response.json({})
    if (path.endsWith('/chat/stream') && options.chatResponse) return options.chatResponse()
    if (path.endsWith('/chat/stream')) return new Response(`data: ${JSON.stringify({ type: 'done', reply: '本轮请求已完成。',
      classification: { type: 'other' }, classification_version: replyClassificationVersion })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={project} models={options.models || [model]} providers={[provider]}
    onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  return { container, requests, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('director leaves automatic skill selection to the model and sends only explicit manual overrides', async t => {
  const view = await mountAutomaticDirector(t, '规划故事大纲和分集地图')
  try {
    const originalComposer = composer()
    assert.equal(view.container.querySelectorAll('button[aria-label="创作选项"]').length, 1, 'the composer exposes one creation options entry')
    let options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    assert.equal(composer(), originalComposer)
    assert.equal(composer().value, '规划故事大纲和分集地图')
    assert.equal(composer().closest('[hidden]'), null)
    await closeComposerOptions(view.container)
    assert.equal(composer(), originalComposer, 'opening and closing options keeps the same unsent input mounted')
    assert.equal(composer().value, '规划故事大纲和分集地图')
    assert.equal(view.requests.some(item => item.path.endsWith('/chat/stream')), false)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    let requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[0]?.body.skill_selections, {})
    assert.equal(requests[0]?.body.mode, 'script')
    await act(() => {
      const field = composer()
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '把第一集写成剧本正文')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const allModeComposer = composer()
    options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    await chooseCreationMode(options, '全能创作')
    assert.equal(composer(), allModeComposer)
    assert.equal(composer().value, '把第一集写成剧本正文', 'changing perspective preserves the unsent task')
    await closeComposerOptions(view.container)
    assert.equal(view.requests.filter(item => item.path.endsWith('/chat/stream')).length, 1, 'typing does not call a selection model')
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[1]?.body.skill_selections, {})
    assert.equal(requests[1]?.body.mode, 'all')
    options = await openComposerOptions(view.container)
    await chooseCreationMode(options, '导演执导')
    await act(() => options.querySelector<HTMLButtonElement>('[aria-label="剧本创作技能选择"]')!.click())
    const skillInput = document.querySelector<HTMLInputElement>('input[aria-label="script主技能"]')!
    await act(() => skillInput.click())
    await act(() => document.querySelector<HTMLElement>('[role="option"][value="__base__"]')!.click())
    await act(() => options.querySelector<HTMLButtonElement>('[aria-label="剧本创作技能选择"]')!.click())
    await closeComposerOptions(view.container)
    await act(() => {
      const field = composer()
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '继续补充场景对白')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[2]?.body.skill_selections, { script: [] })
    assert.equal(requests[2]?.body.mode, 'director')
    assert.deepEqual(requests[0]?.body.skill_selections, {}, 'later manual selection cannot change the earlier request')
  } finally { await view.destroy() }
})

test('a direct document review passes its operation to the model without freezing any automatic skill', async t => {
  const doc = { id: 'auto-character-doc', project_id: detail.id, artifact_type: 'characters', episode_number: 0,
    title: '全剧人物设定', content: '林晚是记者，陈默是医生。', status: 'ready', position: 0 }
  const project = { ...detail, script: { ...detail.script, outline: '已保存故事大纲', characters: doc.content, artifacts: [doc] } } as unknown as ProjectDetail
  const view = await mountAutomaticDirector(t, '规划故事大纲和分集地图', project)
  try {
    const options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    await closeComposerOptions(view.container)
    await openHeaderDocuments(view.container)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="阅读文档：全剧人物设定"]')!.click())
    const review = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '模型评审')
    assert.ok(review)
    await act(() => review.click())
    const request = view.requests.find(item => item.path.endsWith('/chat/stream'))!
    assert.deepEqual(request.body.document_action, { operation: 'review', document_ids: [doc.id] })
    assert.deepEqual(request.body.skill_selections, {})
    assert.equal(composer().value, '规划故事大纲和分集地图', 'direct review preserves the separate unsent composer task')
  } finally { await view.destroy() }
})

test('the explicit workflow panel shows fixed skills without making a model request', async t => {
  const view = await mountAutomaticDirector(t, '把第一集写成剧本正文')
  try {
    const options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    await closeComposerOptions(view.container)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="对话工具"]')!.click())
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '分阶段生成')
    assert.ok(menu)
    await act(() => menu.click())
    const panel = view.container.querySelector('[aria-label="分阶段生成面板"]')
    assert.ok(panel)
    assert.equal(panel.querySelector<HTMLInputElement>('[aria-label="创作阶段"]')!.value, '全剧故事大纲')
    assert.match(panel.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /short-drama-develop/)
    assert.equal(view.requests.filter(item => item.path.endsWith('/chat/stream')).length, 0, 'viewing a recommended workflow does not start generation')
  } finally { await view.destroy() }
})

test('the story outline button directly submits all nine documents with or without an uploaded source', async t => {
  const source = { project_id: detail.id, filename: '原稿.txt', content: '林晚返回旧车站调查父亲失踪。', updated_at: '2026-11-08T00:00:00Z',
    analysis: { id: 'source-analysis', status: 'ready', sections: [], completed_chunks: 1, total_chunks: 1 } }
  for (const sourceDocument of [null, source]) {
    const view = await mountAutomaticDirector(t, '保留已确认主线，设计完整故事大纲', detail, sourceDocument)
    try {
      const outline = [...view.container.querySelectorAll<HTMLButtonElement>('.sd-stage-actions button')].find(button => button.textContent === '故事大纲')!
      assert.ok(outline && !outline.disabled)
      await act(() => outline.click())
      const requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.body.workflow.intent, 'stage_design')
      assert.deepEqual(requests[0]!.body.workflow.artifact_types, [...scriptStageArtifacts.outline])
      assert.match(requests[0]!.body.messages.at(-1).text, /本次只交付：概要设计、故事简述、背景设定、全剧分段、钩子预设、伏笔与回收、反转预设、创作禁区、分集大纲/)
      assert.equal(document.querySelector('[aria-label="大纲交付范围"]'), null)
    } finally { await view.destroy() }
  }
})

test('the outline panel submits all nine documents with an uploaded source and has no summary-only choice', async t => {
  const source = { project_id: detail.id, filename: '原稿.txt', content: '林晚返回旧车站调查父亲失踪。', updated_at: '2026-11-08T00:00:00Z',
    analysis: { id: 'source-analysis', status: 'ready', sections: [], completed_chunks: 1, total_chunks: 1 } }
  const view = await mountAutomaticDirector(t, '保留原稿事实整理故事', detail, source)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="对话工具"]')!.click())
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '分阶段生成')!
    await act(() => menu.click())
    const panel = view.container.querySelector('[aria-label="分阶段生成面板"]')!
    const selectedSkill = () => panel.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!
    assert.match(selectedSkill(), /short-drama-develop/)
    assert.equal(panel.querySelector('[aria-label="大纲交付范围"]'), null)
    assert.match(panel.textContent!, /本次交付：概要设计、故事简述、背景设定、全剧分段、钩子预设、伏笔与回收、反转预设、创作禁区、分集大纲/)
    assert.equal(view.requests.some(item => item.path.endsWith('/chat/stream')), false)
    const generate = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '生成故事大纲')!
    await act(() => generate.click())
    const request = view.requests.find(item => item.path.endsWith('/chat/stream'))!
    assert.equal(request.body.workflow.intent, 'stage_design')
    assert.deepEqual(request.body.workflow.artifact_types, [...scriptStageArtifacts.outline])
    assert.deepEqual(request.body.skill_selections, {})
  } finally { await view.destroy() }
})

test('document revision displays the fixed skill for its target document, including legacy documents', async t => {
  for (const target of [
    { artifact_type: 'characters', title: '全剧人物设定', skill: 'short-drama-develop', legacy: false },
    { artifact_type: 'episode_script', title: '第一集正文', skill: 'short-drama-write', legacy: false },
    { artifact_type: 'characters', title: '人物设定', skill: 'short-drama-develop', legacy: true },
  ] as const) {
    const doc = { id: `revise-${target.artifact_type}`, project_id: detail.id, artifact_type: target.artifact_type,
      episode_number: target.artifact_type === 'episode_script' ? 1 : 0, title: target.title, content: '林晚在车站发现父亲的信。', status: 'ready', position: 0 }
    const project = { ...detail, script: { ...detail.script, outline: '已保存故事大纲', characters: target.legacy ? doc.content : '', artifacts: target.legacy ? [] : [doc] } } as unknown as ProjectDetail
    const view = await mountAutomaticDirector(t, '先讨论故事方向', project)
    try {
      await openHeaderDocuments(view.container)
      await act(() => view.container.querySelector<HTMLButtonElement>(`[aria-label="阅读文档：${target.title}"]`)!.click())
      const revise = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '对话修订')!
      await act(() => revise.click())
      const options = await openComposerOptions(view.container)
      assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, new RegExp(target.skill))
      await closeComposerOptions(view.container)
      assert.equal(view.requests.some(item => item.path.endsWith('/chat/stream')), false)
      await act(() => {
        const field = composer()
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, field.value + '补充调查动机。')
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
      const request = view.requests.find(item => item.path.endsWith('/chat/stream'))!
      assert.deepEqual(request.body.document_action, { operation: 'revise', document_ids: [target.legacy ? `legacy:${target.artifact_type}` : doc.id] })
      assert.deepEqual(request.body.skill_selections, {})
    } finally { await view.destroy() }
  }
})

test('opening a workflow from document revision displays the workflow skill and submits only that scope', async t => {
  const doc = { id: 'switch-episode', project_id: detail.id, artifact_type: 'episode_script', episode_number: 1,
    title: '第一集正文', content: '林晚在车站发现父亲的信。', status: 'ready', position: 0 }
  const project = { ...detail, script: { ...detail.script, artifacts: [doc] } } as unknown as ProjectDetail
  const view = await mountAutomaticDirector(t, '规划调查主线', project)
  const openWorkflow = async () => {
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="对话工具"]')!.click())
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '分阶段生成')!
    await act(() => menu.click())
    return view.container.querySelector('[aria-label="分阶段生成面板"]')!
  }
  try {
    await openHeaderDocuments(view.container)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="阅读文档：第一集正文"]')!.click())
    const revise = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '对话修订')!
    await act(() => revise.click())
    let options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /short-drama-write/)
    await closeComposerOptions(view.container)
    let panel = await openWorkflow()
    assert.match(panel.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /short-drama-develop/)
    await act(() => panel.querySelector<HTMLButtonElement>('[aria-label="关闭分阶段生成"]')!.click())
    options = await openComposerOptions(view.container)
    assert.match(options.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /short-drama-write/)
    await closeComposerOptions(view.container)
    panel = await openWorkflow()
    assert.match(panel.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /short-drama-develop/)
    assert.equal(view.requests.some(item => item.path.endsWith('/chat/stream')), false)
    const generate = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '生成故事大纲')!
    await act(() => generate.click())
    const request = view.requests.find(item => item.path.endsWith('/chat/stream'))!
    assert.equal(request.body.workflow.stage, 'outline')
    assert.deepEqual(request.body.workflow.artifact_types, [...scriptStageArtifacts.outline])
    assert.equal(request.body.document_action, undefined)
    assert.deepEqual(request.body.skill_selections, {})
  } finally { await view.destroy() }
})

test('director shares remembered text choices across projects and keeps a running request on its captured model', async t => {
  const alternate = { ...model, id: 'alternate-text', name: '另一文本模型' }
  let finish!: (response: Response) => void
  let calls = 0
  const response = () => new Response(`data: ${JSON.stringify({ type: 'done', reply: '已完成。', classification: { type: 'other' }, classification_version: replyClassificationVersion })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  const view = await mountAutomaticDirector(t, '请分析人物动机', detail, null, { models: [model, alternate],
    rememberedModel: alternate.id, legacyModel: model.id, chatResponse: () => ++calls === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(response()) })
  try {
    const field = () => view.container.querySelector<HTMLInputElement>('[aria-label="文本模型"]')!
    assert.equal(field().value, alternate.name, 'the global remembered choice takes precedence over the old project cache')
    await chooseCombobox(field(), model.name)
    assert.equal(rememberedModelId('text'), model.id)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    const request = view.requests.find(item => item.path.endsWith('/chat/stream'))!
    assert.equal(request.body.model_id, model.id)
    await act(() => rememberModelSelection('text', alternate.id))
    assert.equal(field().value, model.name, 'outside choices wait while a task is running')
    assert.equal(field().disabled, true)
    await act(async () => finish(response()))
    assert.equal(field().value, alternate.name)
    assert.equal(request.body.model_id, model.id)
  } finally { await view.destroy() }
  const other = { ...detail, id: 'another-project' }
  const reopened = await mountAutomaticDirector(t, '新的创作讨论', other, null, { models: [model, alternate], rememberedModel: alternate.id, legacyModel: model.id })
  try { assert.equal(reopened.container.querySelector<HTMLInputElement>('[aria-label="文本模型"]')!.value, alternate.name) }
  finally { await reopened.destroy() }
})
