import { sourceProductionDirectory } from '@video-studio/shared/script/script-source-production'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { skillStageOptions } from '../src/shared/api/skills-api'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'File', 'Blob']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const detail = { id: 'source-test', name: '剧本文件测试', brief: '', ratio: '9:16', script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'model', provider_id: 'provider', name: '测试模型', modality: 'text', enabled: true, settings: {} } as Model
const provider = { id: 'provider', enabled: true, adapter: 'http' } as Provider
const policies = { policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) }
const source = { project_id: detail.id, filename: '已上传剧本.txt', content: '第一场：林舟回家。\n林舟：我回来了。\n原文的最后一句。', updated_at: 'now' }
const analysis: ScriptSourceAnalysis = { id: 'analysis', source_version: 'version', model_id: model.id, status: 'queued', completed_chunks: 0, total_chunks: 1, sections: [], error: null, updated_at: 'now',
  quality: { input_hash: 'fixture-review', status: 'passed', findings: [] } }

function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)! }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
async function pollAnalysis() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) }) }
function typeMessage(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}
function pressEnter(field: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
  field.dispatchEvent(event)
  return event
}
async function mount(focusArtifact: 'all' | 'character' = 'all', project = detail) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={project} models={[model]} providers={[provider]} focusArtifact={focusArtifact} onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} /></MantineProvider>))
  await settle()
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
async function chooseFile(name: string, size?: number) {
  const file = new dom.window.File(['原剧本正文'], name, { type: 'text/plain' })
  if (size) Object.defineProperty(file, 'size', { value: size })
  let input = document.querySelector<HTMLInputElement>('.sd-script-source input[type="file"]')
  if (input) {
    await act(() => button('替换').click())
  } else {
    assert.equal(button('上传剧本文件'), undefined, 'upload should only be available in the tools menu')
    assert.equal(document.querySelector('[aria-label="原剧本来源"]'), null)
    await act(() => document.querySelector<HTMLButtonElement>('button[aria-label="对话工具"]')!.click())
    input = document.querySelector<HTMLInputElement>('.script-director-composer-toolbar input[type="file"]')!
    assert.ok(button('上传剧本文件').closest('[role="menu"]'))
    await act(() => button('上传剧本文件').click())
    await settle()
    assert.equal(document.querySelector('button[aria-label="对话工具"]')!.getAttribute('aria-expanded'), 'false')
    assert.ok(input.isConnected, 'the file picker must remain mounted after the menu closes')
  }
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  await settle()
}
function mockApi(t: TestContext, initialSource: ScriptSourceDocument | null = null, sourceRead?: Promise<void>) {
  let saved = initialSource, uploads = 0, calls: Record<string, unknown>[] = [], failUpload = false, analysisStarts = 0, analysisPauses = 0, analysisReads = 0, failPause = false
  let deferredAnalysisRead: { wait: Promise<void>; started: () => void } | undefined
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const requestUrl = new URL(String(url), 'http://localhost'), path = requestUrl.pathname
    if (path.endsWith('/script/source/analysis/pause')) {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init.body)), { analysis_id: saved!.analysis!.id })
      analysisPauses++
      if (failPause) { failPause = false; return Response.json({ detail: '暂时无法暂停分析' }, { status: 503 }) }
      saved = { ...saved!, analysis: { ...saved!.analysis!, status: 'paused' } }
      return Response.json(saved.analysis)
    }
    if (path.endsWith('/script/source/analysis')) {
      if (init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { model_id: model.id, source_updated_at: source.updated_at })
        analysisStarts++; saved = { ...saved!, analysis: { ...analysis, id: `retry-${analysisStarts}` } }
      } else {
        analysisReads++
        const deferred = deferredAnalysisRead, snapshot = saved?.analysis || null
        deferredAnalysisRead = undefined
        if (deferred) { deferred.started(); await deferred.wait; return Response.json(snapshot) }
      }
      return Response.json(saved?.analysis || null)
    }
    if (path.endsWith('/script/source')) {
      if (!init?.method && sourceRead) await sourceRead
      if (init?.method === 'POST') {
        uploads++
        assert.equal(requestUrl.searchParams.get('model_id'), model.id, 'upload uses the explicitly selected extraction model')
        assert.ok(init.body instanceof FormData)
        assert.ok((init.body as FormData).get('file') instanceof dom.window.File)
        if (failUpload) return Response.json({ detail: '未提取到文字' }, { status: 422 })
        saved = { ...source, analysis: { ...analysis, analysis_mode: 'extract' } }
      }
      if (init?.method === 'DELETE') { saved = null; return Response.json({ removed: true }) }
      return Response.json(saved)
    }
    if (path.endsWith('/script/source/production')) return Response.json({ source_version: 'a'.repeat(64), filename: saved?.filename || '',
      episodes: sourceProductionDirectory(saved?.content || '').map(ep => ({ ...ep, status: ep.scenes.length ? 'available' : 'needs_adaptation', saved_scene_ids: [], imported_offsets: [], changed_scene_ids: [] })) })
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [], creation: { status: 'direction' } })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return Response.json({ conversations: [], tasks: [], task_persistence: true })
    if (path.endsWith('/chat/stream')) {
      calls.push(JSON.parse(String(init?.body)))
      return new Response('data: {"type":"done","reply":"已整理草稿供你确认。"}\n\ndata: {"type":"close"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path.endsWith('/replies/classify')) return Response.json({ messages: [], classification_version: 1 })
    throw new Error(`Unexpected ${path}`)
  })
  return { get uploads() { return uploads }, get calls() { return calls }, get saved() { return saved }, get analysisStarts() { return analysisStarts },
    get analysisPauses() { return analysisPauses }, get analysisReads() { return analysisReads },
    setAnalysis: (value: ScriptSourceAnalysis) => { saved = { ...saved!, analysis: value } }, failNextUpload: () => { failUpload = true }, failNextPause: () => { failPause = true },
    deferNextAnalysisRead: () => {
      let release!: () => void, began!: () => void
      const wait = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { began = resolve })
      deferredAnalysisRead = { wait, started: began }
      return { started, release }
    } }
}

test('upload starts source extraction and still requires explicit creation of formal documents', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t)
  const view = await mount()
  try {
    assert.equal(button('故事大纲').disabled, true)
    await chooseFile('uploaded.txt')
    assert.equal(api.uploads, 1)
    assert.equal(api.calls.length, 0, 'upload itself must never start a creation chat or draft')
    assert.match(view.container.textContent!, /已上传剧本.txt/)
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="查看原剧本：已上传剧本.txt"]')!.click())
    assert.match(document.body.textContent!, /原文的最后一句/)
    assert.equal(api.saved!.analysis!.status, 'queued')
    assert.ok(button('暂停分析'))
    assert.equal(api.analysisStarts, 0, 'upload response schedules extraction without a duplicate POST')
    assert.ok(document.querySelector('[role=tab][data-value=map]') || [...document.querySelectorAll('[role=tab]')].some(x => x.textContent === '剧本地图'))
    assert.equal(api.analysisStarts, 0)
    assert.equal(button('生成故事大纲').disabled, false)
    await act(() => [...document.querySelector('[role=dialog]')!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '生成故事大纲')!.click())
    await settle()
    assert.equal(api.calls.length, 1)
    assert.deepEqual(api.calls[0]!.workflow, { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: [...scriptStageArtifacts.outline] })
    const instruction = JSON.stringify(api.calls[0]!.messages)
    assert.deepEqual(api.calls[0]!.messages, [{ role: 'user', text: '生成故事大纲' }], 'button instructions stay in the typed workflow contract')
    assert.doesNotMatch(instruction, /本次只交付|基于项目中已上传的原剧本/)
  } finally { await view.destroy() }
  const reopened = await mount()
  try { assert.match(reopened.container.textContent!, /已上传剧本.txt/); assert.equal(api.uploads, 1) }
  finally { await reopened.destroy() }
})

test('optional running analysis does not block explicit Enter sending or erase unsent requirements', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis: { ...analysis, status: 'running', phase: 'synthesis' } }), view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    const request = '请保持日漫二维画风，保留原文结尾。'
    await act(() => typeMessage(field, request))
    const send = view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!
    assert.equal(send.disabled, false); assert.equal(field.disabled, false)
    assert.equal(api.calls.length, 0); assert.equal(api.analysisStarts, 0)
    await act(() => {
      assert.equal(pressEnter(field, { shiftKey: true }).defaultPrevented, false)
      assert.equal(pressEnter(field, { isComposing: true }).defaultPrevented, false)
    })
    assert.equal(field.value, request); assert.equal(api.calls.length, 0)
    await act(() => pressEnter(field)); await settle()
    assert.equal(api.calls.length, 1)
    assert.equal((api.calls[0]!.messages as Array<{ text: string }>).at(-1)!.text, request)
    assert.equal(api.analysisStarts, 0)
    assert.equal(api.saved!.analysis!.status, 'running', 'discussion does not mark the audit passed or complete')
  } finally { await view.destroy() }
})

test('failed extraction offers explicit continuation without erasing requirements or blocking creation', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem(`script-director-input:${detail.id}`, '保留我尚未发送的要求')
  const api = mockApi(t, { ...source, analysis: { ...analysis, status: 'failed', error: '提供商暂时不可用' } }), view = await mount()
  try {
    assert.match(view.container.textContent!, /提供商暂时不可用/)
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    assert.equal(field.value, '保留我尚未发送的要求')
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    assert.ok(button('重试分析')); assert.equal(button('恢复分析'), undefined)
    assert.equal(api.analysisStarts, 0); assert.equal(api.calls.length, 0)
    await act(() => button('重试分析').click()); await settle()
    assert.equal(api.analysisStarts, 1)
    assert.equal(field.value, '保留我尚未发送的要求')
  } finally { await view.destroy() }
})

test('queued extraction polls progress, supports pause and never restarts or alters the composer', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis: { ...analysis, queue_position: 3 } }), view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '直接使用原文'))
    assert.ok(button('暂停分析'))
    await pollAnalysis()
    assert.equal(api.analysisStarts, 0); assert.equal(api.analysisPauses, 0); assert.ok(api.analysisReads >= 1)
    await act(() => button('暂停分析').click()); await settle()
    assert.equal(api.analysisPauses, 1); assert.ok(button('重试分析'))
    const reads = api.analysisReads; await pollAnalysis(); assert.equal(api.analysisReads, reads, 'pause stops polling')
    assert.equal(api.calls.length, 0); assert.equal(field.value, '直接使用原文')
  } finally { await view.destroy() }
})

test('source loading preserves the guard while a loaded source needs no optional audit to send', async t => {
  dom.window.localStorage.clear()
  let release!: () => void
  const loading = new Promise<void>(resolve => { release = resolve })
  const api = mockApi(t, source, loading), view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '请保留原稿人物'))
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, true)
    assert.match(view.container.textContent!, /正在读取剧本来源/)
    await act(() => pressEnter(field))
    assert.equal(api.calls.length, 0)
    await act(() => release()); await settle()
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    assert.match(view.container.textContent!, /创作依据/)
    assert.equal(field.disabled, false)
    assert.equal(api.calls.length, 0)
    assert.ok(button('开始分析'))
    assert.equal(api.analysisStarts, 0)
    assert.equal(field.value, '请保留原稿人物')
  } finally { release(); await view.destroy() }
})

test('pending screenplay analysis does not block an independent character discussion', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis }), view = await mount('character')
  try {
    assert.equal(api.calls.length, 1, 'independent asset discussion can start with its own context')
    assert.equal(api.calls[0]!.focus_artifact, 'character')
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '人物服装改为宋代风格'))
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    await act(() => pressEnter(field)); await settle()
    assert.equal(api.calls.length, 2)
    assert.equal(api.calls[1]!.focus_artifact, 'character')
  } finally { await view.destroy() }
})

test('invalid files are rejected before uploading, and a failed replacement keeps the original source', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, source)
  const view = await mount()
  try {
    await chooseFile('legacy.doc')
    assert.equal(api.uploads, 0); assert.match(view.container.textContent!, /仅支持/)
    await chooseFile('large.pdf', 10 * 1024 * 1024 + 1)
    assert.equal(api.uploads, 0); assert.match(view.container.textContent!, /10 MB/)
    api.failNextUpload()
    await chooseFile('replacement.pdf')
    assert.equal(api.uploads, 0, 'replacement waits for the explicit confirmation')
    await act(() => button('上传并替换').click()); await settle()
    assert.equal(api.uploads, 1)
    assert.equal(api.saved, source)
    assert.match(view.container.textContent!, /已上传剧本.txt/)
    assert.match(view.container.textContent!, /未提取到文字/)
    assert.equal(api.calls.length, 0)
  } finally { await view.destroy() }
})

test('removing the source restores sending and preserves the unsent requirements', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, source)
  const view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '请帮我构思一个发生在雨夜的故事'))
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="移除原剧本来源"]')!.click())
    assert.match(document.body.textContent!, /已生成并保存的阶段文档会保留/)
    await act(() => button('移除来源').click()); await settle()
    assert.equal(api.saved, null)
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    assert.equal(field.value, '请帮我构思一个发生在雨夜的故事')
    assert.equal(button('上传剧本文件'), undefined)
    assert.equal(view.container.querySelector('[aria-label="原剧本来源"]'), null)
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="对话工具"]')!.click())
    assert.ok(button('上传剧本文件').closest('[role="menu"]'))
    assert.equal(api.calls.length, 0)
  } finally { await view.destroy() }
})

test('parent progress reaches saved results and reopening never starts another analysis', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis: { ...analysis, analysis_mode: 'extract', status: 'running', phase: 'synthesis', completed_chunks: 1 } })
  const view = await mount()
  const completed: ScriptSourceAnalysis = { ...analysis, analysis_mode: 'extract', status: 'ready', phase: 'ready', completed_chunks: 1,
    sections: [{ offset: 0, length: source.content.length, title: '第1集 回家', episode_number: 1, summary: '林舟回家。', characters: [], events: [] }],
    story: { summary: '林舟回到故乡。', characters: [{ name: '林舟', aliases: [], description: '返乡者', section_ids: [0] }],
      settings: [{ description: '故乡是事件发生地。', section_ids: [0] }], timeline: [], threads: [], ending: { summary: '主角回家。', section_ids: [0] }, uncertainties: [] } }
  try {
    assert.match(view.container.textContent!, /正在整理全剧信息/)
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    api.setAnalysis(completed); await pollAnalysis()
    assert.match(view.container.textContent!, /地图已就绪/)
    const reads = api.analysisReads; await pollAnalysis(); assert.equal(api.analysisReads, reads, 'completed extraction stops polling')
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="查看原剧本：已上传剧本.txt"]')!.click())
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(x => x.textContent === '全剧信息')!
    assert.equal(tab.disabled, false); await act(() => tab.click())
    assert.match(document.body.textContent!, /故乡是事件发生地/)
    assert.match(document.body.textContent!, /人物与身份/)
    assert.equal(button('提交并重新核对'), undefined)
    assert.equal(api.analysisStarts, 0)
  } finally { await view.destroy() }
  const reopened = await mount()
  try { await pollAnalysis(); assert.equal(api.analysisStarts, 0); assert.equal(api.calls.length, 0); assert.match(reopened.container.textContent!, /地图已就绪/) }
  finally { await reopened.destroy() }
})

test('late polling response cannot replace a newly uploaded manuscript analysis', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis: { ...analysis, id: 'old-run', status: 'running' } }), view = await mount()
  const deferred = api.deferNextAnalysisRead()
  try {
    await pollAnalysis(); await deferred.started
    await chooseFile('replacement.md')
    await act(() => button('上传并替换').click()); await settle()
    assert.equal(api.uploads, 1)
    await act(async () => { deferred.release(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(api.saved!.analysis!.id, analysis.id)
    assert.match(view.container.textContent!, /等待分析/)
    assert.equal(api.analysisStarts, 0)
  } finally { deferred.release(); await view.destroy() }
})

test('Markdown manuscript previews render current and asynchronously loaded original headings and tables', async t => {
  const { ScriptSourcePreview } = await import('../src/features/script/ScriptSourceAnalysisView')
  const content = '## 2.2 九泽地理\n\n| 灵泽 | 地貌特征 | 主要剧情功能 |\n| --- | --- | --- |\n| 寒江泽 | 大江、深潭 | **主角出身地** |\n| 天门泽 | 飞升台 | 最终决战 |\n\n## 2.3 钓道与妖兽\n\n- 妖蜕可炼竿\n- 妖筋可制线'
  const manuscript = { ...source, filename: '我以凡竿钓世间.md', revision: 1, content }
  const original = { ...source, filename: '我以凡竿钓世间.MARKDOWN', content: content.replace('主角出身地', '上传时的设定') }
  let resolveOriginal!: (response: Response) => void
  const originalResponse = new Promise<Response>(resolve => { resolveOriginal = resolve })
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith(`/projects/${source.project_id}/script/source/original`))
    return originalResponse
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptSourcePreview source={manuscript} /></MantineProvider>))
    const current = container.querySelector<HTMLElement>('[role="tabpanel"][id$="-current"]')!
    assert.deepEqual([...current.querySelectorAll('h2')].map(node => node.textContent), ['2.2 九泽地理', '2.3 钓道与妖兽'])
    assert.equal(current.querySelectorAll('thead th[scope="col"]').length, 3)
    assert.equal(current.querySelectorAll('tbody tr').length, 2)
    assert.equal(current.querySelector('td strong')?.textContent, '主角出身地')
    assert.equal(current.querySelectorAll('ul li').length, 2)
    assert.equal(current.querySelector('[role="region"][aria-label="剧本表格"]')?.getAttribute('tabindex'), '0')
    assert.doesNotMatch(current.textContent!, /##|\| ---/)
    await act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === '上传原稿')!.click())
    const originalPanel = container.querySelector<HTMLElement>('[role="tabpanel"][id$="-original"]')!
    assert.match(originalPanel.textContent!, /正在读取上传原稿/)
    await act(async () => { resolveOriginal(Response.json(original)) })
    assert.equal(originalPanel.querySelector('h2')?.textContent, '2.2 九泽地理')
    assert.equal(originalPanel.querySelector('td strong')?.textContent, '上传时的设定')
    assert.equal(originalPanel.querySelectorAll('tbody tr').length, 2)
    assert.match(originalPanel.textContent!, /上传时的原稿保留供追溯/)
    assert.equal(manuscript.content, content, 'preview must not rewrite the current manuscript')
    assert.equal(original.content, content.replace('主角出身地', '上传时的设定'))
  } finally { await act(() => root.unmount()); container.remove() }
})

test('non-Markdown source previews preserve literal content and line breaks', async () => {
  const { ScriptSourcePreview } = await import('../src/features/script/ScriptSourceAnalysisView')
  const content = '## 场景标记\n| 林舟 | 台词 |\n| --- | --- |\n| 回家 | **我回来了** |'
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    for (const extension of ['txt', 'docx', 'pdf']) {
      await act(() => root.render(<MantineProvider env="test"><ScriptSourcePreview source={{ ...source, filename: `剧本.${extension}`, content }} /></MantineProvider>))
      assert.equal(container.querySelector('.sd-source-preview-body')?.textContent, content)
      assert.equal(container.querySelector('h2, table, strong'), null)
    }
  } finally { await act(() => root.unmount()); container.remove() }
})

test('independent quality review remains active until completion and the prepared story retains source provenance', async () => {
  const { ScriptSourceAnalysisStatus, ScriptSourcePreview } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const ready: ScriptSourceAnalysis = { ...analysis, status: 'ready', phase: 'ready', completed_chunks: 1, sections: [{ offset: 0, length: source.content.length,
    title: '返乡', episode_number: 1, summary: '林舟回家', characters: [], events: [] }], story: { summary: '全剧主线：林舟回家并找回伙伴。', characters: [{ name: '林舟', aliases: ['阿舟'], description: '返乡主角', section_ids: [0] }],
      timeline: [], threads: [{ setup: '失落的钥匙', payoff: '终场归还', section_ids: [0] }], ending: { summary: '伙伴重聚', section_ids: [0] }, uncertainties: [] } }
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: { ...ready, status: 'running', phase: 'synthesis' } }} starting={false} unavailable={false} pollError={false} onStart={() => {}} /></MantineProvider>))
    assert.match(container.textContent!, /正在独立核对分析结果/)
    assert.doesNotMatch(container.textContent!, /92%/)
    assert.doesNotMatch(container.textContent!, /完成后可发送，不会自动发送/)
    assert.equal(container.querySelector('[role="progressbar"]'), null)
    const steps = [...container.querySelectorAll('[aria-label="剧本分析步骤"] li')]
    for (const [index, label] of ['全文分析', '全剧整合', '质量核对'].entries()) assert.ok(steps[index]?.textContent?.includes(label))
    assert.deepEqual(steps.map(step => step.getAttribute('data-state')), ['completed', 'completed', 'active'])
    assert.equal(steps[2]!.getAttribute('aria-current'), 'step')
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: { ...ready,
      status: 'running', phase: 'synthesis', progress: { stage: 'repairing', message: '正在修补第 2/3 项核对问题，已保存的分析保持可恢复' } } }}
      starting={false} unavailable={false} pollError={false} onStart={() => {}} /></MantineProvider>))
    assert.match(container.textContent!, /正在处理核对意见/)
    assert.match(container.textContent!, /正在修补第 2\/3 项核对问题/)
    assert.doesNotMatch(container.textContent!, /正在独立核对分析结果/)
    assert.deepEqual([...container.querySelectorAll('[aria-label="剧本分析步骤"] li')].map(step => step.getAttribute('data-state')), ['completed', 'completed', 'active'])
    await act(() => root.render(<MantineProvider env="test"><ScriptSourcePreview source={{ ...source, analysis: ready }} /></MantineProvider>))
    await act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === '全剧信息')!.click())
    assert.match(container.textContent!, /阿舟/); assert.match(container.textContent!, /终场归还/); assert.match(container.textContent!, /来源：剧情段落 1/)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('full-source analysis shows stages without partial reading percentages and preserves historical-state guidance', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const current = { ...analysis, status: 'running' as const, completed_chunks: 1, total_chunks: 3, completed_characters: 10,
    progress: { stage: 'repairing' as const, message: '正在修复河岸段落的证据' } }
  const render = (state: ScriptSourceAnalysis, pollError = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }} starting={false} unavailable={false} pollError={pollError} hasPreviousFailure onStart={() => {}} /></MantineProvider>))
  try {
    await render({ ...current, progress: { stage: 'reading', message: `正在完整理解剧本，共 ${source.content.length} 字符；全文一次提交` } })
    assert.match(container.textContent!, /正在完整理解剧本，共 \d+ 字符/)
    assert.doesNotMatch(visibleAnalysisText(container), /全文一次提交|10 万字以内直接阅读全文分析|不会自动发送/)
    assert.match(container.textContent!, /全文一次提交/, 'the original progress diagnostic stays available in technical details')
    await render(current)
    assert.equal(container.querySelector('[role="progressbar"]'), null)
    assert.match(container.querySelector('[aria-label="剧本分析步骤"] [aria-current="step"]')!.textContent!, /全文分析/)
    assert.match(container.textContent!, /正在校验全文分析/); assert.match(container.textContent!, /正在修复河岸段落的证据/)
    assert.match(container.textContent!, /按实际处理步骤更新，单步耗时不代表剩余时间/)
    assert.doesNotMatch(container.textContent!, /10 万字以内直接阅读全文分析/)
    assert.doesNotMatch(container.textContent!, /\d+%/)
    assert.match(container.textContent!, /历史结果/)
    await render(current, true)
    assert.match(container.textContent!, /暂时无法读取进度，正在重试/)
    assert.equal(container.querySelector('[aria-label="剧本分析步骤"] [aria-current="step"]'), null)
    assert.deepEqual([...container.querySelectorAll('[aria-label="剧本分析步骤"] li')].map(step => step.getAttribute('data-state')), ['pending', 'pending', 'pending'])
    await render({ ...current, total_chunks: 6, progress: { stage: 'splitting', message: '已缩小范围继续分析' } })
    assert.equal(container.querySelector('[role="progressbar"]'), null)
    assert.match(container.textContent!, /完整读取当前文稿/)
    assert.doesNotMatch(visibleAnalysisText(container), /细分|缩小范围/)
    assert.match(container.textContent!, /已缩小范围继续分析/, 'a historical diagnostic must not be deleted to simplify the default view')
    await render({ ...current, status: 'failed', error: '服务暂时不可用' })
    assert.match(container.textContent!, /已完成的分析步骤已保留，可继续处理未完成部分/)
    assert.match(container.textContent!, /上次处理项：正在修复河岸段落的证据/)
    assert.ok(button('继续未完成步骤'))
    assert.doesNotMatch(container.textContent!, /历史结果/)
    await render({ ...current, status: 'ready' })
    assert.match(container.textContent!, /剧本地图已准备/); assert.match(container.textContent!, /历史结果/)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('revised effective source explains the map update and a prepared map stays ready without suggesting another analysis', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let starts = 0, pauses = 0
  const render = (state?: ScriptSourceAnalysis, pollError = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus
    source={{ ...source, revision: 1, analysis: state }} starting={false} unavailable={false} pollError={pollError}
    onStart={() => { starts++ }} onPause={() => { pauses++ }} /></MantineProvider>))
  try {
    await render()
    assert.match(container.textContent!, /当前有效稿已修订，可更新剧本地图/)
    assert.doesNotMatch(container.textContent!, /正在更新|原剧本已保存/)
    await act(() => button('开始分析').click())
    assert.equal(starts, 1)

    await render({ ...analysis, queue_position: 2 })
    assert.match(container.textContent!, /有效稿已修订，等待更新剧本地图，供后续阶段使用/)
    assert.match(container.textContent!, /队列第 2 项/)
    assert.equal(container.querySelector('[aria-current="step"]'), null)
    assert.equal(container.querySelector('[role="timer"]'), null)

    const running: ScriptSourceAnalysis = { ...analysis, status: 'running', phase: 'reading', started_at: new Date(Date.now() - 30_000).toISOString() }
    await render(running)
    assert.match(container.textContent!, /有效稿已修订，正在更新剧本地图，供后续阶段使用/)
    assert.deepEqual([...container.querySelectorAll('[aria-label="剧本分析步骤"] li')].map(step => step.textContent?.match(/全文分析|全剧整合|质量核对/)?.[0]), ['全文分析', '全剧整合', '质量核对'])
    assert.match(container.querySelector('[aria-current="step"]')!.textContent!, /全文分析/)
    assert.ok(container.querySelector('[role="timer"]'), 'the revision explanation must not replace live elapsed time')
    await act(() => button('暂停分析').click())
    assert.equal(pauses, 1)

    await render(running, true)
    assert.match(container.textContent!, /修订后有效稿的分析状态/)
    assert.doesNotMatch(container.textContent!, /正在更新剧本地图/)
    assert.equal(container.querySelector('[aria-current="step"]'), null, 'an unavailable poll must not imply an actively updating stage')

    await render({ ...running, status: 'paused' })
    assert.match(container.textContent!, /分析已暂停，当前有效稿已保留/)
    assert.ok(button('重试分析'))
    assert.doesNotMatch(container.textContent!, /正在更新剧本地图/)

    await render({ ...analysis, status: 'ready', phase: 'ready', completed_chunks: 1, sections: [{ offset: 0, length: source.content.length, title: '返乡', episode_number: 1, summary: '林舟回家', characters: [], events: [] }] })
    assert.match(container.textContent!, /当前有效稿的剧本地图已准备 · 1 段剧情/)
    assert.doesNotMatch(container.textContent!, /目录、人物、事件与全剧信息已整理|后续创作共用当前版本/)
    assert.doesNotMatch(container.textContent!, /等待更新|正在更新|重新生成/)
    assert.equal(container.querySelector('[aria-label="剧本分析步骤"]'), null)
    assert.equal(container.querySelector('[role="timer"]'), null)
    assert.equal(container.querySelector('.script-director-spinner'), null)
    assert.equal(button('开始分析'), undefined)
    assert.equal(button('暂停分析'), undefined)
    assert.equal(starts, 1, 'rendering an already prepared revision must not start analysis')
    assert.equal(pauses, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('analysis steps distinguish the live phase from queued and stale polling states', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const story: NonNullable<ScriptSourceAnalysis['story']> = { summary: '林舟回家。', characters: [], timeline: [], threads: [], ending: { summary: '回家', section_ids: [] }, uncertainties: [] }
  const render = (state: ScriptSourceAnalysis, pollError = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }} starting={false} unavailable={false} pollError={pollError} onStart={() => {}} /></MantineProvider>))
  const currentStep = () => container.querySelector('[aria-label="剧本分析步骤"] [aria-current="step"]')?.textContent?.match(/全文分析|全剧整合|质量核对/)?.[0]
  const stepStates = () => [...container.querySelectorAll('[aria-label="剧本分析步骤"] li')].map(step => step.getAttribute('data-state'))
  try {
    await render({ ...analysis, queue_position: 2 })
    assert.match(container.textContent!, /队列第 2 项/)
    assert.equal(currentStep(), undefined)
    assert.deepEqual(stepStates(), ['pending', 'pending', 'pending'])
    assert.equal(container.querySelector('[role="progressbar"]'), null)

    await render({ ...analysis, status: 'running', phase: 'reading', progress: { stage: 'validating', message: '核对剧情覆盖情况' } })
    assert.equal(currentStep(), '全文分析', 'coverage validation belongs to full-source analysis')
    assert.deepEqual(stepStates(), ['active', 'pending', 'pending'])
    await render({ ...analysis, status: 'running', completed_characters: source.content.length, progress: { stage: 'validating', message: '核对剧情覆盖情况' } })
    assert.equal(currentStep(), '全文分析', 'a legacy snapshot without phase still waits for coverage validation')
    assert.deepEqual(stepStates(), ['active', 'pending', 'pending'], 'character counts do not certify completed analysis')

    await render({ ...analysis, status: 'running', phase: 'synthesis', completed_chunks: 1, progress: { stage: 'synthesis', message: '整合人物与全剧因果' } })
    assert.match(container.textContent!, /正在整理全剧信息/)
    assert.equal(currentStep(), '全剧整合')
    assert.deepEqual(stepStates(), ['completed', 'active', 'pending'])

    await render({ ...analysis, status: 'running', phase: 'synthesis', completed_chunks: 1, story, progress: { stage: 'validating', message: '检查遗漏及因果关系' } })
    assert.match(container.textContent!, /正在独立核对分析结果/)
    assert.equal(currentStep(), '质量核对')
    assert.deepEqual(stepStates(), ['completed', 'completed', 'active'])

    await render({ ...analysis, status: 'running', phase: 'synthesis', completed_chunks: 1, story }, true)
    assert.match(container.textContent!, /状态待更新/)
    assert.match(container.textContent!, /暂时无法读取进度，正在重试/)
    assert.equal(currentStep(), undefined, 'a stale snapshot must not claim a step is currently executing')
    assert.deepEqual(stepStates(), ['completed', 'completed', 'pending'], 'completed work remains visible during a polling error')
    await render({ ...analysis, status: 'queued', phase: 'synthesis', story })
    assert.equal(currentStep(), undefined, 'a resumed analysis has no active step while awaiting its queue turn')
    assert.deepEqual(stepStates(), ['completed', 'completed', 'pending'])

    for (const status of ['ready', 'paused', 'failed'] as const) {
      await render({ ...analysis, status, phase: 'synthesis', story })
      if (status === 'ready') assert.equal(container.querySelector('[aria-label="剧本分析步骤"]'), null)
      else {
        assert.deepEqual(stepStates(), ['completed', 'completed', status])
        assert.equal(currentStep(), undefined, 'an interrupted task must not claim a live step')
        assert.ok(button('继续未完成步骤'))
      }
      assert.equal(container.querySelector('[role="progressbar"]'), null)
    }
  } finally { await act(() => root.unmount()); container.remove() }
})

test('interrupted analysis identifies the unfinished step and describes only reusable checkpoints', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = (state: ScriptSourceAnalysis) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus
    source={{ ...source, analysis: state }} starting={false} unavailable={false} pollError={false} onStart={() => {}} /></MantineProvider>))
  const stepStates = () => [...container.querySelectorAll('[aria-label="剧本分析步骤"] li')].map(step => step.getAttribute('data-state'))
  try {
    await render({ ...analysis, status: 'failed', phase: 'reading', completed_characters: source.content.length,
      progress: { stage: 'reading', message: '正在生成全文目录' }, error: '当前步骤处理超时',
      resume: { available: false, message: '尚无校验通过的目录，重试将重新进行全文分析。' } })
    assert.deepEqual(stepStates(), ['failed', 'pending', 'pending'])
    assert.match(container.textContent!, /上次处理项：正在生成全文目录/)
    assert.match(container.textContent!, /尚无校验通过的目录/)
    assert.ok(button('重试分析'))
    assert.equal(button('继续未完成步骤'), undefined)
    assert.doesNotMatch(container.textContent!, /有效分析结果已保留|\d+%/)
    assert.equal(container.querySelector('.script-director-spinner'), null)
    assert.equal(container.querySelector('[aria-current="step"]'), null)

    const partial: ScriptSourceAnalysis = { ...analysis, status: 'failed', phase: 'reading',
      sections: [{ offset: 0, length: 10, title: '第一集', episode_number: 1, summary: '主角返乡。', characters: [], events: [] }],
      progress: { stage: 'reading', message: '正在整理第 2 页全文目录' }, error: '当前步骤处理超时',
      resume: { available: true, message: '已校验第 1 页目录，继续生成后续目录；原文仍将完整提供。' } }
    await render(partial)
    assert.deepEqual(stepStates(), ['failed', 'pending', 'pending'], 'a saved directory page does not certify completed full-source analysis')
    assert.ok(button('继续未完成步骤'))
    assert.match(container.textContent!, /已校验第 1 页目录/)
    assert.match(container.textContent!, /上次处理项：正在整理第 2 页全文目录/)

    await render({ ...partial, phase: 'synthesis', completed_chunks: 1, progress: { stage: 'synthesis', message: '正在整理全剧事件，第 2 页' },
      resume: { available: true, message: '全文目录和第 1 页全剧信息已保存，继续整合剩余信息。' } })
    assert.deepEqual(stepStates(), ['completed', 'failed', 'pending'])
    assert.match(container.textContent!, /全文目录和第 1 页全剧信息已保存/)
    assert.ok(button('继续未完成步骤'))

    await render({ ...partial, status: 'paused', phase: 'synthesis', completed_chunks: 1,
      progress: { stage: 'synthesis', message: '正在整合人物与因果' },
      resume: { available: true, message: '全文目录已校验，可继续全剧整合。' } })
    assert.deepEqual(stepStates(), ['completed', 'paused', 'pending'])
    assert.match(container.textContent!, /上次处理项：正在整合人物与因果/)
    assert.ok(button('继续未完成步骤'))
    assert.equal(container.querySelector('[aria-current="step"]'), null)
    assert.equal(container.querySelector('.script-director-spinner'), null)

    await render({ ...partial, status: 'queued', phase: 'synthesis', completed_chunks: 1,
      resume: { available: true, message: '全文目录已校验，等待继续整合。' } })
    assert.deepEqual(stepStates(), ['completed', 'pending', 'pending'], 'a queued resumed synthesis retains completed full-source analysis')
    assert.match(container.textContent!, /全文目录已校验，等待继续整合/)
    assert.equal(container.querySelector('[aria-current="step"]'), null)

    await render({ ...partial, resume: undefined })
    assert.ok(button('继续未完成步骤'), 'legacy section checkpoints remain compatible without an explicit resume field')
    await render({ ...partial, resume: { available: false, message: '已有目录需要重新校验，重试全文分析。' } })
    assert.ok(button('重试分析'), 'an explicit backend rejection overrides optimistic legacy checkpoint inference')
    assert.equal(button('继续未完成步骤'), undefined)

    await render({ ...partial, phase: 'synthesis', resume: { available: false, blocked: true,
      message: '已完成的分析已保留，请先核对提供商记录。' } })
    const blocked = button('检查并恢复')!
    assert.ok(blocked); assert.equal(blocked.disabled, true)
    assert.equal(button('继续未完成步骤'), undefined)
    assert.equal(button('重试分析'), undefined)
    assert.match(container.textContent!, /已完成的分析已保留，请先核对提供商记录/)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('analysis elapsed time follows the server execution start across ticks, attempts and remounts', async t => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  let now = Date.parse('2026-10-17T00:00:00.000Z')
  t.mock.method(Date, 'now', () => now)
  const container = document.createElement('div'); document.body.append(container); let root = createRoot(container)
  const render = (state: ScriptSourceAnalysis, pollError = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }} starting={false} unavailable={false} pollError={pollError} onStart={() => {}} /></MantineProvider>))
  const elapsed = () => container.querySelector('[role="timer"]')?.textContent
  const running = { ...analysis, status: 'running' as const, phase: 'reading' as const, started_at: new Date(now - 65_000).toISOString() }
  try {
    await render(running)
    const initial = elapsed()
    assert.ok(initial, 'a running analysis uses its server execution start immediately')
    assert.match(initial, /1 分 5 秒/)
    assert.equal(container.querySelector('[role="timer"]')!.getAttribute('aria-live'), 'off', 'second-by-second timing must not repeatedly interrupt screen readers')
    now += 1000
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
    assert.match(elapsed()!, /1 分 6 秒/, 'elapsed time advances between status polls')

    await act(() => root.unmount()); root = createRoot(container)
    await render(running)
    assert.match(elapsed()!, /1 分 6 秒/, 'reopening the view continues from the server start')

    await render({ ...running, id: 'new-execution', started_at: new Date(now - 2_000).toISOString() })
    assert.match(elapsed()!, /2(?:\.0)? 秒/)
    assert.doesNotMatch(elapsed()!, /1 分/)
    await render({ ...running, started_at: new Date(now - 3_000).toISOString() })
    assert.match(elapsed()!, /3(?:\.0)? 秒/, 'a changed execution start is reflected without waiting for the next tick')
    await render(running, true)
    assert.equal(elapsed(), undefined, 'polling failure must not present a stale snapshot as a live clock')

    for (const started_at of [undefined, 'not-a-date']) {
      await render({ ...running, started_at })
      assert.equal(elapsed(), undefined, 'legacy or invalid start values must not fabricate elapsed time')
    }
    for (const status of ['queued', 'paused', 'failed', 'ready'] as const) {
      await render({ ...running, status })
      assert.equal(elapsed(), undefined, 'only a running execution has a live elapsed clock')
    }
  } finally { await act(() => root.unmount()); container.remove() }
})

test('current validation layer and historical diagnostics render separately without blaming manuscript quality',async()=>{
 const {ScriptSourceAnalysisStatus}=await import('../src/features/script/ScriptSourceAnalysisView')
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(()=>root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{...source,analysis:{...analysis,status:'failed',error:'旧数组错误',failure:{stage:'format',message:'当前完整补丁缺少字段',historical_diagnostics:'54条旧数组问题'}}}} starting={false} unavailable={false} pollError={false} onStart={()=>{}}/></MantineProvider>))
  assert.match(host.textContent||'',/返回格式检查未通过/);assert.match(host.textContent||'',/当前完整补丁缺少字段/)
  assert.match(host.textContent||'',/初始问题（历史记录）/);assert.match(host.textContent||'',/不表示剧本内容质量不合格/)
 }finally{await act(()=>root.unmount());host.remove()}
})

test('synthesis status displays exact task progress and prevents exhausted continuation while separating request reconciliation', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); let starts = 0, resolves = 0, revalidations = 0
  const failed: ScriptSourceAnalysis = { ...analysis, status: 'failed', phase: 'synthesis', sections: [],
    completed_chunks: 1, total_chunks: 1,
    resume: { available: false, action: 'blocked', message: '15/16 已保存，纠正额度已使用' },
    failure: { stage: 'format', message: 'JSON 语法错误：位置 78，第 4 行第 50 列' },
    story_progress: { completed: 15, total: 16, pending: [{ key: 'uncertainties:2', label: '不确定事项', status: 'correction_exhausted', message: 'JSON 引号语法错误' }] } }
  const render = async () => act(async () => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: failed }}
    starting={false} unavailable={false} pollError={false} onStart={() => { starts++ }} onResolveRequest={() => { resolves++ }} onRevalidate={() => { revalidations++ }} /></MantineProvider>))
  try {
    await render()
    assert.match(container.textContent!, /全剧整合：15\/16 项已完成/); assert.match(container.textContent!, /uncertainties:2/)
    const exhausted = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '查看校验问题')!
    assert.equal(exhausted.disabled, false)
    await act(() => exhausted.click()); assert.equal(starts, 0); assert.equal(resolves, 0)
    assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === '诊断记录')!.getAttribute('aria-expanded'), 'true')
    failed.resume = { available: false, blocked: true, action: 'reconcile_request', message: '核对另一个子任务的请求' }
    failed.story_progress!.protected_keys = ['uncertainties:0']
    failed.story_progress!.pending.push({ key: 'threads:3', label: '伏笔与回收', status: 'unknown_response', message: '输出130字符后连接中断，结果未知' })
    await render()
    const pending = container.querySelector('[aria-label="待处理任务"]')!
    assert.match(container.querySelector('.sd-analysis-diagnostic-list')!.textContent!, /JSON 引号语法错误/)
    assert.match(container.querySelector('.sd-analysis-diagnostic-list')!.textContent!, /输出130字符后连接中断/)
    assert.match(pending.textContent!, /请求结果尚未确认/)
    assert.match(pending.textContent!, /已保存纠正回答，校验未通过/); assert.ok(container.querySelector('[aria-label="保留请求"]'))
    assert.match(container.querySelector('[aria-label="保留请求"]')!.textContent!, /uncertainties:0/)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '检查并恢复')!.click())
    assert.equal(resolves, 1); assert.equal(starts, 0)
    failed.resume = { available: true, action: 'revalidate', message: '本地校验保存回答，不刷新纠正额度' }
    await render()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '重新校验保存回答')!.click())
    assert.equal(starts, 0); assert.equal(resolves, 1); assert.equal(revalidations, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})

function visibleAnalysisText(node: Node): string {
  if (node.nodeType === window.Node.TEXT_NODE) return node.textContent || ''
  if (node instanceof window.HTMLElement) {
    const style = window.getComputedStyle(node)
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return ''
  }
  return [...node.childNodes].map(visibleAnalysisText).join(' ')
}

test('analysis default status has one current phase, one plain reason and one working action while full diagnostics remain collapsed', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); let starts = 0
  const hash = '4a8cd8695e420e16203944af82a4e897e5202e78b88d33dcc0f98a4fb05a473e'
  const diagnostic = 'source_request_sibling_pending：' + '完整诊断不得静默截断。'.repeat(80) + '诊断末尾证据'
  const state: ScriptSourceAnalysis = { ...analysis, status: 'failed', phase: 'synthesis', completed_chunks: 1,
    progress: { stage: 'synthesis', message: '上次进度13/21；人物归并尚未派发' },
    error: diagnostic, failure: { stage: 'recovery', message: diagnostic, historical_diagnostics: '历史13/21：原始诊断' },
    resume: { available: true, action: 'continue', message: `16/17已保存；characters_merge:${hash}；${diagnostic}` },
    story_progress: { completed: 16, total: 17, protected_keys: ['uncertainties:0'],
      pending: [{ key: `characters_merge:${hash}`, label: '人物归并', status: 'pending', message: diagnostic }] } }
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
      starting={false} unavailable={false} pollError={false} onStart={() => { starts++ }} /></MantineProvider>))
    const shown = visibleAnalysisText(container)
    assert.equal(container.querySelectorAll('[aria-label="当前分析阶段"]').length, 1)
    assert.equal(container.querySelectorAll('[aria-label="分析状态说明"]').length, 1)
    assert.match(shown, /当前阶段：全剧整合/)
    assert.match(shown, /已展开子任务：\s*16\s*\/\s*17\s*项已保存/)
    assert.doesNotMatch(shown, /13\/21|source_request_sibling_pending|characters_merge:|uncertainties:0|诊断末尾证据|只剩最后/)
    assert.doesNotMatch(shown, new RegExp(hash))
    const detail = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '技术详情')!
    assert.equal(detail.getAttribute('aria-expanded'), 'false')
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.sd-source-analysis-status button')]
    assert.equal(actions.length, 1); assert.equal(actions[0]!.disabled, false)
    await act(() => actions[0]!.click()); assert.equal(starts, 1)
    await act(() => detail.click())
    assert.equal(detail.getAttribute('aria-expanded'), 'true')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    const diagnosticToggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '诊断记录')!
    assert.equal(diagnosticToggle.getAttribute('aria-expanded'), 'false')
    assert.doesNotMatch(visibleAnalysisText(container), /诊断末尾证据|历史13\/21/)
    await act(() => diagnosticToggle.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    const expanded = visibleAnalysisText(container)
    assert.match(expanded, /诊断末尾证据/); assert.match(expanded, new RegExp(hash)); assert.match(expanded, /历史13\/21/)
    assert.equal(container.querySelectorAll('.sd-analysis-diagnostic-list pre').length, 0)
    assert.equal([...container.querySelectorAll('.sd-analysis-diagnostic-list p')].filter(item => item.textContent === diagnostic).length, 1, 'identical full diagnostics appear once with combined source labels')
    assert.equal(container.querySelectorAll('.sd-analysis-field').length, 2)
    assert.ok(container.querySelector('button[aria-label="复制未完成任务编号"]'))
    assert.ok(container.textContent!.includes(diagnostic), 'the complete original diagnostic remains available')
    state.id = 'next-explicit-analysis'
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
      starting={false} unavailable={false} pollError={false} onStart={() => { starts++ }} /></MantineProvider>))
    assert.equal([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '技术详情')!.getAttribute('aria-expanded'), 'false',
      'a new analysis starts with technical details collapsed')
    assert.doesNotMatch(visibleAnalysisText(container), /诊断末尾证据|13\/21/)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('exhausted format answers and unknown requests show distinct concise reasons without inventing a local repair action', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let starts = 0, resolves = 0
  const state: ScriptSourceAnalysis = { ...analysis, status: 'failed', phase: 'synthesis', failure: { stage: 'format', message: 'JSON语法错误：位置78，第4行第50列' },
    resume: { available: false, action: 'blocked', message: '完整原回答和纠正回答均已保留，但仍未通过校验；本提案纠正额度已使用' } }
  const render = (resolve = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
    starting={false} unavailable={false} pollError={false} onStart={() => { starts++ }} onResolveRequest={resolve ? () => { resolves++ } : undefined} /></MantineProvider>))
  try {
    await render()
    assert.match(visibleAnalysisText(container), /保存回答的格式尚未通过校验/)
    assert.doesNotMatch(visibleAnalysisText(container), /位置78|第4行|JSON|剧本质量不合格/)
    const blocked = container.querySelector<HTMLButtonElement>('.sd-source-analysis-status button')!
    assert.equal(blocked.disabled, false)
    await act(() => blocked.click()); assert.equal(starts, 0)
    assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === '诊断记录')!.getAttribute('aria-expanded'), 'true')
    state.resume = { available: false, blocked: true, action: 'reconcile_request', message: '请求受理状态未知，需核对提供商' }
    await render(true)
    assert.match(visibleAnalysisText(container), /请求的最终结果尚未确认/)
    const reconcile = container.querySelector<HTMLButtonElement>('.sd-source-analysis-status button')!
    assert.equal(reconcile.disabled, false)
    await act(() => reconcile.click()); assert.equal(resolves, 1); assert.equal(starts, 0)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('local revalidation and issue inspection stay available without an enabled model and never fall back to generation', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let starts = 0, revalidations = 0
  const state: ScriptSourceAnalysis = { ...analysis, status: 'failed', failure: { stage: 'format', message: '需校验保存回答' }, resume: { available: true, action: 'revalidate', message: '本地重新校验' } }
  const render = (allowRevalidation: boolean) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
    starting={false} unavailable pollError={false} onStart={() => { starts++ }} onRevalidate={allowRevalidation ? () => { revalidations++ } : undefined} /></MantineProvider>))
  try {
    await render(false)
    assert.equal(button('重新校验保存回答').disabled, true)
    button('重新校验保存回答').click(); assert.equal(starts, 0)
    await render(true)
    assert.equal(button('重新校验保存回答').disabled, false)
    await act(() => button('重新校验保存回答').click())
    assert.equal(revalidations, 1); assert.equal(starts, 0)
    state.resume = { available: false, action: 'blocked', message: '本地保存问题仍待处理' }
    await render(true)
    assert.equal(button('查看校验问题').disabled, false)
    await act(() => button('查看校验问题').click())
    assert.equal(button('技术详情').getAttribute('aria-expanded'), 'true')
    assert.equal(starts, 0); assert.equal(revalidations, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('a successful local validation shows its fresh summary and requires an explicit model-usage confirmation for the next step', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let starts = 0
  const state: ScriptSourceAnalysis = { ...analysis, status: 'paused', phase: 'synthesis',
    error: '旧错误：source_request_sibling_pending', failure: { stage: 'recovery', message: '旧失败' },
    resume: { available: true, action: 'continue', message: '继续处理' },
    local_validation: { checked_at: '2026-11-15T00:00:00.000Z', reused_tasks: 1, model_required: true, summary: '已复用并校验 1 项保存回答。独立质量核对仍需模型处理。' } }
  const render = () => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
    starting={false} unavailable={false} pollError={false} onStart={() => { starts++ }} /></MantineProvider>))
  try {
    await render()
    assert.match(visibleAnalysisText(container), /已复用并校验 1 项保存回答/)
    assert.doesNotMatch(visibleAnalysisText(container), /source_request_sibling_pending|旧失败/)
    await act(() => button('继续生成未完成项').click())
    assert.equal(starts, 0)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /调用所选模型.*产生模型用量/)
    await act(() => button('取消').click()); assert.equal(starts, 0)
    await act(() => button('继续生成未完成项').click())
    await act(() => button('继续生成').click()); assert.equal(starts, 1)
    await act(() => button('继续生成未完成项').click())
    state.id = 'new-source-analysis'
    await render(); await settle()
    assert.equal(document.querySelector('[role="dialog"]'), null, 'changing analysis clears an old confirmation')
    assert.equal(starts, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('quality repair clearly separates a workflow block, paid continuation, saved local replay and unknown delivery without automatic requests', async t => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let starts = 0, revalidations = 0, inspections = 0, requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('a status render or confirmation must not POST') })
  const state: ScriptSourceAnalysis = { ...analysis, status: 'failed', phase: 'synthesis',
    story: { summary: '已保存全剧信息。', characters: [], timeline: [], threads: [], ending: { summary: '终场', section_ids: [0] }, uncertainties: [] },
    failure: { stage: 'recovery', message: '恢复执行身份已变化，不能重复派发' },
    resume: { available: true, action: 'continue', message: '目录及全剧信息保留。',
      next: { phase: 'quality_repair', response: 'not_started', model_required: true } } }
  const render = (unavailable = false) => act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }}
    starting={false} unavailable={unavailable} pollError={false} onStart={() => { starts++ }} onRevalidate={() => { revalidations++ }} onResolveRequest={() => { inspections++ }} /></MantineProvider>))
  try {
    await render()
    const shown = visibleAnalysisText(container)
    assert.match(shown, /请求或执行流程暂时阻断/)
    assert.match(shown, /当前任务 定点修补核对意见/)
    assert.match(shown, /尚无完整回答.*调用所选模型.*用量/)
    assert.doesNotMatch(shown, /部分分析内容尚未通过核对|剧本内容质量不合格|恢复执行身份/)
    assert.equal(starts, 0); assert.equal(requests, 0)
    await act(() => button('继续生成未完成项').click())
    assert.equal(starts, 0)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /调用所选模型完成定点修补核对意见.*模型用量/)
    await act(() => button('取消').click())
    assert.equal(starts, 0); assert.equal(requests, 0)

    await act(() => button('继续生成未完成项').click())
    state.resume = { available: true, action: 'revalidate', message: '先核对保存回答。',
      next: { phase: 'quality_repair', response: 'saved_response', model_required: false } }
    await render(true)
    assert.equal(document.querySelector('[role="dialog"]'), null, 'new saved-response metadata invalidates an old model confirmation')
    assert.match(visibleAnalysisText(container), /完整回答.*本地重新校验，不调用模型/)
    assert.equal(button('重新校验保存回答').disabled, false)
    await act(() => button('重新校验保存回答').click())
    assert.equal(revalidations, 1); assert.equal(starts, 0); assert.equal(requests, 0)

    state.resume = { available: false, blocked: true, action: 'reconcile_request', message: '等待完整回答。',
      next: { phase: 'quality_repair', response: 'unknown_response', model_required: false } }
    await render(true)
    assert.equal(button('继续生成未完成项'), undefined)
    assert.equal(button('检查并恢复').disabled, false)
    await act(() => button('检查并恢复').click())
    assert.equal(inspections, 1); assert.equal(revalidations, 1); assert.equal(starts, 0); assert.equal(requests, 0)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('recovery diagnostics identify request or process blocking without presenting a manuscript-quality verdict', async () => {
  const { ScriptSourceAnalysisStatus } = await import('../src/features/script/ScriptSourceAnalysisView')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const state: ScriptSourceAnalysis = { ...analysis, status: 'failed', failure: { stage: 'recovery', message: '原恢复许可与当前检查点不匹配' },
    resume: { available: false, action: 'blocked', message: '先核对检查点。' } }
  try {
    await act(() => root.render(<MantineProvider env="test"><ScriptSourceAnalysisStatus source={{ ...source, analysis: state }} starting={false} unavailable={false} pollError={false}
      onStart={() => assert.fail('inspecting a program failure cannot start generation')} /></MantineProvider>))
    assert.match(visibleAnalysisText(container), /请求或执行流程暂时阻断/)
    assert.doesNotMatch(visibleAnalysisText(container), /保存回答尚未通过校验|部分分析内容尚未通过核对/)
    await act(() => button('查看校验问题').click())
    assert.match(container.querySelector('.sd-analysis-diagnostic-list')!.textContent!, /请求或流程阻断：原恢复许可与当前检查点不匹配/)
    assert.doesNotMatch(container.querySelector('.sd-analysis-diagnostic-list')!.textContent!, /内容核对未通过/)
    assert.match(container.textContent!, /这是请求、授权或执行流程的阻断，不表示剧本内容质量不合格/)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('server-classified ordinary hints permit explicit creation without retrying analysis or erasing retained information', async t => {
  dom.window.localStorage.clear()
  const ready: ScriptSourceAnalysis = { ...analysis, status: 'ready', phase: 'ready',
    quality: { input_hash: 'current-review', status: 'issues', findings: [{ kind: 'omission', explanation: '可选细节待作者决定。', unit_ids: [0] }] },
    quality_summary: { handled: 1, total: 1, modified: 0, retained: 1, uncertain: 0, review: 'issues', access: 'usable', blocking: 0, advisory: 1, section_ids: [] } }
  const api = mockApi(t, { ...source, analysis: ready }), view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '保留未确定的细节，继续讨论故事。'))
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    assert.match(view.container.textContent!, /地图已就绪/)
    assert.equal(api.calls.length, 0); assert.equal(api.analysisStarts, 0)
    await act(() => pressEnter(field)); await settle()
    assert.equal(api.calls.length, 1); assert.equal(api.analysisStarts, 0)
    assert.equal(api.saved!.analysis!.quality!.status, 'issues')
    assert.equal(api.saved!.analysis!.quality_summary!.retained, 1)
  } finally { await view.destroy() }
})

test('a scoped optional audit does not lock global discussion or erase retained findings', async t => {
  dom.window.localStorage.clear()
  const ready: ScriptSourceAnalysis = { ...analysis, status: 'ready', phase: 'ready',
    quality: { input_hash: 'scoped-review', status: 'issues', findings: [{ kind: 'causality', explanation: '第二集的一处条件待核实。', unit_ids: [1] }] },
    quality_summary: { handled: 1, total: 1, modified: 0, retained: 1, uncertain: 0, review: 'issues', access: 'scoped', blocking: 0, advisory: 0, section_ids: [1] } }
  const api = mockApi(t, { ...source, analysis: ready }), view = await mount()
  try {
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本创作对话"]')!
    await act(() => typeMessage(field, '请讨论全剧的表达风格。'))
    assert.equal(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled, false)
    await act(() => pressEnter(field)); await settle()
    assert.equal(api.calls.length, 1); assert.equal(api.analysisStarts, 0)
    assert.equal(api.saved!.analysis!.quality_summary!.access, 'scoped')
    assert.equal(api.saved!.analysis!.quality!.findings.length, 1)
  } finally { await view.destroy() }
})


test('restored source page retains the original five-stage creation controls without episode-production cards', async t => {
  dom.window.localStorage.clear()
  const api = mockApi(t, { ...source, analysis: { ...analysis, status: 'ready', resume: undefined } }), view = await mount()
  try {
    assert.equal(api.calls.length, 0)
    assert.equal(view.container.querySelector('.sd-source-production'), null)
    assert.equal(view.container.querySelector('.sd-source-extraction'), null)
    assert.ok(view.container.querySelector('[aria-label="阶段处理"]'))
    assert.equal(view.container.querySelector('.sd-source-context-toggle')!.getAttribute('aria-expanded'), 'false')
    assert.equal(button('故事大纲').disabled, false)
    await act(() => button('故事大纲').click()); await settle()
    assert.equal(api.calls.length, 1)
    assert.deepEqual(api.calls[0]!.workflow, { stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: [...scriptStageArtifacts.outline] })
    assert.equal(api.analysisStarts, 0)
  } finally { await view.destroy() }
})
