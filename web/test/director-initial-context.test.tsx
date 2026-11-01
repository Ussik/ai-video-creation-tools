import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import { skillStageOptions, type SkillPolicy } from '../src/shared/api/skills-api'
import { directorStageContext } from '../src/features/script/script-workflow'
import { replyClassificationVersion } from '../src/features/script/script-reply'

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

async function mount(t: TestContext, initialContext: string, savedInput = '', savedReferences: unknown[] = [], savedMessages: unknown[] = [], chatResponse?: Promise<Response>) {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem(`script-director-input:${detail.id}`, savedInput)
  dom.window.localStorage.setItem(`script-director-references:${detail.id}`, JSON.stringify(savedReferences))
  if (chatResponse) dom.window.localStorage.setItem(`script-director-model:${detail.id}`, model.id)
  if (savedMessages.length) dom.window.localStorage.setItem(`script-director-conversations:${detail.id}`, JSON.stringify({ messages: savedMessages, history: [] }))
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (init?.method && init.method !== 'GET') writes.push(path)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream') && chatResponse) return chatResponse
    throw new Error(`Unexpected ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (context = initialContext) => { await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={detail} models={chatResponse ? [model] : []} providers={chatResponse ? [provider] : []} initialContext={context}
    onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>)) }
  await update()
  return { container, update, writes, async destroy() { await act(() => root.unmount()); container.remove() } }
}
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
const storedReferences = () => JSON.parse(dom.window.localStorage.getItem(`script-director-references:${detail.id}`) || '[]')

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

test('incoming context reveals the composer while preserving an unanswered director question', async t => {
  const question = { id: 'question', role: 'assistant', text: JSON.stringify({ kind: 'choices', question: '选择故事方向',
    interaction: { stage: directorStageContext(detail.script).stage, purpose: 'setting' },
    options: [{ id: 'a', text: '调查列车失踪' }, { id: 'b', text: '寻找车站旧人' }] }) }
  const view = await mount(t, '', '', [], [question])
  try {
    assert.ok(!composer(), 'the unanswered question initially occupies the composer')
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

async function mountAutomaticDirector(t: TestContext, input: string, project = detail) {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem(`script-director-input:${project.id}`, input)
  dom.window.localStorage.setItem(`script-director-model:${project.id}`, model.id)
  const requests: Array<{ path: string; body: any }> = []
  const policies: SkillPolicy[] = skillStageOptions.map(({ value: stage, label }) => ({ stage, label,
    primary_id: stage === 'script' ? 'write' : `${stage}-default`, auxiliary_ids: [], source: 'global', warning: '', skills: stage === 'script' ? [
      { id: 'write', name: 'short-drama-write', description: '剧本写作', revision: 'a'.repeat(40) },
      { id: 'develop', name: 'short-drama-develop', description: '系列开发', revision: 'a'.repeat(40) },
      { id: 'review', name: 'short-drama-review', description: '独立审查', revision: 'a'.repeat(40) },
    ] : [
      { id: `${stage}-default`, name: `default-${stage}`, description: '默认创作方法', revision: 'a'.repeat(40) },
      { id: 'review', name: 'short-drama-review', description: '独立审查', revision: 'a'.repeat(40) },
    ] }))
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.includes('/conversations/')) return Response.json({})
    if (path.endsWith('/chat/stream')) return new Response(`data: ${JSON.stringify({ type: 'done', reply: '本轮请求已完成。',
      classification: { type: 'other' }, classification_version: replyClassificationVersion })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={project} models={[model]} providers={[provider]}
    onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  return { container, requests, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('director leaves automatic skill selection to the model and sends only explicit manual overrides', async t => {
  const view = await mountAutomaticDirector(t, '规划故事大纲和分集地图')
  try {
    assert.match(view.container.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    assert.equal(view.requests.some(item => item.path.endsWith('/chat/stream')), false)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    let requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[0]?.body.skill_selections, {})
    await act(() => {
      const field = composer()
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '把第一集写成剧本正文')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.match(view.container.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    assert.equal(view.requests.filter(item => item.path.endsWith('/chat/stream')).length, 1, 'typing does not call a selection model')
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[1]?.body.skill_selections, {})
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="剧本创作技能选择"]')!.click())
    const skillInput = document.querySelector<HTMLInputElement>('input[aria-label="script主技能"]')!
    await act(() => skillInput.click())
    await act(() => document.querySelector<HTMLElement>('[role="option"][value="__base__"]')!.click())
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="剧本创作技能选择"]')!.click())
    await act(() => {
      const field = composer()
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '继续补充场景对白')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    requests = view.requests.filter(item => item.path.endsWith('/chat/stream'))
    assert.deepEqual(requests[2]?.body.skill_selections, { script: [] })
    assert.deepEqual(requests[0]?.body.skill_selections, {}, 'later manual selection cannot change the earlier request')
  } finally { await view.destroy() }
})

test('a direct document review passes its operation to the model without freezing any automatic skill', async t => {
  const doc = { id: 'auto-character-doc', project_id: detail.id, artifact_type: 'characters', episode_number: 0,
    title: '全剧人物设定', content: '林晚是记者，陈默是医生。', status: 'ready', position: 0 }
  const project = { ...detail, script: { ...detail.script, outline: '已保存故事大纲', characters: doc.content, artifacts: [doc] } } as unknown as ProjectDetail
  const view = await mountAutomaticDirector(t, '规划故事大纲和分集地图', project)
  try {
    assert.match(view.container.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="项目文档"]')!.click())
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

test('the explicit workflow panel retains model automatic mode and opening it makes no model request', async t => {
  const view = await mountAutomaticDirector(t, '把第一集写成剧本正文')
  try {
    assert.match(view.container.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    await act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="对话工具"]')!.click())
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '分阶段生成')
    assert.ok(menu)
    await act(() => menu.click())
    const panel = view.container.querySelector('[aria-label="分阶段生成面板"]')
    assert.ok(panel)
    assert.equal(panel.querySelector<HTMLInputElement>('[aria-label="创作阶段"]')!.value, '全剧故事大纲')
    assert.match(panel.querySelector('[aria-label="剧本创作技能选择"]')!.textContent!, /模型自动选择/)
    assert.equal(view.requests.filter(item => item.path.endsWith('/chat/stream')).length, 0, 'viewing a recommended workflow does not start generation')
  } finally { await view.destroy() }
})
