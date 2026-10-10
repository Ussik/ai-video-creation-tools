import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { Editor, getSchema } from '@tiptap/core'
import { MantineProvider } from '@mantine/core'
import { textEditorExtensions } from '../src/text-editor'
import { serializeScriptDocument } from '../src/script-rich-document'
import { findScriptTextMatches, highlightScriptSearch, resolveScriptArtifactDocument, ScriptSearchHighlight, searchScriptDocuments } from '../src/script-document-search'
import type { ProjectDetail } from '../src/api'

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
const { default: ScriptEditor } = await import('../src/ScriptEditor')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const schema = getSchema(textEditorExtensions())
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

test('search decorations preserve content, selection, update events and edit undo/redo', () => {
  const element = document.createElement('div'); document.body.append(element)
  const editor = new Editor({ element, content: resolveScriptArtifactDocument('凛在**地下**交通枢纽。'), extensions: [...textEditorExtensions(), ScriptSearchHighlight] })
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
].map(item => ({ ...item, status: 'ready' }))
const detail = { id: 'search-project', name: '搜索测试', brief: '', ratio: '9:16', script: { outline: '', characters: '', scenes: [], artifacts, generation_options: {} }, shots: [], jobs: [], assets: [] } as unknown as ProjectDetail

async function mount() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const dirtyStates: boolean[] = []
  await act(async () => root.render(<MantineProvider env="test"><ScriptEditor detail={detail} models={[]} providers={[]} onRefresh={async () => detail} onOpenModels={() => {}} onOpenCanvas={() => {}} onNotice={() => {}} onDirtyChange={dirty => dirtyStates.push(dirty)} /></MantineProvider>))
  return { container, dirtyStates, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(result, label); return result
}
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
    assert.equal(view.container.querySelector('.script-search-caption > span')?.textContent, '人物小传')
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
