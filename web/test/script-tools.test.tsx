import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/api'
import { editedToolDraft, toolDraftArtifacts, toolDraftScenes, toolDraftStage, toolDraftOutcome, documentChangePreview, type ScriptToolDraft } from '../src/script-tools'
import { directorStageContext } from '../src/script-workflow'
import { activeReplyChoice, replyClassificationVersion } from '../src/script-reply'
import { directorStreamIdleTimeoutMs, directorStreamTotalTimeoutMs } from '../../backend/src/script-stream-policy'
import type { ScriptCreationState, CreationNextStep } from '../../backend/src/script-creation-state-types'
import { skillStageOptions } from '../src/skills-api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const doc = { id: 'character-doc', project_id: 'project-tools', artifact_type: 'characters' as const, episode_number: 0, title: '全剧人物设定', content: '# 林晚\n身份待定。\n# 陈默\n外科医生。', status: 'ready', position: 0 }
const detail = { id: 'project-tools', name: '对话工具测试', brief: '', ratio: '9:16', script: { outline: '大纲已保存', characters: doc.content, scenes: [], artifacts: [doc], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text-model', provider_id: 'provider', name: '文本模型', remote_id: 'test', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const provider = { id: 'provider', name: '提供商', enabled: true, adapter: 'http' } as Provider
const draft: ScriptToolDraft = { id: 'draft-1', version: 'version-1', kind: 'patch', summary: '补齐林晚职业', status: 'pending', documents: [{ ...doc, version: 'doc-version', original_content: doc.content, content: doc.content.replace('身份待定。', '调查记者。'), replacements: [{ find: '身份待定。', replace: '调查记者。', reason: '创作者确认' }] }] }
function revisionDraft(ready = false): ScriptToolDraft {
  return { ...draft, revision_task: { id: 'revision-task-1', summary: '补齐全剧待定设定', scope: 'all_documents', source_text: '全部由模型补齐', created_at: '2026-10-09', updated_at: '2026-10-09', status: ready ? 'ready' : 'in_progress', batches: 2,
    documents: [{ id: doc.id, title: doc.title, source_version: 'doc-version', status: ready ? 'verified' : 'revised', note: ready ? '设定一致' : '需要核对全文' }], references: [], decisions: [{ topic: '林晚职业', choice: '调查记者', reason: '推动调查主线' }] } }
}
const stream = (value: object) => new Response(`data: ${JSON.stringify({ type: 'done', ...value })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text); assert.ok(node, text); return node }
async function mount(projectDetail = detail) {
  const mockedFetch = globalThis.fetch
  const fixtureFetch: typeof fetch = async (...args) => String(args[0]).endsWith('/skills/defaults')
    ? Response.json({ policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) })
    : mockedFetch(...args)
  globalThis.fetch = fixtureFetch
  for (const key of ['script-director-conversations:project-tools', 'script-director-draft:project-tools', 'script-director-composer:project-tools']) dom.window.localStorage.removeItem(key)
  dom.window.localStorage.setItem('script-director-model:project-tools', model.id)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={projectDetail} models={[model]} providers={[provider]} onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove(); if (globalThis.fetch === fixtureFetch) globalThis.fetch = mockedFetch } }
}
function setInput(selector: string, value: string) { const field = document.querySelector<HTMLTextAreaElement>(selector)!; Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }
async function openDoc() { await act(() => button('对话工具').click()); await act(() => button('项目文档 · 2').click()); await act(() => button('阅读文档：全剧人物设定').click()) }

test('partial task restores progress and proposed decisions, resumes the same scope, then enables unified save', async t => {
  let pending: ScriptToolDraft | null = revisionDraft(), submitted: any, commits = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      submitted = body
      pending = { ...pending!, version: 'version-2', revision_task: { ...pending!.revision_task!, status: 'ready', documents: pending!.revision_task!.documents.map(item => ({ ...item, status: 'verified' })) } }
      return stream({ reply: '已核对有效草稿。', tool_draft: pending, classification: { type: 'other' }, classification_version: replyClassificationVersion })
    }
    if (path.endsWith('/commit')) { commits++; assert.equal(body.version, 'version-2'); const saved = { ...pending!, status: 'saved' }; pending = null; return Response.json(saved) }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    assert.equal(button('确认保存').disabled, true)
    assert.match(view.container.textContent!, /文档 0\/1/)
    assert.equal(button('查看修订进度').getAttribute('aria-expanded'), 'false')
    await act(() => button('查看修订进度').click())
    assert.match(view.container.textContent!, /拟定的统一设定/); assert.match(view.container.textContent!, /推动调查主线/)
    await act(() => button('继续统一修订').click())
    assert.equal(submitted.use_tools, true); assert.equal(submitted.document_action, undefined); assert.equal(submitted.workflow, undefined)
    assert.match(submitted.messages.at(-1).text, /revision-task-1/)
    assert.match(view.container.textContent!, /文档 1\/1/); assert.equal(button('确认保存').disabled, false)
    await act(async () => button('确认保存').click()); assert.equal(commits, 1); assert.match(view.container.textContent!, /已保存/)
  } finally { await view.destroy() }
})

test('manual changes to verified bulk draft update before/after preview, require recheck and sync before resume', async t => {
  let pending = revisionDraft(true), edited: any, submitted: any
  const order: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tool-drafts/draft-1') && init?.method === 'PUT') {
      order.push('sync'); edited = body
      pending = { ...pending, version: 'edited-version', documents: pending.documents.map(item => ({ ...item, content: body.documents[0].content })), revision_task: { ...pending.revision_task!, status: 'in_progress' } }
      return Response.json(pending)
    }
    if (path.endsWith('/chat/stream')) { order.push('resume'); submitted = body; return stream({ reply: '核对尚未完成。', tool_draft: pending, execution_outcome: { kind: 'partial', summary: '仍有未完成项，需要继续核对。', draft_id: pending.id, draft_version: pending.version }, classification_version: replyClassificationVersion, classification: { type: 'other' } }) }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    assert.equal(button('确认保存').disabled, false)
    await act(() => button('编辑').click())
    await act(() => setInput('textarea[aria-label="编辑草稿：全剧人物设定"]', '# 林晚\n独立调查记者。\n# 陈默\n外科医生。'))
    assert.equal(button('确认保存').disabled, true); assert.match(view.container.textContent!, /请继续任务核对当前版本/)
    assert.match(view.container.textContent!, /文档 0\/1/); assert.doesNotMatch(view.container.querySelector('.sd-revision-progress')!.textContent!, /统一核对完成/)
    const diff = view.container.querySelector('.sd-change-preview')!
    assert.match(diff.textContent!, /身份待定/); assert.match(diff.textContent!, /独立调查记者/)
    await act(async () => button('继续统一修订').click())
    assert.deepEqual(order, ['sync', 'resume']); assert.match(edited.documents[0].content, /独立调查记者/); assert.match(submitted.messages.at(-1).text, /revision-task-1/)
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /部分完成/)
    assert.match(view.container.querySelector('.sd-activity-result')!.textContent!, /仍有未完成项/)
  } finally { await view.destroy() }
})

test('current difference includes manual additions and bulk tasks never pretend to be a single-stage workflow', () => {
  assert.equal(toolDraftStage(revisionDraft()), undefined)
  assert.equal(toolDraftOutcome(revisionDraft()).kind, 'partial')
  assert.equal(toolDraftOutcome(revisionDraft(true)).kind, 'draft')
  assert.deepEqual(documentChangePreview('开头\n原文\n结尾', '开头\n当前修改\n结尾'), { changed: true, before: '原文', after: '当前修改' })
  assert.deepEqual(documentChangePreview('同文', '同文'), { changed: false, before: '', after: '' })
})

test('manual draft edits synchronize content and scenes; questions for saved stages remain selectable', () => {
  const artifacts = toolDraftArtifacts(draft); assert.equal(editedToolDraft(draft, artifacts, []).changed, false)
  artifacts[0].content += '\n手动补充'; assert.equal(editedToolDraft(draft, artifacts, []).changed, true); assert.equal(editedToolDraft(draft, artifacts, []).input.documents[0].content, artifacts[0].content)
  assert.equal(editedToolDraft(draft, [{ ...artifacts[0], content: '' }], []).input.documents[0].content, '', 'empty edits reach validation instead of silently saving the old text')
  const scene = { heading: '车站', location: '车站', time_of_day: '夜', characters: '林晚', action: '等待', dialogue: '别走', narration: '', duration: 8 }
  assert.equal(toolDraftScenes({ ...draft, scene_changes: [{ id: 'scene', version: 'sv', episode_number: 1, original: scene, scene: { ...scene, dialogue: '等等' } }] })[0].dialogue, '等等')
  const context = directorStageContext(detail.script, { pending: toolDraftStage(draft) }); assert.equal(context.stage, 'characters')
  const choice = activeReplyChoice([{ id: 'm', role: 'assistant', text: '', classification_version: replyClassificationVersion, classification_context: '[]', stage_context: context, classification: { type: 'choice_request', status: 'pending', interaction: { stage: 'characters', purpose: 'setting' }, question: '职业？', options: [{ id: 'a', title: '记者', text: '调查记者' }, { id: 'b', title: '律师', text: '律师' }] } }], {}, null, context)
  assert.equal(choice?.choice.options.length, 2)
})

test('native text without a classification still extracts and displays creator choices', async t => {
  let extracted = 0
  const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) { if (body) writes.push(body); return Response.json(body ? {} : { conversations: [] }) }
    if (path.endsWith('/chat/stream')) return stream({ reply: '你倾向记者调查，还是医生追查？', classification_version: replyClassificationVersion, stage_context: directorStageContext(detail.script) })
    if (path.endsWith('/replies/classify')) {
      extracted++
      return Response.json({ classification_version: replyClassificationVersion, messages: body.messages.map((source: any) => ({ id: source.id, classification: {
        type: 'choice_request', status: 'pending', interaction: { stage: source.stage_context.stage, purpose: 'setting' }, question: '选择故事切入方向',
        options: [{ id: 'a', title: '记者方向', text: '调查记者寻找线索' }, { id: 'b', title: '医生方向', text: '医生追查病历' }],
      } })) })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '帮我比较故事方向'))
    await act(async () => button('发送消息').click())
    assert.equal(extracted, 1)
    assert.match(view.container.textContent!, /记者方向/); assert.match(view.container.textContent!, /医生方向/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 410)) })
    assert.equal(writes.at(-1).messages.at(-1).reply_metadata.classification_source, 'model_extraction')
  } finally { await view.destroy() }
})

test('visual and storyboard resource edits synchronize before saving without changing IDs', async t => {
  let pending: ScriptToolDraft | null = { id: 'resource-1', version: 'resource-v1', kind: 'resource', status: 'pending', summary: '调整分镜运动', documents: [], resource_changes: [{
    type: 'shot', id: 'existing-shot', title: '雨夜车站', base_version: 'shot-v1', original: { title: '雨夜车站', prompt: '林晚进入车站', image_prompt: '林晚在门口', video_prompt: '林晚向前走', duration: 8, start_state: '', end_state: '', cut_note: '' },
    value: { title: '雨夜车站', prompt: '林晚进入车站', image_prompt: '林晚在门口', video_prompt: '缓慢跟随林晚', duration: 8, start_state: '', end_state: '', cut_note: '' },
  }] }
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body })
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tool-drafts/resource-1') && init?.method === 'PUT') {
      assert.deepEqual(Object.keys(body).sort(), ['documents', 'resource_values', 'version'])
      assert.deepEqual(body.documents, []); assert.equal(body.resource_values[0].index, 0)
      pending = { ...pending!, version: 'resource-v2', resource_changes: pending!.resource_changes!.map(change => ({ ...change, value: body.resource_values[0].value })) }
      return Response.json(pending)
    }
    if (path.endsWith('/commit')) { assert.equal(body.version, 'resource-v2'); assert.equal(body.approved, true); const saved = { ...pending!, status: 'saved' }; pending = null; return Response.json(saved) }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    assert.match(view.container.textContent!, /视觉设定与分镜草稿/)
    await act(() => button('编辑').click())
    await act(() => setInput('textarea[aria-label="视频动作与运镜提示词"]', '镜头从背后平稳跟拍林晚'))
    await act(async () => button('确认保存').click())
    const edit = requests.find(item => item.path.endsWith('/tool-drafts/resource-1') && item.body)!
    assert.equal(edit.body.resource_values[0].value.video_prompt, '镜头从背后平稳跟拍林晚')
    assert.equal(edit.body.resource_values[0].value.image_prompt, '林晚在门口')
    assert.match(view.container.textContent!, /已保存/)
    assert.equal(requests.filter(item => item.path.endsWith('/commit')).length, 1)
  } finally { await view.destroy() }
})

test('structured professional review and native provenance remain readable after history reload', async t => {
  const review = { id: 'review-1', created_at: new Date().toISOString(), summary: '人物动机需要补全', documents: [{ id: doc.id, version: 'doc-v1' }], findings: [{ document_id: doc.id, document_version: 'doc-v1', category: 'pending', severity: 'warning', quote: '身份待定。', explanation: '缺少调查权限来源', suggestion: '补齐记者职业和调查动机', related: [] }] }
  let saved: any
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) { if (body) saved = body; return Response.json({ conversations: [] }) }
    if (path.endsWith('/chat/stream')) return stream({ reply: '林晚职业需要补全。', classification_version: replyClassificationVersion, classification: { type: 'other' }, classification_source: 'application', review })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '请评审林晚人物设定'))
    await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-review-report')!.textContent!, /补齐记者职业/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 410)) })
    assert.deepEqual(saved.messages.at(-1).reply_metadata.review, review)
    assert.equal(saved.messages.at(-1).reply_metadata.classification_source, 'application')
    await view.destroy()
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
      if (path.endsWith('/conversations')) return Response.json(init?.method === 'PUT' ? {} : { conversations: [{ ...saved, messages: saved.messages.map((message: any) => ({ ...message, ...message.reply_metadata })) }] })
      throw new Error(`Unexpected reload request ${path}`)
    })
    const restored = await mount()
    try { assert.match(restored.container.querySelector('.sd-review-report')!.textContent!, /人物动机需要补全/); assert.match(restored.container.querySelector('.sd-review-report')!.textContent!, /身份待定/) }
    finally { await restored.destroy() }
  } finally { if (view.container.isConnected) await view.destroy() }
})

test('review sends only strict action fields and revision prefills editable instructions', async t => {
  const requests: Array<{ url: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ url: path, body })
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) return stream({ reply: '林晚职业仍待定，建议补齐调查动机。', classification_version: 8, classification: { type: 'other' } })
    if (path.includes('/conversations/')) return Response.json({})
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await openDoc(); await act(async () => button('模型评审').click())
    const request = requests.find(item => item.url.endsWith('/chat/stream'))!
    assert.equal(request.body.use_tools, true); assert.deepEqual(request.body.document_action, { operation: 'review', document_ids: ['character-doc'] }); assert.match(view.container.textContent!, /职业仍待定/)
    await openDoc(); await act(() => button('对话修订').click())
    assert.match(view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!.value, /我希望修改：/)
    assert.match(view.container.textContent!, /修订：全剧人物设定/)
  } finally { await view.destroy() }
})

test('server patch restores, compares original, syncs manual edits before dialogue and saves the current version', async t => {
  let pending: ScriptToolDraft | null = structuredClone(draft)
  const requests: Array<{ url: string; method: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined, method = init?.method || 'GET'; requests.push({ url: path, method, body })
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tool-drafts/draft-1') && method === 'PUT') { pending = { ...pending!, version: 'version-2', documents: pending!.documents.map(doc => ({ ...doc, content: body.documents[0].content })) }; return Response.json(pending) }
    if (path.endsWith('/chat/stream')) return stream({ reply: '已读取补充的采访经历。', classification_version: 8, classification: { type: 'other' }, tool_draft: pending,
      activity: [{ id: 'source', kind: 'tool', name: 'read_documents', status: 'succeeded', label: '阅读项目文档', summary: '已读取修改前文档', started_at: Date.now(), targets: [{ kind: 'document', id: doc.id, title: doc.title }] }] })
    if (path.endsWith('/commit')) { assert.equal(body.version, 'version-2'); assert.equal(body.approved, true); const saved = { ...pending!, status: 'saved' }; pending = null; return Response.json(saved) }
    if (path.includes('/conversations/')) return Response.json({})
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    assert.match(view.container.textContent!, /文档修订草稿/); assert.match(view.container.querySelector('.sd-original-document')!.textContent!, /身份待定/)
    await act(() => button('编辑').click()); const revised = draft.documents[0].content + '\n她曾采访过失踪案。'
    await act(() => setInput('textarea[aria-label="编辑草稿：全剧人物设定"]', revised)); await act(() => button('稍后处理').click())
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '看看补充的采访经历')); await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /草稿待确认/)
    assert.equal(view.container.querySelector('.sd-reply-actions button')?.textContent, '重新识别选项')
    await act(() => button('稍后处理').click())
    await act(() => button('查看并编辑草稿').click())
    assert.match(view.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /采访过失踪案/)
    await act(() => button('稍后处理').click())
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-toggle')!.click())
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-targets button')!.click())
    assert.match(view.container.querySelector('.sd-document-reader')!.textContent!, /身份待定/)
    assert.doesNotMatch(view.container.querySelector('.sd-document-reader')!.textContent!, /采访过失踪案/)
    await act(() => button('关闭文档阅读器').click())
    await act(() => button('查看并编辑草稿').click())
    const sync = requests.find(item => item.method === 'PUT' && item.url.endsWith('/tool-drafts/draft-1'))!, chat = requests.find(item => item.url.endsWith('/chat/stream'))!
    assert.equal(sync.body.documents[0].content, revised); assert.ok(requests.indexOf(sync) < requests.indexOf(chat))
    await act(async () => button('确认保存').click()); assert.match(view.container.textContent!, /已保存/); assert.equal(requests.filter(item => item.url.endsWith('/commit')).length, 1)
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /已保存/)
    assert.equal(button('查看保存结果').disabled, false)
  } finally { await view.destroy() }
})

test('read-only failed review retries the same question and document scope without appending the failed answer', async t => {
  const chats: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      chats.push(JSON.parse(String(init!.body)))
      if (chats.length === 1) return new Response(`data: ${JSON.stringify({ type: 'activity', activity: { id: 'read', kind: 'tool', status: 'succeeded', name: 'read_documents', label: '阅读项目文档', summary: '已读取人物设定', started_at: Date.now() } })}\n\ndata: {"type":"error","message":"模拟模型连接中断"}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      return stream({ reply: '评审完成，职业仍需确认。', classification_version: 8, classification: { type: 'other' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await openDoc(); await act(async () => button('模型评审').click())
    assert.match(view.container.querySelector('.sd-activity-scope')!.textContent!, /全剧人物设定/)
    await act(async () => button('重试本轮').click())
    assert.equal(chats.length, 2)
    assert.deepEqual(chats[1].document_action, chats[0].document_action)
    assert.deepEqual(chats[1].messages, chats[0].messages)
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /回复已完成/)
  } finally { await view.destroy() }
})

test('an interrupted write offers recovery and restores its exact saved draft without repeating the model request', async t => {
  let calls = 0, recoveries = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tool-drafts/draft-1')) {
      recoveries++
      // The first automatic check is temporarily unavailable; manual recovery works.
      if (recoveries === 1) return Response.json({ detail: '模拟刷新失败' }, { status: 503 })
      return Response.json({ ...draft, status: 'saved' })
    }
    if (path.endsWith('/chat/stream')) {
      calls++
      return new Response(`data: ${JSON.stringify({ type: 'activity', activity: { id: 'save', kind: 'tool', status: 'running', name: 'commit_document_draft', label: '确认并保存文档', summary: '正在保存', started_at: Date.now(), input: '{"draft_id":"draft-1","version":"version-1"}' } })}\n\ndata: {"type":"error","message":"模拟连接中断"}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '确认保存当前草稿'))
    await act(async () => button('发送消息').click())
    assert.equal([...view.container.querySelectorAll('button')].some(node => /重试本轮|重试生成|重新生成/.test(node.textContent || '')), false)
    await act(async () => button('检查草稿与保存结果').click())
    assert.equal(calls, 1); assert.equal(recoveries, 2)
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /已保存/)
    assert.ok(button('查看项目文档'))
    assert.equal([...view.container.querySelectorAll('button')].some(node => node.textContent === '确认保存'), false)
  } finally { await view.destroy() }
})

test('a failed discussion never claims a preexisting draft as its result or reopens its preview', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) return new Response('data: {"type":"error","message":"模拟讨论中断"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => button('稍后处理').click())
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '分析人物关系'))
    await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /未完成/)
    assert.equal(view.container.querySelector('[aria-label="剧本草稿预览"]'), null)
    assert.match(view.container.querySelector('.sd-activity-result')!.textContent!, /模拟讨论中断/)
  } finally { await view.destroy() }
})

test('discarding a returned draft updates the originating task and removes the editable draft action', async t => {
  let pending: ScriptToolDraft | null = null
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) { pending = draft; return stream({ reply: '草稿已准备。', tool_draft: pending, classification_version: 8, classification: { type: 'other' } }) }
    if (path.endsWith('/discard')) { pending = null; return Response.json({}) }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '补齐人物设定'))
    await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /草稿待确认/)
    await act(async () => button('放弃草稿').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /草稿已放弃/)
    assert.equal([...view.container.querySelectorAll('button')].some(node => node.textContent === '查看并编辑草稿'), false)
  } finally { await view.destroy() }
})

test('native completion synchronizes confirmed settings into the next dialogue request', async t => {
  const requests: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) { requests.push(JSON.parse(String(init!.body))); return stream({ reply: '已确认全剧5集，每集60秒。', generation_options: { episode_count: 5, episode_duration: 60 }, classification_version: 8, classification: { type: 'other' } }) }
    if (path.includes('/conversations/')) return Response.json({})
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '全剧5集，每集60秒'))
    await act(async () => button('发送消息').click())
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '继续讨论故事方向'))
    await act(async () => button('发送消息').click())
    assert.equal(requests[1].generation_options.episode_count, 5); assert.equal(requests[1].generation_options.episode_duration, 60)
  } finally { await view.destroy() }
})

test('a lost stream after a save recovers the actual saved draft status instead of offering another save', async t => {
  let saved = false, recovered = false
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: saved ? null : draft, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) { saved = true; return new Response('data: {"type":"progress","text":"正在保存文档…"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
    if (path.endsWith('/tool-drafts/draft-1')) { recovered = true; return Response.json({ ...draft, status: 'saved' }) }
    if (path.includes('/conversations/')) return Response.json({})
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => button('稍后处理').click())
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '确认保存当前草稿'))
    await act(async () => button('发送消息').click())
    assert.equal(recovered, true)
    assert.equal([...view.container.querySelectorAll('button')].some(item => item.textContent === '确认写入项目剧本'), false)
  } finally { await view.destroy() }
})

test('execution UI updates live calls, preserves repeated invocations and persists expandable details with history', async t => {
  let channel: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder(), requests: Array<{ path: string; body: any }> = []
  const read = { id: 'read-0', kind: 'tool' as const, status: 'running' as const, name: 'read_documents', label: '阅读项目文档', summary: '正在读取人物原文', started_at: Date.now(), round: 1, input: '{"document_ids":["character-doc"]}' }
  const skill = { ...read, id: 'skill', kind: 'skill', status: 'succeeded', name: 'character-consistency', label: '人物一致性', summary: '已加载规则', revision: 'abc123456789', files: ['SKILL.md', 'references/character.md'], input: undefined, duration_ms: 0 }
  const complete = { ...read, status: 'succeeded', summary: '人物原文读取完成', duration_ms: 123, output: '{"content":"林晚是记者"}', targets: [{ kind: 'document', id: doc.id, title: doc.title }] }
  const activity = [skill, ...Array.from({ length: 9 }, (_, index) => ({ ...complete, id: `read-${index}` }))]
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body })
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json(init?.method === 'PUT' ? {} : { conversations: [] })
    if (path.endsWith('/chat/stream')) return new Response(new ReadableStream({ start(controller) { channel = controller; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'activity', activity: skill })}\n\ndata: ${JSON.stringify({ type: 'activity', activity: read })}\n\n`)) } }), { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '阅读人物资料'))
    await act(async () => button('发送消息').click())
    const section = view.container.querySelector('.sd-activity')!
    assert.equal(section.querySelector('.sd-activity-toggle')!.getAttribute('aria-expanded'), 'false')
    assert.match(section.querySelector('.sd-activity-current')!.textContent!, /阅读项目文档.*正在读取人物原文/)
    assert.match(section.textContent!, /处理中/)
    assert.equal(view.container.querySelector('.script-director-bubble.is-pending'), null)
    await act(async () => {
      for (const item of activity) channel!.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'activity', activity: item })}\n\n`))
      channel!.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', activity, reply: '林晚职业已明确。', classification_version: 8, classification: { type: 'other' } })}\n\n`)); channel!.close()
    })
    assert.equal(section.querySelector('button')!.getAttribute('aria-expanded'), 'false')
    assert.match(section.textContent!, /查阅 1 份文档 · 1 个 Skill 已加载/)
    await act(() => section.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(section.querySelectorAll('.is-tool').length, 9)
    const technical = section.querySelector<HTMLDetailsElement>('.sd-activity-technical')!
    assert.equal(technical.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'false')
    await act(() => technical.querySelector<HTMLElement>('.workspace-disclosure-control')!.click())
    const readDetail = technical.querySelectorAll<HTMLDetailsElement>('.sd-activity-detail')[1]
    await act(() => readDetail.querySelector<HTMLElement>('.workspace-disclosure-control')!.click())
    assert.equal(readDetail.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'true')
    assert.match(readDetail.textContent!, /read_documents/); assert.match(readDetail.textContent!, /document_ids/); assert.match(readDetail.textContent!, /林晚是记者/)
    assert.match(section.textContent!, /references\/character.md/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 410)) })
    const saved = requests.filter(item => item.path.endsWith('/conversations') && item.body).at(-1)!.body
    assert.equal(saved.messages.at(-1).activity.length, 10)
    assert.equal(saved.messages.at(-1).activity[1].status, 'succeeded')
    assert.equal(saved.messages.at(-1).reply_metadata.execution.request, '阅读人物资料')
    assert.equal(saved.messages.at(-1).reply_metadata.execution.outcome.kind, 'reply')
    const chat = requests.find(item => item.path.endsWith('/chat/stream'))!.body
    assert.ok(chat.messages.every((message: any) => !message.activity), 'trace does not inflate the model conversation or become instructions')
    await view.destroy()
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
      if (String(url).endsWith('/conversations')) return Response.json(init?.method === 'PUT' ? {} : { conversations: [saved] })
      throw new Error(`Unexpected reload request ${url}`)
    })
    const restored = await mount()
    try {
      assert.match(restored.container.querySelector('.sd-activity')!.textContent!, /查阅 1 份文档 · 1 个 Skill 已加载/)
      await act(() => restored.container.querySelector<HTMLButtonElement>('.sd-activity-toggle')!.click())
      assert.equal(restored.container.querySelectorAll('.sd-activity-step.is-tool').length, 9)
      await act(() => restored.container.querySelector<HTMLButtonElement>('.sd-activity-targets button')!.click())
      assert.match(restored.container.querySelector('.sd-document-reader')!.textContent!, /全剧人物设定.*身份待定/s)
    } finally { await restored.destroy() }
  } finally { if (view.container.isConnected) await view.destroy() }
})

test('stopping a streamed operation settles its trace without turning completed steps into failures', async t => {
  const encoder = new TextEncoder()
  const activity = { id: 'model-active', kind: 'model', status: 'running', label: '模型处理请求', summary: '正在处理', started_at: Date.now() - 46_000 }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'activity', activity })}\n\n`))
      init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')))
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '讨论故事'))
    await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-activity')!.textContent!, /处理中/)
    assert.match(view.container.querySelector('.sd-activity-wait')!.textContent!, /尚未返回结果/)
    await act(async () => button('停止等待').click())
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-toggle')!.click())
    assert.match(view.container.querySelector('.sd-activity')!.textContent!, /已停止/)
    assert.ok(!view.container.querySelector('.sd-activity-icon.is-running'))
  } finally { await view.destroy() }
})

test('a completed document draft opens its preview immediately even if the server leaves the stream open', async t => {
  let cancelled = false, calls = 0
  const result = { type: 'done', reply: '人物设定草稿已准备。', classification_version: 8, classification: { type: 'other' },
    draft: { stage: 'characters', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'characters', title: '全剧人物设定', content: '# 林晚\n调查记者，追踪失踪案件。' }], scenes: [] } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/director/draft')) return Response.json({ ...detail.script, artifacts: [{ ...doc, content: '林晚：调查记者。' }] })
    if (path.endsWith('/chat/stream')) {
      calls++
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(result)}\n\n`)) },
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '继续创作'))
    await act(async () => button('发送消息').click())
    assert.equal(cancelled, true); assert.equal(calls, 1)
    assert.match(view.container.textContent!, /人物设定草稿已准备/)
    assert.match(view.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /调查记者，追踪失踪案件/)
    assert.ok(button('确认保存'))
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /草稿待确认/)
    await act(async () => button('确认保存').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /已保存/)
    assert.equal(view.container.querySelector('button[aria-label="停止生成"]'), null)
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '继续讨论'))
    assert.equal(button('发送消息').disabled, false)
  } finally { await view.destroy() }
})

test('a skipped question becomes a completed historical task while keeping the skip button wording', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      calls++
      return calls === 1 ? stream({ reply: '你想采用哪个职业？', stage_context: directorStageContext(detail.script, { explicit: { stage: 'characters', episode_number: 0 } }), classification_version: replyClassificationVersion, classification_source: 'function_call', classification: {
        type: 'choice_request', status: 'pending', interaction: { stage: 'characters', purpose: 'setting' }, question: '选择林晚职业', options: [{ id: 'a', title: '记者', text: '调查记者' }, { id: 'b', title: '医生', text: '外科医生' }],
      } }) : stream({ reply: '我选择调查记者，后续沿用这个设定。', classification_version: replyClassificationVersion, classification: { type: 'other' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '讨论林晚职业'))
    await act(async () => button('发送消息').click())
    assert.match(view.container.querySelector('.sd-activity-state')!.textContent!, /待你回答/)
    await act(async () => button('跳过').click())
    assert.equal(calls, 2)
    assert.match(view.container.querySelector('.sd-activity-result')!.textContent!, /已跳过，交由模型决定/)
    assert.equal([...view.container.querySelectorAll('.sd-activity-state')].some(node => node.textContent === '待你回答'), false)
  } finally { await view.destroy() }
})

test('a stalled connection exits pending state, preserves received text and fails only the unfinished steps', async t => {
  let cancelled = false, calls = 0
  const modelStep = { id: 'model-wait', kind: 'model', status: 'running', label: '模型处理请求', summary: '正在处理', started_at: Date.now() }
  const skill = { id: 'skill-ok', kind: 'skill', status: 'succeeded', label: '人物一致性', summary: '规则已加载', started_at: Date.now(), duration_ms: 0 }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      calls++
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode([ { type: 'activity', activity: skill }, { type: 'activity', activity: modelStep }, { type: 'delta', text: '已收到的人物分析内容。' } ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))) },
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '分析人物'))
    await act(async () => button('发送消息').click())
    assert.ok(button('停止生成'))
    await act(async () => { t.mock.timers.tick(directorStreamIdleTimeoutMs - 1) })
    assert.ok(button('停止生成'))
    await act(async () => { t.mock.timers.tick(1) })
    assert.equal(cancelled, true); assert.equal(calls, 1, 'timeout must not retry a request that may have written a draft')
    assert.equal(view.container.querySelector('button[aria-label="停止生成"]'), null)
    assert.match(view.container.textContent!, /已收到的人物分析内容/)
    assert.match(view.container.textContent!, /180 秒未收到服务响应/)
    await act(() => view.container.querySelector<HTMLButtonElement>('.sd-activity-toggle')!.click())
    assert.match(view.container.querySelector('.sd-activity-step.is-model')!.textContent!, /未完成/)
    assert.match(view.container.querySelector('.sd-activity-step.is-skill')!.textContent!, /规则已加载/)
    assert.ok(!view.container.querySelector('.sd-activity-icon.is-running'))
    assert.equal(button('发送消息').disabled, false)
  } finally { await view.destroy() }
})

test('server heartbeats keep slow work pending but the complete dialogue still has a deadline', async t => {
  let channel!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, calls = 0
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      calls++
      return new Response(new ReadableStream({ start(controller) { channel = controller }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '编写阶段草稿'))
    await act(async () => button('发送消息').click())
    for (let elapsed = 30_000; elapsed < directorStreamTotalTimeoutMs; elapsed += 30_000) {
      await act(async () => { t.mock.timers.tick(30_000); channel.enqueue(encoder.encode('data: {"type":"heartbeat"}\n\n')) })
      assert.ok(button('停止生成'))
    }
    assert.doesNotMatch(view.container.textContent!, /heartbeat|连接已中断/)
    await act(async () => { t.mock.timers.tick(30_000) })
    assert.equal(cancelled, true); assert.equal(calls, 1)
    assert.equal(view.container.querySelector('button[aria-label="停止生成"]'), null)
    assert.match(view.container.textContent!, /本轮对话处理超时/)
    assert.match(view.container.textContent!, /30 分钟/)
    assert.doesNotMatch(view.container.textContent!, /已停止生成/)
  } finally { await view.destroy() }
})


const emptyProject = { ...detail, script: { ...detail.script, outline: '', characters: '', artifacts: [], scenes: [], generation_options: {} } } as ProjectDetail
function stateFor(project: ProjectDetail, next_step: CreationNextStep | null = null, status: ScriptCreationState['status'] = next_step ? 'ready' : 'direction'): ScriptCreationState {
  return { version: 'state-version', status, next_step, stage_context: directorStageContext(project.script), saved_episodes: [] }
}
const outlineStep: CreationNextStep = { id: 'ready-outline', stage: 'outline', episode_number: 0, purpose: 'generate', summary: '主线已明确，可以整理大纲。', basis: '林晚调查怪谈，创作者授权补齐细节。', document_ids: [], source: 'model' }

test('initial direction discussion leads to one native outline action, then saving advances to characters', async t => {
  let creation = stateFor(emptyProject), pending: ScriptToolDraft | null = null, chatCalls = 0
  const requests: any[] = []
  const created: ScriptToolDraft = { id: 'outline-draft', version: 'outline-v1', kind: 'create', summary: '全剧大纲草稿', status: 'pending', workflow: { stage: 'outline', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'outline', title: '全剧大纲', content: '林晚调查城市怪谈。' }], scenes: [] }, documents: [{ id: 'outline:0', artifact_type: 'outline', episode_number: 0, title: '全剧大纲', content: '林晚调查城市怪谈。', version: '', original_content: '', replacements: [] }] }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/tools-state')) return Response.json({ draft: pending, decisions: [], creation })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) {
      requests.push(body); chatCalls++
      if (chatCalls === 1) return stream({ reply: JSON.stringify({ kind: 'choices', question: '怪谈的代价是什么？', interaction: { stage: 'outline', purpose: 'setting' }, options: [{ id: 'memory', title: '失去记忆', text: '每次使用力量失去一段记忆。' }, { id: 'life', title: '消耗寿命', text: '每次使用力量消耗寿命。' }] }), classification_version: replyClassificationVersion, classification: { type: 'choice_request', status: 'pending', question: '怪谈的代价是什么？', interaction: { stage: 'outline', purpose: 'setting' }, options: [{ id: 'memory', title: '失去记忆', text: '每次使用力量失去一段记忆。' }, { id: 'life', title: '消耗寿命', text: '每次使用力量消耗寿命。' }] }, creation })
      if (chatCalls === 2) { creation = stateFor(emptyProject, outlineStep); return stream({ reply: outlineStep.summary, classification_version: replyClassificationVersion, classification: { type: 'other' }, creation }) }
      pending = created; creation = stateFor(emptyProject, null, 'review')
      return stream({ reply: '大纲草稿已准备，请检查后保存。', tool_draft: pending, classification_version: replyClassificationVersion, classification: { type: 'other' }, creation })
    }
    if (path.endsWith('/commit')) {
      assert.equal(body.approved, true); assert.equal(body.version, 'outline-v1')
      const saved = { ...created, status: 'saved' }; pending = null
      creation = stateFor(emptyProject, { ...outlineStep, id: 'ready-characters', stage: 'characters', summary: '大纲已保存', source: 'progress' })
      return Response.json(saved)
    }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount(emptyProject)
  try {
    assert.ok(button('探索故事方向'))
    assert.equal([...view.container.querySelectorAll('button')].filter(item => item.textContent === '生成全剧大纲').length, 0)
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '林晚调查城市怪谈，帮我确定故事方向。'))
    await act(async () => button('发送消息').click())
    assert.ok(view.container.querySelector('[aria-label="当前待回答问题"]'))
    assert.equal(view.container.querySelector('.sd-creation-actions button'), null)
    await act(async () => button('跳过').click())
    assert.equal(requests[1].question_response.status, 'skipped'); assert.equal(requests[1].use_tools, true)
    assert.equal(view.container.querySelectorAll('.sd-creation-actions button').length, 1)
    await act(async () => button('生成全剧故事大纲').click())
    assert.equal(requests[2].use_tools, true); assert.equal(requests[2].next_step_id, outlineStep.id)
    assert.deepEqual(requests[2].workflow, { stage: 'outline', scope: 'project', episode_number: 0 })
    assert.match(view.container.querySelector('[aria-label="剧本草稿预览"]')!.textContent!, /林晚调查城市怪谈/)
    assert.equal(view.container.querySelector('.sd-creation-actions'), null)
    await act(async () => button('确认保存').click())
    assert.ok(button('生成全剧人物设定'))
    assert.equal(view.container.querySelectorAll('.sd-creation-actions button').length, 1)
    assert.equal([...view.container.querySelectorAll('button')].some(item => item.textContent === '探索故事方向' || item.textContent === '更新全剧大纲'), false)
  } finally { await view.destroy() }
})

test('historical workflow text does not recreate an unvalidated or duplicate generate button', async t => {
  const context = directorStageContext(emptyProject.script)
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [], creation: stateFor(emptyProject) })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [{ id: 'old', label: '旧对话', messages: [{ id: 'user', role: 'user', text: '我想聊聊方向' }, { id: 'old-action', role: 'assistant', text: JSON.stringify({ kind: 'workflow_action', interaction: { stage: 'outline', purpose: 'generate' }, intro: '可以生成大纲' }), stage_context: context, classification_version: replyClassificationVersion, classification: { type: 'workflow_action', interaction: { stage: 'outline', purpose: 'generate' } } }] }] })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount(emptyProject)
  try {
    assert.equal(view.container.querySelector('.sd-creation-actions button'), null)
    assert.equal(view.container.querySelector('[aria-label="当前阶段创作操作"]'), null)
    assert.doesNotMatch(view.container.textContent!, /正在确定故事方向/)
    assert.equal(view.container.querySelector('.sd-creation-progress'), null)
  } finally { await view.destroy() }
})

test('stale next-step response clears the button and never reissues generation automatically', async t => {
  let invalidated = false, calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [], creation: stateFor(emptyProject, invalidated ? null : outlineStep) })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) { calls++; invalidated = true; return Response.json({ message: '创作进度或设定已变化，请查看当前步骤后重新操作' }, { status: 409 }) }
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount(emptyProject)
  try {
    await act(async () => button('生成全剧故事大纲').click())
    assert.equal(calls, 1)
    assert.equal([...view.container.querySelectorAll('button')].some(item => item.textContent === '生成全剧故事大纲'), false)
    assert.match(view.container.textContent!, /创作进度或设定已变化/)
  } finally { await view.destroy() }
})

test('a saved first episode exposes storyboard handoff while later episodes remain unwritten', async t => {
  const episodeProject = { ...detail, script: { ...detail.script, artifacts: [doc, { ...doc, id: 'locations', artifact_type: 'locations', content: '车站' }, { ...doc, id: 'props', artifact_type: 'props', content: '怀表' }, { ...doc, id: 'episode-1', artifact_type: 'episode_script', episode_number: 1, title: '第1集正文' }], scenes: [{ id: 'scene-1', project_id: detail.id, episode_number: 1, heading: '车站', duration: 8 }], generation_options: { episode_count: 3 } } } as unknown as ProjectDetail
  const next = { ...outlineStep, id: 'episode-2', stage: 'episode' as const, episode_number: 2, source: 'progress' as const }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [], creation: stateFor(episodeProject, next) })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount(episodeProject)
  try {
    assert.ok(button('生成第 2 集正文'))
    assert.ok(view.container.querySelector('[aria-label="故事板制作"]'))
    assert.equal(button('加入画布').disabled, false)
    assert.equal(view.container.querySelector<HTMLInputElement>('[aria-label="选择制作分镜的集数"]')!.value, '第 1 集')
  } finally { await view.destroy() }
})

test('a delayed initial state cannot overwrite a newer native proposal', async t => {
  let releaseInitial!: (response: Response) => void, stateCalls = 0
  const initial = new Promise<Response>(resolve => { releaseInitial = resolve })
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/tools-state')) return ++stateCalls === 1 ? initial : Response.json({ draft: null, decisions: [], creation: stateFor(emptyProject, outlineStep) })
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/chat/stream')) return stream({ reply: outlineStep.summary, classification_version: replyClassificationVersion, classification: { type: 'other' }, creation: stateFor(emptyProject, outlineStep) })
    if (path.includes('/conversations/')) return Response.json({})
    throw new Error(`Unexpected request ${path}`)
  })
  const view = await mount(emptyProject)
  try {
    await act(() => setInput('textarea[aria-label="剧本创作对话"]', '林晚调查怪谈，其他细节你来定。'))
    await act(async () => button('发送消息').click())
    assert.ok(button('生成全剧故事大纲'))
    await act(async () => releaseInitial(Response.json({ draft: null, decisions: [], creation: stateFor(emptyProject) })))
    assert.ok(button('生成全剧故事大纲'))
    assert.equal(view.container.querySelectorAll('.sd-creation-actions button').length, 1)
  } finally { await view.destroy() }
})

test('settings option Escape retains the dialog and draft; cancelling never saves project settings', async t => {
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (init?.method && init.method !== 'GET') writes.push(path)
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    return Response.json({})
  })
  const view = await mount()
  const escape = async (node: HTMLElement) => act(() => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  try {
    await act(() => button('剧本设定').click())
    const dialog = document.querySelector('.script-director-settings-modal')!
    assert.ok(dialog)
    const audience = [...document.querySelectorAll<HTMLButtonElement>('.script-director-auto-card')].find(node => node.textContent?.includes('目标受众'))!
    await act(() => audience.click())
    await act(() => button('男频').click())
    await escape(document.querySelector<HTMLElement>('.script-director-auto-popover input')!)
    assert.equal(document.querySelector('.script-director-settings-modal'), dialog)
    assert.equal(document.querySelector('.script-director-auto-popover'), null)
    assert.match(audience.textContent!, /男频/)
    await act(() => document.querySelector<HTMLButtonElement>('.script-director-structure-card')!.click())
    await escape(document.querySelector<HTMLElement>('[role="slider"][aria-label="预计集数"]')!)
    assert.equal(document.querySelector('.script-director-settings-modal'), dialog)
    assert.equal(document.querySelector('.script-director-structure-popover'), null)
    await act(() => button('取消').click())
    assert.equal(document.querySelector('.script-director-settings-modal'), null)
    assert.equal(writes.filter(path => path.endsWith('/script') || path.includes('/canvas')).length, 0)
    await act(() => button('剧本设定').click())
    assert.match(document.querySelector('.script-director-auto-card')!.textContent!, /自动/)
  } finally { await view.destroy() }
})
