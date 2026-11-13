import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, type ComponentProps } from 'react'
import type { Editor } from '@tiptap/core'
import { MantineProvider } from '@mantine/core'
import type { Model } from '../src/shared/api/api'
import { parsePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { skillStageOptions } from '../src/shared/api/skills-api'
import { SKILLS_LIBRARY_CHANGED } from '../src/features/skills/skills-library-events'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const rect = { left: 10, top: 10, right: 11, bottom: 30, width: 1, height: 20, x: 10, y: 10, toJSON: () => ({}) }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => rect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [rect] })
const { createRoot } = await import('react-dom/client')
const { default: PromptSkillAction } = await import('../src/features/skills/PromptSkillAction')
const { rememberModelSelection, rememberedModelId } = await import('../src/features/models/model-selection-store')
type Props = ComponentProps<typeof PromptSkillAction>
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())

const models = [{ id: 'text', name: '文本模型', modality: 'text', enabled: true, provider_id: 'provider', protocol: 'chat_completions', settings: {} }] as Model[]
const style = '【项目画风约束】\n创作者当前画风\n【项目画风约束结束】'
const output = '【图片生成要求】\n保持原始输出与暗部材质\n【图片生成要求结束】'
const sourcePrompt = `原始主要创作内容\n\n${style}\n\n${output}`
const originalFetch = globalThis.fetch

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
function editable(label: string) {
  const found = document.querySelector<HTMLElement>(`[contenteditable][aria-label="${label}"]`) as (HTMLElement & { editor: Editor }) | null
  assert.ok(found?.editor, label); return found
}
async function edit(label: string, value: string) {
  const field = editable(label)
  await act(() => field.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: value ? [{ type: 'text', text: value }] : [] }] }, { emitUpdate: true }))
}
const policies = (revision = 'a') => skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '',
  skills: [{ id: `${stage}-skill`, name: '创作技能', description: '创作方法', revision }] }))
async function mount(extra: Partial<Props> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), applied: Array<{ prompt: string; body?: string; document?: PromptSectionDocument }> = []
  let props: Props = { projectId: 'project', nodeId: 'node', modality: 'image', prompt: sourcePrompt, promptDocument: true,
    models, disabled: false, targetModelId: 'image-model', shotId: null, ratio: '16:9', duration: 5, mode: 'generate', referenceAssetIds: [],
    onApply: (prompt, body, document) => applied.push({ prompt, body, document }), ...extra }
  const render = async (patch: Partial<Props> = {}) => { props = { ...props, ...patch }; await act(() => root.render(<MantineProvider env="test"><PromptSkillAction {...props} /></MantineProvider>)) }
  await render()
  return { applied, render, async close() { globalThis.fetch = originalFetch; await act(() => root.unmount()); container.remove() } }
}

test('modal refinement previews and edits only main prose, then restores current requirements instead of response context', async () => {
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: policies() })
    assert.ok(String(url).endsWith('/skills/refine-prompt'))
    requests.push(JSON.parse(String(options?.body)))
    return Response.json({ prompt: '整理后的主内容\n\n【项目画风约束】\n模型企图替换画风\n【项目画风约束结束】', skills: [] })
  }
  const sections = parsePromptSectionDocument(sourcePrompt)
  sections.blocks.find(block => block.name === '项目画风约束')!.sourceText = style
  const view = await mount({ promptSections: sections })
  try {
    await act(() => button('使用技能整理提示词').click())
    assert.ok(document.querySelector('[role="dialog"]'), 'refinement opens an independent modal')
    assert.equal(requests.length, 0, 'opening does not call a model')
    assert.match(document.body.textContent!, /润色正文表达，保留既定事实和展示要求/)
    await act(async () => button('生成整理草稿').click())
    assert.equal(requests[0].prompt, sourcePrompt)
    assert.equal(editable('整理后的主要内容').textContent, '整理后的主内容')
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="整理前的主要内容"]')!.value, '原始主要创作内容')
    assert.doesNotMatch(editable('整理后的主要内容').textContent!, /模型企图替换|项目画风/)
    await edit('整理后的主要内容', '人工修改后的主要内容')
    await act(() => button('应用正文').click())
    assert.equal(requests.length, 1)
    assert.equal(view.applied[0].body, '人工修改后的主要内容')
    assert.deepEqual(view.applied[0].document!.blocks.filter(block => block.kind === 'managed'), sections.blocks.filter(block => block.kind === 'managed'))
    assert.doesNotMatch(view.applied[0].prompt, /模型企图替换/)
  } finally { await view.close() }
})

test('setting board candidate can revise definition, views and layout while merging supplements and retaining tombstones', async () => {
  const primary = '【设定图固定要求】\n原有对象定义、四视图与版式。\n【设定图固定要求结束】'
  const prompt = `${primary}\n\n细节图不要遮挡主视图。\n\n${style}\n\n${output}`
  const document = parsePromptSectionDocument(prompt)
  document.blocks.push({ id: 'removed-reference', kind: 'managed', name: '生成参考图', text: '', sourceText: '【生成参考图】旧参考【生成参考图结束】', deleted: true })
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : Response.json({ prompt: '【设定图固定要求】\n整理后的对象定义、四视图与版式，保留补充要求。\n【设定图固定要求结束】\n\n【项目画风约束】\n模型的另一画风\n【项目画风约束结束】', skills: [] })
  const view = await mount({ visualBoard: true, prompt, promptSections: document })
  try {
    await act(() => button('使用技能整理提示词').click())
    assert.match(documentBody(), /保留既定事实和展示要求/)
    await act(async () => button('生成整理草稿').click())
    const before = window.document.querySelector<HTMLTextAreaElement>('[aria-label="整理前的主要内容"]')!.value
    assert.match(before, /原有对象定义/); assert.match(before, /细节图不要遮挡/)
    assert.equal(editable('整理后的主要内容').textContent, '整理后的对象定义、四视图与版式，保留补充要求。')
    await act(() => button('应用正文').click())
    assert.match(view.applied[0].prompt, /【设定图固定要求】\n整理后的对象定义、四视图与版式，保留补充要求。/)
    assert.equal(view.applied[0].body!.trim(), '')
    assert.deepEqual(view.applied[0].document!.blocks.filter(block => block.kind === 'managed' && block.name !== '设定图固定要求'), document.blocks.filter(block => block.kind === 'managed' && block.name !== '设定图固定要求'))
  } finally { await view.close() }
})
const documentBody = () => document.body.textContent || ''

test('applying a numbered candidate binds only editable prose and leaves requirement text, sources and tombstones literal', async () => {
  const protectedStyle = '【项目画风约束】\n图1保持当前画风，图片1和图2是原文说明。\n【项目画风约束结束】'
  const prompt = `原有主体。\n\n${protectedStyle}\n\n${output}`
  const sections = parsePromptSectionDocument(prompt)
  const block = sections.blocks.find(item => item.name === '项目画风约束')!
  block.id = 'literal-style'
  block.sourceText = '【项目画风约束】来源图片1沿用图2【项目画风约束结束】'
  sections.blocks.push({ id: 'removed-literal-reference', kind: 'managed', name: '生成参考图', text: '', sourceText: '来源图1与图片2', deleted: true })
  const original = structuredClone(sections)
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : Response.json({ prompt: `候选主体参考图1。\n\n${protectedStyle}`, skills: [] })
  const view = await mount({ prompt, promptSections: sections, referenceAssetIds: ['hero', 'station'] })
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    await edit('整理后的主要内容', '人工修改：主体取图片1，背景取图2。')
    await act(() => button('应用正文').click())
    assert.equal(view.applied[0].body, '人工修改：主体取[[ref:hero]]，背景取[[ref:station]]。')
    assert.ok(view.applied[0].prompt.includes(protectedStyle))
    assert.deepEqual(view.applied[0].document!.blocks.filter(item => item.kind === 'managed'), original.blocks.filter(item => item.kind === 'managed'))
    assert.deepEqual(sections, original, 'the source document remains immutable')
  } finally { await view.close() }
})

test('source, model configuration, skill revisions and adjustment changes each invalidate old candidates', async () => {
  let revision = 'a'
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: policies(revision).map(policy => ({ ...policy, primary_id: `${policy.stage}-skill` })) })
    requests.push(JSON.parse(String(options?.body)))
    return Response.json({ prompt: '候选主内容', skills: [] })
  }
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    assert.equal(button('应用正文').disabled, false)
    await view.render({ ratio: '9:16' })
    assert.equal(button('应用正文').disabled, true)
    await act(() => button('重新整理').click())
    await act(async () => button('重新整理').click())
    assert.equal(requests.at(-1)!.ratio, '9:16')
    assert.equal(requests.at(-1)!.prompt, sourcePrompt, 'node changes start from current document rather than old candidate')
    assert.equal(button('应用正文').disabled, false)
    await view.render({ models: [{ ...models[0], name: '更新了配置的同一文本模型' }] })
    assert.equal(button('应用正文').disabled, true)
    await act(() => button('继续调整').click())
    await act(async () => button('继续整理').click())
    assert.equal(button('应用正文').disabled, false)
    revision = 'b'
    await act(async () => { window.dispatchEvent(new Event(SKILLS_LIBRARY_CHANGED)) })
    assert.equal(button('应用正文').disabled, true, 'same skill ids with a new library revision are stale')
    await act(() => button('继续调整').click())
    await act(async () => button('继续整理').click())
    await act(() => button('继续调整').click())
    await edit('本次调整要求', '精简描述，保留主体身份。')
    assert.match(documentBody(), /调整要求已变化/)
    assert.equal(document.querySelector('.prompt-skill-result'), null, 'continue shows an adjustment form rather than stacking it with results')
    await act(() => button('返回对照').click())
    assert.equal(button('应用正文').disabled, false, 'returning discards unapplied adjustment instructions')
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})

test('shared text choices wait for refinement, preserve the returned candidate and prevent applying it with a changed model', async () => {
  const alternate = { ...models[0], id: 'alternate-text', name: '另一文本模型' }
  const requests: Array<Record<string, unknown>> = []
  let finish!: (response: Response) => void
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: policies() })
    requests.push(JSON.parse(String(options?.body)))
    return new Promise(resolve => { finish = resolve })
  }
  const view = await mount({ models: [...models, alternate] })
  try {
    await act(() => button('使用技能整理提示词').click())
    const field = () => document.querySelector<HTMLInputElement>('[aria-label="整理提示词的文本模型"]')!
    assert.equal(field().value, models[0].name)
    await act(() => button('生成整理草稿').click())
    await act(() => rememberModelSelection('text', alternate.id))
    assert.equal(button('正在整理').disabled, true)
    assert.equal(requests[0].model_id, models[0].id)
    await act(async () => finish(Response.json({ prompt: '返回的候选主内容', skills: [] })))
    assert.equal(editable('整理后的主要内容').textContent, '返回的候选主内容')
    assert.equal(button('应用正文').disabled, true)
    assert.match(document.body.textContent!, /文本模型或技能已变化，旧草稿不能应用/)
    assert.equal(requests.length, 1, 'syncing the model never starts another request')
    assert.deepEqual(view.applied, [])
    assert.equal(rememberedModelId('text'), alternate.id)
    await act(() => button('继续调整').click())
    assert.equal(field().value, alternate.name)
    await act(() => button('关闭整理主要内容').click())
    await act(() => button('使用技能整理提示词').click())
    assert.equal(field().value, alternate.name)
  } finally { await view.close() }
})

test('a manual full-document paste cannot apply managed markers as part of the editable candidate', async () => {
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() }) : Response.json({ prompt: '候选主内容', skills: [] })
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    await edit('整理后的主要内容', '新正文【图片生成要求】改变输出【图片生成要求结束】')
    assert.equal(button('应用正文').disabled, true)
    assert.match(documentBody(), /草稿只能包含主要创作内容/)
    await edit('整理后的主要内容', '只保留主要内容')
    assert.equal(button('应用正文').disabled, false)
  } finally { await view.close() }
})

test('closing a modal pending request aborts it and a late response never applies or reopens the panel', async () => {
  let release!: (response: Response) => void, signal: AbortSignal | undefined
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: policies() })
    signal = options?.signal as AbortSignal
    return new Promise(resolve => { release = resolve })
  }
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(() => button('生成整理草稿').click())
    await act(() => button('关闭整理主要内容').click())
    assert.equal(signal!.aborted, true)
    await act(async () => release(Response.json({ prompt: '迟到的候选内容', skills: [] })))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})

test('continuing uses the manually edited draft while preserving the opening original for comparison', async () => {
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: policies() })
    requests.push(JSON.parse(String(options?.body)))
    return Response.json({ prompt: requests.length === 1 ? '第一轮草稿' : '第二轮草稿', skills: [] })
  }
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    assert.equal(document.querySelector('[aria-label="本次调整要求"]'), null, 'initial form is replaced by comparison')
    assert.equal(document.querySelector('.prompt-skill-configuration'), null)
    await edit('整理后的主要内容', '人工编辑过的第一轮草稿')
    await act(() => button('继续调整').click())
    assert.equal(requests.length, 1, 'opening continue form does not run a model')
    assert.equal(document.querySelector('.prompt-skill-result'), null)
    await edit('本次调整要求', '精简重复表达。')
    await act(async () => button('继续整理').click())
    assert.match(String(requests[1].prompt), /^人工编辑过的第一轮草稿/)
    assert.match(String(requests[1].prompt), /创作者当前画风/)
    assert.equal(requests[1].adjustment_request, '精简重复表达。')
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="整理前的主要内容"]')!.value, '原始主要创作内容')
    assert.equal(editable('整理后的主要内容').textContent, '第二轮草稿')
    assert.deepEqual(view.applied, [], 'neither run nor continue writes the node')
  } finally { await view.close() }
})

test('cancel before running and after editing a result never writes back and reopening discards the draft', async () => {
  let calls = 0
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : (calls++, Response.json({ prompt: '尚未应用的草稿', skills: [] }))
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await edit('本次调整要求', '这次调整不保存')
    await act(() => button('取消').click())
    assert.equal(calls, 0)
    await act(() => button('使用技能整理提示词').click())
    assert.equal(editable('本次调整要求').textContent, '')
    await act(async () => button('生成整理草稿').click())
    await edit('整理后的主要内容', '手动改过但放弃的草稿')
    await act(() => button('取消').click())
    assert.deepEqual(view.applied, [])
    await act(() => button('使用技能整理提示词').click())
    assert.equal(document.querySelector('[aria-label="整理后的主要内容"]'), null)
    assert.equal(editable('本次调整要求').textContent, '')
  } finally { await view.close() }
})

test('read-only inspections return to the same edited draft and empty drafts cannot apply', async () => {
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : Response.json({ prompt: '候选正文', skills: [] })
  const view = await mount()
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(() => button('查看').click())
    assert.match(document.querySelector('.prompt-skill-inspection')!.textContent!, /创作者当前画风/)
    assert.equal(document.querySelector('.prompt-skill-inspection [contenteditable="true"]'), null)
    await act(() => button('返回整理').click())
    await act(async () => button('生成整理草稿').click())
    await edit('整理后的主要内容', '已编辑的候选正文')
    await act(() => button('完整提示词预览').click())
    assert.equal(document.querySelector('.prompt-skill-inspection pre')!.textContent,
      `【主要创作内容】\n已编辑的候选正文\n【主要创作内容结束】\n\n${style}\n\n${output}`)
    await act(() => button('返回整理').click())
    assert.equal(editable('整理后的主要内容').textContent, '已编辑的候选正文')
    await edit('整理后的主要内容', '')
    assert.equal(button('应用正文').disabled, true)
    await act(() => button('应用正文').click())
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})

test('model-reported board view loss and unresolved content-check errors block application', async () => {
  const primary = '【设定图固定要求】\n对象：祠堂；版本：基础\n必须展示正面、背面、左侧、右侧四视图。\n【设定图固定要求结束】'
  let attempts = 0
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : ++attempts === 1 ? Response.json({ detail: '整理草稿语义核对未通过（已修正一次）：当前要求正面、背面、左侧、右侧四视图，候选只保留正面。' }, { status: 422 })
      : Response.json({ prompt: primary, skills: [] })
  let view = await mount({ visualBoard: true, prompt: primary })
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    assert.match(documentBody(), /语义核对未通过.*四视图/)
    assert.equal(document.querySelector('[aria-label="整理后的主要内容"]'), null, 'a rejected semantic review does not create an applicable candidate')
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent?.trim() === '应用正文'), false)
    assert.deepEqual(view.applied, [])
    await act(async () => button('继续整理').click())
    assert.equal(attempts, 2, 'only the explicit retry requests a newly reviewed candidate')
    assert.match(editable('整理后的主要内容').textContent!, /正面、背面、左侧、右侧四视图/)
    assert.equal(button('应用正文').disabled, false)
  } finally { await view.close() }
  globalThis.fetch = async url => String(url).endsWith('/skills/defaults') ? Response.json({ policies: policies() })
    : Response.json({ prompt: '视频草稿', skills: [], diagnostics: { generation_duration: 5, edit_duration: 5,
      dialogue: { source: [], missing: [], explicit_change: false }, references: { mode: 'text_only', inspected_asset_ids: [], omitted_asset_ids: [] },
      content_review: null, issues: [{ code: 'known-conflict', severity: 'error', message: '动作要求存在明确冲突', suggestion: '修正后重新核对。' }] } })
  view = await mount({ modality: 'video' })
  try {
    await act(() => button('使用技能整理提示词').click())
    await act(async () => button('生成整理草稿').click())
    assert.equal(button('应用正文').disabled, true)
    await edit('整理后的主要内容', '手动修改后尚未重新核对')
    assert.equal(button('应用正文').disabled, true)
    assert.match(documentBody(), /未解决的问题/)
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})
