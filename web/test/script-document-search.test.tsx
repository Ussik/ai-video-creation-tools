import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { Editor, getSchema } from '@tiptap/core'
import { MantineProvider } from '@mantine/core'
import { scriptEditorExtensions } from '../src/features/script/script-editor-extensions'
import { parseScriptDocument, serializeScriptDocument } from '../src/features/script/script-rich-document'
import { textDocumentText } from '../src/shared/lib/editor/text-document'
import { findScriptTextMatches, highlightScriptSearch, resolveScriptArtifactDocument, ScriptSearchHighlight, searchScriptDocuments } from '../src/features/script/script-document-search'
import type { ProjectDetail } from '../src/shared/api/api'
import type { DocumentSection } from '../src/features/script/ScriptEditor'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => rect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [] })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptEditor } = await import('../src/features/script/ScriptEditor')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const schema = getSchema(scriptEditorExtensions())
const parse = (text: string) => schema.nodeFromJSON(resolveScriptArtifactDocument(text))

test('search spans formatting, uses literal case-insensitive text and preserves Unicode offsets', () => {
  const document = parse('# 人物\n\n凛在**地下**交通枢纽。\nA+B [x] İ ABC 😀凛')
  for (const query of ['地下交通', 'a+b', '[x]', 'abc', '😀凛', '凛']) {
    const matches = findScriptTextMatches(document, query)
    assert.ok(matches.length, query)
    for (const match of matches) assert.equal(document.textBetween(match.from, match.to).toLowerCase(), query.toLowerCase())
  }
  assert.deepEqual(findScriptTextMatches(document, '人物凛'), [], 'does not join separate blocks')
  assert.deepEqual(findScriptTextMatches(document, '枢纽。A+B'), [], 'does not join hard breaks')
  assert.deepEqual(findScriptTextMatches(document, '  '), [])
  assert.deepEqual(findScriptTextMatches(document, '不存在'), [])
  assert.equal(findScriptTextMatches(document, '凛').length, 2)
})

test('document index includes hidden documents and resolves current rich edits instead of stale Markdown', () => {
  const documents = [
    { id: 'outline', section: 'outline', title: '故事大纲', document: resolveScriptArtifactDocument('凛的故事') },
    { id: 'people', section: 'characters', title: '人物小传', document: resolveScriptArtifactDocument('凛的新设定', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧设定' }] }] }) },
    { id: 'episode', section: 'episode-2', title: '第2集', document: resolveScriptArtifactDocument('凛和救援者') },
  ]
  assert.deepEqual(searchScriptDocuments(documents, '凛').map(match => match.section), ['outline', 'characters', 'episode-2'])
  assert.equal(searchScriptDocuments(documents, '新设定').length, 1)
  assert.equal(searchScriptDocuments(documents, '旧设定').length, 0)
})

test('title removal resolves both saved rich documents and current Markdown before calculating search positions', () => {
  const rich = parseScriptDocument('# **概要设计**\n\n| 场所 | 行动 |\n| --- | --- |\n| 地下枢纽 | 凛在救援 |')
  rich.content!.unshift({ type: 'paragraph' })
  const original = JSON.stringify(rich)
  for (const content of [textDocumentText(rich), serializeScriptDocument(rich)]) {
    const body = resolveScriptArtifactDocument(content, rich, '概要设计')
    assert.equal(body.content![0], rich.content![2], 'preserves the actual rich table')
    const document = schema.nodeFromJSON(body)
    document.check()
    const [match] = findScriptTextMatches(document, '凛在救援')
    assert.equal(document.textBetween(match.from, match.to), '凛在救援')
    assert.deepEqual(findScriptTextMatches(document, '概要设计'), [])
  }
  const current = resolveScriptArtifactDocument('# 概要设计\n\n最新救援正文。', rich, '概要设计')
  assert.equal(textDocumentText(current), '最新救援正文。', 'stale rich content cannot replace new Markdown')
  assert.equal(JSON.stringify(rich), original)
})

test('search decorations preserve content, selection, update events and edit undo/redo', () => {
  const element = document.createElement('div'); document.body.append(element)
  const editor = new Editor({ element, content: resolveScriptArtifactDocument('凛在**地下**交通枢纽。'), extensions: [...scriptEditorExtensions(), ScriptSearchHighlight] })
  let updates = 0
  editor.on('update', () => { updates++ })
  try {
    editor.commands.setTextSelection(2)
    editor.commands.insertContent('新增')
    const edited = editor.getJSON(), selection = editor.state.selection.toJSON(), beforeUpdates = updates
    const matches = findScriptTextMatches(editor.state.doc, '地下交通')
    highlightScriptSearch(editor, '地下交通', matches[0])
    assert.equal(editor.view.dom.querySelectorAll('[data-script-search-active]').length, 2, 'highlight crosses a bold mark boundary')
    assert.deepEqual(editor.getJSON(), edited)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    assert.equal(updates, beforeUpdates)
    assert.doesNotMatch(serializeScriptDocument(editor.getJSON()), /script-search|data-script/)
    highlightScriptSearch(editor, '', null)
    assert.equal(editor.view.dom.querySelector('.script-search-match'), null)
    assert.equal(editor.commands.undo(), true)
    assert.equal(editor.state.doc.textContent, '凛在地下交通枢纽。')
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(editor.getJSON(), edited)
  } finally { editor.destroy(); element.remove() }
})

const artifacts = [
  { id: 'outline', artifact_type: 'outline', title: '概要设计', content: '# 故事\n\n凛的救援。', position: 0 },
  { id: 'world', artifact_type: 'world', title: '背景设定', content: '当代地下枢纽。', position: 1 },
  { id: 'people', artifact_type: 'characters', title: '全剧人物', content: '凛负责维持通路。', position: 2 },
  { id: 'locations', artifact_type: 'locations', title: '场景', content: '地下枢纽。', position: 3 },
  { id: 'props', artifact_type: 'props', title: '道具', content: '凛的封印。', position: 4 },
  { id: 'episode-2', artifact_type: 'episode_script', episode_number: 2, title: '第2集', content: '凛等待救援完成。', position: 5 },
  { id: 'relationships', artifact_type: 'relationships', title: '人物关系', content: '| 关系 | 性质 | 变化方向 |\n| --- | --- | --- |\n| 林晚与奶奶 | 亲情 | 依赖转为理解 |', position: 6 },
].map(item => ({ ...item, status: 'ready' }))
const detail = { id: 'search-project', name: '搜索测试', brief: '', ratio: '9:16', script: { outline: '', characters: '', scenes: [], artifacts, generation_options: {} }, shots: [], jobs: [], assets: [] } as unknown as ProjectDetail

async function mount(initialSection?: DocumentSection, projectDetail = detail) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const dirtyStates: boolean[] = []
  await act(async () => root.render(<MantineProvider env="test"><ScriptEditor detail={projectDetail} initialSection={initialSection} models={[]} providers={[]} onRefresh={async () => projectDetail} onOpenModels={() => {}} onOpenCanvas={() => {}} onNotice={() => {}} onDirtyChange={dirty => dirtyStates.push(dirty)} /></MantineProvider>))
  return { container, dirtyStates, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(result, label); return result
}

test('editor displays the model title once, searches its body and preserves content across editing and saving', async t => {
  const title = '城市救援 · 概要设计'
  const content = `# ${title}\n\n## 核心冲突\n\n凛在**地下**交通枢纽救援。`
  const modelDetail = { ...detail, script: { ...detail.script, artifacts: detail.script.artifacts!.map(artifact => artifact.artifact_type === 'outline' ? { ...artifact, title, content } : artifact) } }
  const view = await mount('outline', modelDetail)
  try {
    const section = view.container.querySelector('[data-script-section="outline"]')!
    assert.equal(section.querySelector('.script-long-section-heading h2')?.textContent, title)
    assert.equal(section.querySelectorAll('h1,h2,h3').length, 2)
    const element = section.querySelector<HTMLElement>('[role="textbox"]')!
    assert.equal(element.getAttribute('aria-label'), title)
    assert.equal(element.querySelector('h2')?.textContent, '核心冲突')
    assert.equal(element.querySelector('h1'), null)
    await act(() => button(view.container, '全文搜索').click())
    await fill(view.container, '地下交通')
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '1 / 1')
    assert.equal([...section.querySelectorAll('[data-script-search-active]')].map(node => node.textContent).join(''), '地下交通')
    assert.equal(view.container.querySelector('.script-search-caption > span')?.textContent, `故事大纲 · ${title}`)
    const editor = (element as HTMLElement & { editor: Editor }).editor
    const [match] = findScriptTextMatches(editor.state.doc, '地下交通')
    assert.equal(editor.state.doc.textBetween(match.from, match.to), '地下交通')
    assert.equal(view.dirtyStates.some(Boolean), false)
    assert.equal(modelDetail.script.artifacts![0].content, content, 'opening leaves saved Markdown intact')
    let payload: ProjectDetail['script'] | undefined
    t.mock.method(globalThis, 'fetch', async (_input: unknown, options?: RequestInit) => {
      payload = JSON.parse(String(options?.body))
      return Response.json({ ...modelDetail.script, ...payload })
    })
    await act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      editor.commands.insertContent('新增路线。')
    })
    assert.equal(view.dirtyStates.at(-1), true)
    await act(() => button(view.container, '保存').click())
    const savedArtifact = payload?.artifacts?.find(artifact => artifact.id === 'outline')
    assert.ok(savedArtifact)
    assert.equal(savedArtifact.title, title)
    assert.match(savedArtifact.content, /^## 核心冲突[\s\S]*\*\*地下\*\*[\s\S]*新增路线。/)
    assert.doesNotMatch(savedArtifact.content, /城市救援 · 概要设计/)
    for (const original of modelDetail.script.artifacts!.filter(artifact => artifact.id !== 'outline')) {
      assert.equal(payload?.artifacts?.find(artifact => artifact.id === original.id)?.content, original.content)
    }
    assert.equal(section.querySelectorAll('h1,h2,h3').length, 2)
    assert.equal(view.dirtyStates.at(-1), false)
  } finally { await view.destroy() }
})

test('editor groups and rendered chapters match generation stages without dirtying saved documents', async () => {
  const view = await mount()
  try {
    for (const stage of ['outline', 'characters', 'locations', 'props'] as const) {
      const group = view.container.querySelector(`[data-script-stage="${stage}"]`)!
      const children = [...group.querySelectorAll('.script-document-nav-item')].map(node => node.textContent)
      if (scriptStageArtifacts[stage].length > 1) assert.deepEqual(children, scriptStageArtifacts[stage].map(type => scriptArtifactLabels[type]))
      await act(() => group.querySelector<HTMLButtonElement>('.script-document-nav-primary')!.click())
      assert.deepEqual([...view.container.querySelectorAll('[data-script-section]')].map(node => (node as HTMLElement).dataset.scriptSection), [...scriptStageArtifacts[stage]])
      assert.ok(group.querySelector('.script-document-nav-primary.is-active'))
    }
    assert.doesNotMatch(view.container.textContent!, /人物清单|伏笔预设/)
    assert.equal(view.dirtyStates.some(Boolean), false)
  } finally { await view.destroy() }
})

test('relationship deep links and search stay in the character document with both chapters available', async () => {
  const view = await mount('relationships')
  try {
    assert.equal(view.container.querySelector('h1')?.textContent, '人物设定')
    assert.ok(view.container.querySelector('[data-script-section="characters"]'))
    assert.ok(view.container.querySelector('[data-script-section="relationships"] table'))
    assert.equal(view.container.querySelector('[data-script-section="outline"]'), null)
    assert.ok(view.container.querySelector('[data-script-stage="characters"] .script-document-nav-primary.is-active'))
    await act(() => button(view.container, '故事大纲').click())
    await act(() => button(view.container, '全文搜索').click())
    await fill(view.container, '奶奶')
    assert.equal(view.container.querySelector('.script-search-caption > span')?.textContent, '人物设定 · 人物关系')
    assert.ok(view.container.querySelector('[data-script-section="relationships"] [data-script-search-active]'))
    assert.ok(view.container.querySelector('[data-script-stage="characters"] .script-document-nav-item.is-active'))
    assert.equal(view.dirtyStates.some(Boolean), false)
  } finally { await view.destroy() }
})

test('legacy unnumbered screenplay remains readable and searchable alongside numbered episodes', async () => {
  const legacy = { ...detail, script: { ...detail.script, artifacts: [...detail.script.artifacts!, { id: 'legacy-script', project_id: detail.id, artifact_type: 'episode_script' as const, title: '旧版完整正文', content: '旧稿独有的桥段。', position: 8, status: 'ready' as const }] } }
  const view = await mount('episode_script', legacy)
  try {
    assert.equal(view.container.querySelector('h1')?.textContent, '旧版完整正文')
    assert.match(view.container.querySelector('[data-script-section="episode_script"]')!.textContent!, /旧稿独有/)
    await act(() => button(view.container, '第2集').click())
    assert.ok(view.container.querySelector('[data-script-section="episode-2"]'))
    await act(() => button(view.container, '全文搜索').click())
    await fill(view.container, '旧稿独有')
    assert.ok(view.container.querySelector('[data-script-section="episode_script"] [data-script-search-active]'))
    assert.equal(view.dirtyStates.some(Boolean), false)
  } finally { await view.destroy() }
})
async function fill(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索全部剧本文档"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function key(key: string, options: KeyboardEventInit = {}) {
  await act(() => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })))
}

test('page search switches across all documents, counts, wraps and closes without marking dirty', async () => {
  const view = await mount()
  try {
    await act(() => button(view.container, '全文搜索').click())
    assert.equal(document.activeElement?.getAttribute('aria-label'), '搜索全部剧本文档')
    await fill(view.container, '凛')
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '1 / 4')
    assert.equal(view.container.querySelector('[data-script-search-active]')?.textContent, '凛')
    await key('Enter')
    assert.ok(view.container.querySelector('[data-script-section="characters"] [data-script-search-active]'))
    assert.equal(view.container.querySelector('.script-search-caption > span')?.textContent, '人物设定 · 全剧人物')
    await act(() => button(view.container, '下一个搜索结果').click())
    assert.ok(view.container.querySelector('[data-script-section="props"] [data-script-search-active]'))
    await key('Enter')
    assert.ok(view.container.querySelector('[data-script-section="episode-2"] [data-script-search-active]'))
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '4 / 4')
    await key('Enter')
    assert.ok(view.container.querySelector('[data-script-section="outline"] [data-script-search-active]'))
    await key('Enter', { shiftKey: true })
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '4 / 4')
    await key('Escape')
    assert.equal(view.container.querySelector('[role="search"]'), null)
    assert.equal(view.container.querySelector('.script-search-match'), null)
    assert.equal(view.dirtyStates.some(Boolean), false)
  } finally { await view.destroy() }
})

test('keyboard opening, empty/no-match states, IME Enter and repeated shortcut keep search usable', async () => {
  const view = await mount()
  try {
    await key('f', { metaKey: true })
    assert.ok(view.container.querySelector('[role="search"]'))
    assert.equal(button(view.container, '下一个搜索结果').disabled, true)
    await fill(view.container, '凛')
    await key('Enter', { isComposing: true })
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '1 / 4')
    await act(() => button(view.container, '人物小传').click())
    await key('f', { ctrlKey: true })
    assert.equal(document.activeElement?.getAttribute('aria-label'), '搜索全部剧本文档')
    await fill(view.container, '不存在')
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '0 / 0')
    assert.match(view.container.querySelector('.script-search-caption')!.textContent!, /未找到匹配内容/)
    assert.equal(button(view.container, '上一个搜索结果').disabled, true)
    await fill(view.container, '')
    assert.equal(view.container.querySelector('.script-search-match'), null)
    await act(() => button(view.container, '关闭全文搜索').click())
    assert.equal(view.dirtyStates.some(Boolean), false)
  } finally { await view.destroy() }
})

test('search results track an unsaved edit and formatting undo/redo', async () => {
  const view = await mount()
  try {
    const editorElement = view.container.querySelector<HTMLElement>('[aria-label="概要设计"]')!
    const editor = (editorElement as HTMLElement & { editor: Editor }).editor
    assert.ok(editor)
    await act(() => { editor.commands.setTextSelection(1); editor.commands.insertContent('新增检索词') })
    assert.equal(view.dirtyStates.at(-1), true)
    await key('f', { ctrlKey: true })
    await fill(view.container, '新增检索词')
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '1 / 1')
    await act(() => button(view.container, '撤销').click())
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '0 / 0')
    await act(() => button(view.container, '重做').click())
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, '1 / 1')
    assert.equal(view.container.querySelector('[data-script-search-active]')?.textContent, '新增检索词')
  } finally { await view.destroy() }
})

test('table searches stay inside cells and use the same positions as the script editor', () => {
  const document = parse('| 关系 | 变化 |\n| --- | --- |\n| 林晚与奶奶 | 依赖转为**理解** |')
  const matches = findScriptTextMatches(document, '转为理解')
  assert.equal(matches.length, 1)
  assert.equal(document.textBetween(matches[0].from, matches[0].to), '转为理解')
  assert.deepEqual(findScriptTextMatches(document, '奶奶依赖'), [])
  assert.equal(searchScriptDocuments([{ id: 'relationships', section: 'relationships', title: '人物关系', document: document.toJSON() }], '奶奶').length, 1)
})

test('script page mounts tables without dirtying content and saves edited cells as reloadable Markdown', async () => {
  const originalFetch = globalThis.fetch
  let payload: { artifacts: Array<{ id?: string; artifact_type: string; episode_number?: number; title: string; content: string; document?: unknown }>; scenes: unknown[] } | undefined
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith('/script/commit')) {
      payload = JSON.parse(String(options?.body))
      return new Response(JSON.stringify({ ...detail.script, ...payload }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ policies: [] }), { headers: { 'content-type': 'application/json' } })
  }
  const view = await mount()
  try {
    await act(() => button(view.container, '人物关系').click())
    const element = view.container.querySelector<HTMLElement>('[role="textbox"][aria-label="人物关系"]')!
    assert.ok(element.querySelector('table'))
    assert.equal(view.dirtyStates.some(Boolean), false)
    const editor = (element as HTMLElement & { editor: Editor }).editor
    let position = 0
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === '依赖转为理解') position = pos })
    await act(() => {
      editor.commands.setTextSelection({ from: position, to: position + '依赖转为理解'.length })
      editor.commands.insertContent('误解转为信任')
    })
    assert.equal(view.dirtyStates.at(-1), true)
    await act(() => button(view.container, '保存').click())
    const artifact = payload?.artifacts.find(item => item.artifact_type === 'relationships')
    assert.equal(artifact?.id, 'relationships')
    assert.equal(artifact?.title, '人物关系')
    for (const original of artifacts.filter(item => item.artifact_type !== 'relationships')) {
      const saved = payload?.artifacts.find(item => item.id === original.id)
      assert.ok(saved, `retains ${original.id}`)
      assert.equal(saved.content, original.content)
      assert.equal(saved.title, original.title)
      assert.equal(saved.episode_number, original.episode_number)
    }
    assert.deepEqual(payload?.scenes, detail.script.scenes)
    assert.ok(artifact)
    assert.match(artifact.content, /\| 林晚与奶奶 \| 亲情 \| 误解转为信任 \|/)
    assert.equal(artifact.document, undefined, 'existing API still receives Markdown only')
    const saved = schema.nodeFromJSON(resolveScriptArtifactDocument(artifact.content))
    saved.check()
    assert.equal(findScriptTextMatches(saved, '误解转为信任').length, 1)
    assert.equal(view.dirtyStates.at(-1), false)
    assert.equal(view.container.querySelector('[aria-label="人物关系"] td:last-child')?.textContent, '误解转为信任')
  } finally { await view.destroy(); globalThis.fetch = originalFetch }
})
