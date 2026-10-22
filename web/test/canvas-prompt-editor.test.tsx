import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Editor } from '@tiptap/core'
import type { CanvasPromptEditorProps, CanvasPromptReference } from '../src/features/canvas/CanvasPromptEditor'
import { isPromptSectionDocument, parsePromptSectionDocument, serializePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
const rect = { left: 60, top: 40, right: 61, bottom: 60, width: 1, height: 20, x: 60, y: 40, toJSON: () => ({}) }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
const originalElementRect = dom.window.HTMLElement.prototype.getBoundingClientRect
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return this.matches('.pc-prompt-editor-content')
    ? { left: 20, top: 20, right: 660, bottom: 360, width: 640, height: 340, x: 20, y: 20, toJSON: () => ({}) }
    : originalElementRect.call(this)
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { default: PromptEditor, promptEditorDocument, promptEditorText, promptEditorSectionDocument } = await import('../src/features/canvas/CanvasPromptEditor')
after(() => dom.window.close())
const references: CanvasPromptReference[] = [
  { assetId: 'base', label: '角色基础', url: '/base.png', required: true },
  { assetId: 'look', label: '雨衣状态', url: '/look.png' },
]
const choices: CanvasPromptReference[] = [...references, { assetId: 'night', label: '夜景车站', url: '/night.png' }]
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(result, label); return result
}
async function settle() { await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 25)) }) }
async function openMention(editor: Editor) {
  await act(() => editor.chain().setTextSelection(editor.state.doc.content.size - 1).insertContent('@').run())
}
async function mount(value: string, extra: Partial<CanvasPromptEditorProps> = {}) {
  const changes: string[] = [], sectionChanges: PromptSectionDocument[] = [], referenceChanges: Array<[string, string | null]> = [], referenceAdds: CanvasPromptReference[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const [text, setText] = useState(value)
    const [sections, setSections] = useState(extra.sectionDocument)
    return <MantineProvider env="test"><PromptEditor value={text} references={references} choices={choices}
      onChange={(next, document) => { changes.push(next); setText(next); if (document) { sectionChanges.push(document); setSections(document) } }} onReferenceChange={(id, replacement) => { referenceChanges.push([id, replacement]) }}
      onReferenceAdd={reference => { referenceAdds.push(reference) }} {...extra} sectionDocument={sections} /></MantineProvider>
  }
  await act(() => root.render(<Harness />)); await settle()
  const element = container.querySelector('[contenteditable]') as HTMLElement & { editor: Editor }
  assert.ok(element?.editor)
  return { container, element, editor: element.editor, changes, sectionChanges, referenceChanges, referenceAdds, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function referencePosition(editor: Editor, assetId: string) {
  let result = -1
  editor.state.doc.descendants((node, position) => { if (node.type.name === 'promptReference' && node.attrs.assetId === assetId) result = position })
  assert.ok(result >= 0, assetId); return result
}

test('legacy image numbers and stable tokens render as chips without rewriting the saved prompt', async () => {
  const value = '参考图 1、2 保持人物\n图片2用于服装\n[[ref:night]]\n参考图9保留原句\n'
  const parsed = promptEditorDocument(value, references, choices)
  assert.equal(promptEditorText(parsed), '[[ref:base]]、[[ref:look]] 保持人物\n[[ref:look]]用于服装\n[[ref:night]]\n参考图9保留原句\n')
  const view = await mount(value)
  try {
    assert.equal(view.container.querySelectorAll('.pc-prompt-reference').length, 4)
    assert.equal(view.container.querySelectorAll('.pc-prompt-editor-content > p').length, 5)
    assert.match(view.element.textContent!, /角色基础/)
    assert.match(view.element.textContent!, /夜景车站/)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.insertContentAt(view.editor.state.doc.content.size - 1, '结束'))
    assert.match(view.changes.at(-1)!, /\[\[ref:night\]\]/)
  } finally { await view.destroy() }
})

test('image resolutions remain plain text instead of becoming numbered references', async () => {
  const value = '图片4K、图片1080p、参考图2K，参考图 2 用于服装'
  const manyReferences = Array.from({ length: 1_080 }, (_, index) => ({ assetId: `image-${index + 1}`, label: `图片 ${index + 1}`, url: `/image-${index + 1}.png` }))
  const parsed = promptEditorDocument(value, manyReferences)
  assert.equal(promptEditorText(parsed), '图片4K、图片1080p、参考图2K，[[ref:image-2]] 用于服装')
  const view = await mount(value)
  try {
    assert.equal(view.container.querySelectorAll('.pc-prompt-reference').length, 1)
    assert.match(view.element.textContent!, /图片4K、图片1080p、参考图2K/)
  } finally { await view.destroy() }
})

test('bare image labels use the same stable references as legacy labels and preserve unknown numbers', async () => {
  const value = '图1用于人物，图 2用于服装；图1、2保持一致；图1/图2。\n图9保留原句，图4K和图1080p保持清晰度。\n[[ref:night]]'
  const expected = '[[ref:base]]用于人物，[[ref:look]]用于服装；[[ref:base]]、[[ref:look]]保持一致；[[ref:base]]/[[ref:look]]。\n图9保留原句，图4K和图1080p保持清晰度。\n[[ref:night]]'
  assert.equal(promptEditorText(promptEditorDocument(value, references, choices)), expected)
  const view = await mount(value)
  try {
    assert.equal(view.container.querySelectorAll('.pc-prompt-reference').length, 7)
    assert.match(view.element.textContent!, /图9保留原句，图4K和图1080p保持清晰度/)
    assert.deepEqual(view.changes, [])
    await act(() => view.editor.commands.insertContentAt(view.editor.state.doc.content.size - 1, ' 完成'))
    assert.equal(view.changes.at(-1), `${expected} 完成`)
    assert.deepEqual(view.referenceChanges, [])
    assert.deepEqual(view.referenceAdds, [])
  } finally { await view.destroy() }
})

test('bounded system text stays editable and accepts manual @ references inside the block', async () => {
  const value = '主体画面\n\n【镜头视觉设定】\n保持身份，服装参考\n【镜头视觉设定结束】'
  const view = await mount(value)
  try {
    assert.equal(view.element.getAttribute('aria-readonly'), 'false')
    let insertionPosition = -1
    view.editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === '保持身份，服装参考') insertionPosition = position + node.nodeSize
    })
    assert.ok(insertionPosition >= 0)
    await act(() => view.editor.chain().setTextSelection(insertionPosition).insertContent('@雨').run())
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(view.changes.at(-1), '主体画面\n\n【镜头视觉设定】\n保持身份，服装参考[[ref:look]] \n【镜头视觉设定结束】')
    await act(() => view.editor.commands.insertContentAt(1, '修改后的'))
    assert.match(view.changes.at(-1)!, /^修改后的主体画面/)
    assert.match(view.changes.at(-1)!, /【镜头视觉设定】\n保持身份，服装参考\[\[ref:look\]\] \n【镜头视觉设定结束】$/)
    assert.deepEqual(view.referenceChanges, [])
    assert.deepEqual(view.referenceAdds, [])
  } finally { await view.destroy() }
})

test('the @ picker filters typed text, supports keyboard selection and preserves text on dismissal', async () => {
  const view = await mount('镜头 ')
  try {
    assert.equal(view.container.querySelector('[aria-label="插入图片引用"]'), null)
    await act(() => view.editor.commands.insertContentAt(4, '@夜'))
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    assert.match(document.querySelector('[role="option"]')!.textContent!, /夜景车站/)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await settle()
    assert.equal(view.changes.at(-1), '镜头 [[ref:night]] ')
    assert.equal(document.querySelector('[role="listbox"]'), null)
    assert.deepEqual(view.referenceChanges, [])
    await openMention(view.editor)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    assert.match(document.querySelector('[role="option"][aria-selected="true"]')!.textContent!, /雨衣状态/)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(document.querySelector('[role="listbox"]'), null)
  } finally { await view.destroy() }
})

test('the @ picker follows its text position on scroll and resumes after scrolling back into view', async t => {
  const view = await mount('前文说明\n镜头 ')
  let caret = { left: 127, right: 127, top: 95, bottom: 115 }
  const positions: number[] = []
  t.mock.method(view.editor.view, 'coordsAtPos', (position: number) => { positions.push(position); return caret })
  try {
    const mentionPosition = view.editor.state.doc.content.size - 1
    await openMention(view.editor)
    const anchor = () => document.querySelector<HTMLElement>('.pc-prompt-mention-anchor')!
    assert.equal(positions.at(-1), mentionPosition, 'the anchor uses the typed @, rather than the entire editor')
    assert.equal(anchor().style.left, '127px')
    assert.equal(anchor().style.top, '95px')
    assert.equal(anchor().style.height, '20px')
    assert.ok(document.querySelector('[role="listbox"]'))

    caret = { ...caret, top: 120, bottom: 140 }
    await act(() => view.element.dispatchEvent(new dom.window.Event('scroll'))); await settle()
    assert.equal(anchor().style.top, '120px')

    caret = { ...caret, top: 450, bottom: 470 }
    await act(() => view.element.dispatchEvent(new dom.window.Event('scroll'))); await settle()
    assert.equal(document.querySelector('[role="listbox"]'), null, 'a clipped @ has no detached picker')

    caret = { ...caret, top: 80, bottom: 100 }
    await act(() => view.element.dispatchEvent(new dom.window.Event('scroll'))); await settle()
    assert.equal(anchor().style.top, '80px')
    assert.ok(document.querySelector('[role="listbox"]'), 'scrolling back preserves the mention selection')
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(view.changes.at(-1), '前文说明\n镜头 [[ref:base]] ')
  } finally { await view.destroy() }
})

test('chip replacement and removal update all matching tokens and notify actual input changes', async () => {
  const view = await mount('[[ref:look]] 正面\n[[ref:look]] 背面')
  try {
    await act(() => button('编辑图片引用：雨衣状态').click())
    await act(() => button('夜景车站').click())
    assert.equal(view.changes.at(-1), '[[ref:night]] 正面\n[[ref:night]] 背面')
    assert.deepEqual(view.referenceChanges, [['look', 'night']])
    await act(() => button('编辑图片引用：夜景车站').click())
    await act(() => button('移除此引用').click())
    assert.equal(view.changes.at(-1), ' 正面\n 背面')
    assert.deepEqual(view.referenceChanges.at(-1), ['night', null])
  } finally { await view.destroy() }
})

test('keyboard deletion and cut notify removals, and undo restores both token and actual reference', async () => {
  const view = await mount('使用 [[ref:look]]')
  try {
    const position = referencePosition(view.editor, 'look')
    await act(() => view.editor.chain().setTextSelection({ from: position, to: position + 1 }).deleteSelection().run())
    assert.equal(view.changes.at(-1), '使用 ')
    assert.deepEqual(view.referenceChanges, [['look', null]])
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), '使用 [[ref:look]]')
    assert.deepEqual(view.referenceChanges.at(-1), ['look', 'look'])
    await act(() => view.editor.commands.redo())
    assert.deepEqual(view.referenceChanges.at(-1), ['look', null])
  } finally { await view.destroy() }
})

test('required references allow inspection and reject replacement, removal, or range deletion', async () => {
  const view = await mount('保持 [[ref:base]] 人物')
  try {
    await act(() => button('查看图片引用：角色基础').click())
    assert.match(document.querySelector('.pc-prompt-reference-menu')!.textContent!, /必需引用/)
    assert.equal(document.querySelector('[aria-label="搜索替换图片"]'), null)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '移除此引用'), false)
    await act(() => view.editor.chain().selectAll().deleteSelection().run())
    assert.equal(promptEditorText(view.editor.getJSON()), '保持 [[ref:base]] 人物')
    assert.deepEqual(view.referenceChanges, [])
    assert.deepEqual(view.changes, [])
  } finally { await view.destroy() }
})

test('plain multiline text edits preserve composition keys and undo without inserting formatting', async () => {
  const view = await mount('首行\n次行')
  try {
    await act(() => view.editor.chain().setTextSelection(3).insertContent(' 中文').run())
    assert.equal(view.changes.at(-1), '首行 中文\n次行')
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    view.element.dispatchEvent(event)
    assert.equal(event.defaultPrevented, false)
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), '首行\n次行')
  } finally { await view.destroy() }
})

test('the @ picker defaults to active node references and adds other project images only through the explicit entry', async () => {
  const night = { ...choices[2], nodeId: 'night-node', description: '参考车站空间布局', provenance: '画布 2 · 场景节点' }
  const view = await mount('镜头 ', { choices: references, additionalChoices: [...references, night] })
  try {
    await openMention(view.editor)
    assert.equal(document.querySelectorAll('[role="option"]').length, 2)
    assert.doesNotMatch(document.querySelector('[role="listbox"]')!.textContent!, /夜景车站/)
    assert.deepEqual(view.referenceAdds, [])
    const otherEntryKey = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(() => button('添加其他参考').dispatchEvent(otherEntryKey))
    assert.equal(otherEntryKey.defaultPrevented, false)
    assert.equal(promptEditorText(view.editor.getJSON()), '镜头 @')
    await act(() => button('添加其他参考').click())
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    const option = document.querySelector<HTMLButtonElement>('[role="option"]')!
    assert.match(option.textContent!, /夜景车站/)
    assert.match(option.textContent!, /参考车站空间布局/)
    assert.match(option.textContent!, /画布 2 · 场景节点/)
    await act(() => option.click())
    assert.match(view.changes.at(-1)!, /\[\[ref:night\]\]/)
    assert.deepEqual(view.referenceAdds, [night])
    assert.deepEqual(view.referenceChanges, [])

    // A second mention of the same image must not establish another relationship.
    await openMention(view.editor)
    await act(() => button('添加其他参考').click())
    await act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click())
    assert.equal(view.referenceAdds.length, 1)
    assert.equal(view.changes.at(-1)!.match(/\[\[ref:night\]\]/g)!.length, 2)
  } finally { await view.destroy() }
})

test('replacing a chip with another project image emits one unified replacement instead of adding twice', async () => {
  const view = await mount('[[ref:look]]', { choices: references, additionalChoices: [choices[2]] })
  try {
    await act(() => button('编辑图片引用：雨衣状态').click())
    assert.doesNotMatch(document.querySelector('.pc-prompt-reference-options')!.textContent!, /夜景车站/)
    await act(() => button('添加其他参考').click())
    await act(() => button('夜景车站').click())
    assert.equal(view.changes.at(-1), '[[ref:night]]')
    assert.deepEqual(view.referenceChanges, [['look', 'night']])
    assert.deepEqual(view.referenceAdds, [])
  } finally { await view.destroy() }
})

test('node reference choices can be searched by usage and source metadata', async () => {
  const look = { ...references[1], nodeId: 'raincoat-node', description: '仅参考服装', provenance: '连线 · 人物节点' }
  const view = await mount('', { choices: [references[0], look] })
  try {
    await act(() => view.editor.commands.insertContentAt(1, '@服装'))
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    assert.match(document.querySelector('[role="option"]')!.textContent!, /雨衣状态仅参考服装连线 · 人物节点/)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(view.changes.at(-1), '[[ref:look]] ')
    assert.deepEqual(view.referenceAdds, [])
  } finally { await view.destroy() }
})

test('reference provenance enums display and search with their Chinese labels', async () => {
  const items = ['connection', 'binding', 'base', 'explicit'].map((provenance, index) => ({ assetId: `source-${index}`, label: `来源 ${index}`, url: `/source-${index}.png`, provenance }))
  const view = await mount('[[ref:source-0]]', { references: items, choices: items })
  try {
    assert.equal(view.editor.getJSON().content![0].content![0].attrs!.provenance, '连线参考')
    await openMention(view.editor)
    const labels = document.querySelector('[role="listbox"]')!.textContent!
    for (const label of ['连线参考', '镜头绑定', '基础设定', '项目素材']) assert.match(labels, new RegExp(label))
    assert.doesNotMatch(labels, /connection|binding|base|explicit/)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await act(() => view.editor.commands.insertContentAt(view.editor.state.doc.content.size - 1, '@镜头绑定'))
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    assert.match(document.querySelector('[role="option"]')!.textContent!, /来源 1镜头绑定/)
  } finally { await view.destroy() }
})

test('disconnected references remain visible and can reconnect without changing the saved prompt', async () => {
  const stale = { ...references[1], invalid: true, description: '参考连线已断开' }
  const view = await mount('保留 [[ref:look]]', { references: [stale], choices: [stale], additionalChoices: [references[1]] })
  try {
    assert.equal(view.container.querySelectorAll('.pc-prompt-reference.is-invalid').length, 1)
    await openMention(view.editor)
    assert.equal(document.querySelectorAll('[role="option"]').length, 0)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.deepEqual(view.referenceChanges, [])
    const promptBeforeReconnect = promptEditorText(view.editor.getJSON()), changesBeforeReconnect = [...view.changes]
    await act(() => button('编辑图片引用：雨衣状态').click())
    assert.match(document.querySelector('.pc-prompt-reference-menu')!.textContent!, /引用已失效/)
    await act(() => button('重新连接此参考').click())
    assert.deepEqual(view.referenceChanges, [['look', 'look']])
    assert.deepEqual(view.changes, changesBeforeReconnect)
    assert.equal(promptEditorText(view.editor.getJSON()), promptBeforeReconnect)
  } finally { await view.destroy() }
})

test('an explicitly selected project image can repair an invalid chip without duplicate add callbacks', async () => {
  const stale = { ...references[1], invalid: true }
  const view = await mount('[[ref:look]]', { references: [stale], choices: [stale], additionalChoices: [references[1]] })
  try {
    await openMention(view.editor)
    await act(() => button('添加其他参考').click())
    await act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click())
    assert.deepEqual(view.referenceChanges, [['look', 'look']])
    assert.deepEqual(view.referenceAdds, [])
  } finally { await view.destroy() }
})

test('a rejected relationship addition keeps the prompt unchanged and the picker open', async () => {
  const attempted: string[] = []
  const view = await mount('镜头 ', { choices: references, additionalChoices: [choices[2]], onReferenceAdd: reference => { attempted.push(reference.assetId); return false } })
  try {
    await openMention(view.editor)
    await act(() => button('添加其他参考').click())
    await act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click())
    assert.deepEqual(attempted, ['night'])
    assert.equal(promptEditorText(view.editor.getJSON()), '镜头 @')
    assert.deepEqual(view.changes, ['镜头 @'])
    assert.ok(document.querySelector('[role="listbox"]'))
  } finally { await view.destroy() }
})

test('a rejected chip replacement leaves its original reference and prompt intact', async () => {
  const attempted: Array<[string, string | null]> = []
  const view = await mount('[[ref:look]]', { onReferenceChange: (source, replacement) => { attempted.push([source, replacement]); return false } })
  try {
    await act(() => button('编辑图片引用：雨衣状态').click())
    await act(() => button('夜景车站').click())
    assert.deepEqual(attempted, [['look', 'night']])
    assert.equal(promptEditorText(view.editor.getJSON()), '[[ref:look]]')
    assert.deepEqual(view.changes, [])
  } finally { await view.destroy() }
})

test('adding a reference survives Tiptap flushing parent reference updates before the prompt echo', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const changes: string[] = [], added: string[] = []
  let replaceValue: (value: string) => void = () => {}
  function Harness() {
    const [text, setText] = useState('[[ref:look]] 保持人物')
    const [active, setActive] = useState([references[1]])
    replaceValue = setText
    return <MantineProvider env="test"><PromptEditor value={text} onChange={value => { changes.push(value); setText(value) }} references={active} choices={active}
      additionalChoices={choices.filter(item => !active.some(reference => reference.assetId === item.assetId))}
      // The new chip's ReactNodeView flushSync commits this update before onChange.
      onReferenceAdd={reference => { added.push(reference.assetId); setActive(current => [...current, reference]); return true }} /></MantineProvider>
  }
  await act(() => root.render(<Harness />)); await settle()
  const element = container.querySelector('[contenteditable]') as HTMLElement & { editor: Editor }
  try {
    await openMention(element.editor)
    await act(() => button('添加其他参考').click())
    const night = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent?.includes('夜景车站'))!
    await act(() => night.click()); await settle()
    assert.deepEqual(added, ['night'])
    assert.match(promptEditorText(element.editor.getJSON()), /\[\[ref:night\]\]/)
    assert.match(changes.at(-1)!, /\[\[ref:night\]\]/)
    assert.equal(container.querySelectorAll('.pc-prompt-reference').length, 2)
    // A later actual external value edit still replaces the editor document.
    await act(() => flushSync(() => replaceValue('外部替换 [[ref:look]]')))
    assert.equal(promptEditorText(element.editor.getJSON()), '外部替换 [[ref:look]]')
  } finally { await act(() => root.unmount()); container.remove() }
})

test('adding a reference inside a system block survives a synchronous parent rebuild of its reference manifest', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const changes: string[] = [], added: string[] = []
  const source = '主体画面\n\n【镜头视觉设定】\n材质参考\n【镜头视觉设定结束】'
  const manifest = '\n\n【生成参考图】\n[[ref:night]]：夜景车站\n【生成参考图结束】'
  function Harness() {
    const [text, setText] = useState(source)
    const [active, setActive] = useState([references[1]])
    return <MantineProvider env="test"><PromptEditor value={`${text}${active.some(reference => reference.assetId === 'night') ? manifest : ''}`}
      references={active} choices={active} additionalChoices={[choices[2]]}
      onChange={value => { changes.push(value); setText(value.replace(manifest, '')) }}
      onReferenceAdd={reference => { added.push(reference.assetId); flushSync(() => setActive(current => [...current, reference])); return true }} /></MantineProvider>
  }
  await act(() => root.render(<Harness />)); await settle()
  const element = container.querySelector('.pc-prompt-editor-content') as HTMLElement & { editor: Editor }
  try {
    let position = -1
    element.editor.state.doc.descendants((node, offset) => {
      if (node.isText && node.text === '材质参考') position = offset + node.nodeSize
    })
    assert.ok(position >= 0)
    await act(() => element.editor.chain().setTextSelection(position).insertContent('@').run())
    await act(() => button('添加其他参考').click())
    await act(() => document.querySelector<HTMLButtonElement>('[role="option"]')!.click()); await settle()
    assert.deepEqual(added, ['night'])
    assert.match(changes.at(-1)!, /【镜头视觉设定】\n材质参考\[\[ref:night\]\] \n【镜头视觉设定结束】/)
    assert.equal(promptEditorText(element.editor.getJSON()), `${source.replace('材质参考', '材质参考[[ref:night]] ')}${manifest}`)
    assert.equal(container.querySelectorAll('.pc-prompt-reference').length, 2)
  } finally { await act(() => root.unmount()); container.remove() }
})

const editableSection = '【镜头视觉设定】\n保留[[ref:look]]的衣物纹理。\n【镜头视觉设定结束】'
const sectionText = `前文保持空行。\n\n${editableSection}\n\n末尾正文。\n`

function sectionPosition(editor: Editor) {
  let result = -1
  editor.state.doc.forEach((node, position) => { if (node.type.name === 'promptManagedSection') result = position })
  assert.ok(result >= 0)
  return result
}

test('legacy section text becomes one structured block with fixed chrome and exact source-aware serialization', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.sourceStatus = 'source_changed'
  managed.pendingSourceText = editableSection.replace('纹理', '褶皱')
  const parsed = promptEditorDocument(sectionText, references, choices, sections)
  assert.equal(promptEditorText(parsed), sectionText)
  assert.equal(parsed.content!.filter(node => node.type === 'promptManagedSection').length, 1)
  assert.deepEqual(promptEditorSectionDocument(parsed, sections).blocks.find(block => block.kind === 'managed'), managed)
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    const block = view.container.querySelector('.pc-prompt-managed-section')!
    assert.equal(block.getAttribute('data-prompt-section-id'), managed.id)
    assert.equal(block.querySelector('.pc-prompt-managed-section-head')!.getAttribute('contenteditable'), 'false')
    assert.equal(block.querySelector('.pc-prompt-managed-section-end')!.getAttribute('contenteditable'), 'false')
    assert.ok(block.querySelector('[data-node-view-content]'))
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.deepEqual(view.changes, [])
    await act(() => view.editor.commands.insertContentAt(referencePosition(view.editor, 'look') + 1, '补充'))
    const updated = view.sectionChanges.at(-1)!
    assert.ok(isPromptSectionDocument(updated))
    assert.equal(serializePromptSectionDocument(updated), view.changes.at(-1))
    assert.equal(updated.blocks.find(block => block.kind === 'managed')!.id, managed.id)
    assert.equal(updated.blocks.find(block => block.kind === 'managed')!.sourceText, managed.sourceText)
    assert.equal(updated.blocks.find(block => block.kind === 'managed')!.pendingSourceText, managed.pendingSourceText)
    assert.equal(updated.blocks.find(block => block.kind === 'managed')!.sourceStatus, 'source_changed')
  } finally { await view.destroy() }
})

test('chip replacement and removal rewrite section source snapshots before emitting the authored document', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.sourceStatus = 'source_changed'
  managed.pendingSourceText = editableSection.replace('纹理', '褶皱')
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    await act(() => button('编辑图片引用：雨衣状态').click())
    await act(() => button('夜景车站').click()); await settle()
    const replaced = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(replaced.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', '[[ref:night]]'))
    assert.equal(replaced.pendingSourceText, managed.pendingSourceText.replaceAll('[[ref:look]]', '[[ref:night]]'))
    assert.equal(replaced.sourceStatus, 'source_changed')
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), view.changes.at(-1))
    await act(() => button('编辑图片引用：夜景车站').click())
    await act(() => button('移除此引用').click()); await settle()
    const removed = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(removed.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', ''))
    assert.equal(removed.pendingSourceText, managed.pendingSourceText.replaceAll('[[ref:look]]', ''))
    assert.deepEqual(view.referenceChanges, [['look', 'night'], ['night', null]])
  } finally { await view.destroy() }
})

test('keyboard chip deletion rewrites source snapshots and undo restores the same snapshots and reference', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.pendingSourceText = editableSection.replace('纹理', '褶皱')
  managed.sourceStatus = 'source_changed'
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    const position = referencePosition(view.editor, 'look')
    await act(() => view.editor.chain().setTextSelection({ from: position, to: position + 1 }).deleteSelection().run()); await settle()
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', ''))
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!.pendingSourceText, managed.pendingSourceText.replaceAll('[[ref:look]]', ''))
    assert.deepEqual(view.referenceChanges, [['look', null]])
    await act(() => view.editor.commands.undo()); await settle()
    const restored = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(restored.sourceText, managed.sourceText)
    assert.equal(restored.pendingSourceText, managed.pendingSourceText)
    assert.equal(restored.sourceStatus, managed.sourceStatus)
    assert.deepEqual(view.referenceChanges.at(-1), ['look', 'look'])
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', ''))
    assert.deepEqual(view.referenceChanges.at(-1), ['look', null])
  } finally { await view.destroy() }
})

test('backspace, delete and cross-block range deletion cannot erase a structured section boundary', async () => {
  const view = await mount(sectionText)
  try {
    const position = sectionPosition(view.editor), node = view.editor.state.doc.nodeAt(position)!
    await act(() => view.editor.commands.setTextSelection(position + 2))
    const backspace = new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    await act(() => view.element.dispatchEvent(backspace))
    assert.equal(backspace.defaultPrevented, true)
    await act(() => view.editor.commands.setTextSelection(position + node.nodeSize - 2))
    const deleteKey = new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    await act(() => view.element.dispatchEvent(deleteKey))
    assert.equal(deleteKey.defaultPrevented, true)
    await act(() => view.editor.chain().selectAll().deleteSelection().run())
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('an explicit programmatic document replacement can clear managed sections without disconnecting references', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    await act(() => view.editor.chain().setMeta('promptDocumentReplace', true)
      .setContent(promptEditorDocument('', references, choices), { emitUpdate: true }).run()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), '')
    assert.equal(view.changes.at(-1), '')
    const removed = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(removed.deleted, true)
    assert.equal(removed.sourceText, managed.sourceText)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('explicit section removal records a reversible tombstone while keeping all image connections', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    await act(() => button('移除区块：镜头视觉设定').click()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    assert.equal(view.changes.at(-1), sectionText.replace(editableSection, ''))
    const deleted = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.text, '')
    assert.equal(deleted.sourceText, editableSection)
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.equal(view.container.querySelector('.pc-prompt-managed-section')!.getAttribute('data-prompt-section-id'), managed.id)
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!.deleted, undefined)
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!.deleted, true)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('section content supports paragraph breaks and undo without exposing its marker text as editable prose', async () => {
  const view = await mount(sectionText)
  try {
    const position = referencePosition(view.editor, 'look')
    await act(() => view.editor.chain().setTextSelection(position + 1).splitBlock().run())
    assert.equal(view.changes.at(-1), sectionText.replace('[[ref:look]]的衣物', '[[ref:look]]\n的衣物'))
    assert.equal(view.editor.state.doc.child(view.editor.state.doc.content.findIndex(sectionPosition(view.editor)).index).type.name, 'promptManagedSection')
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section').length, 1)
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section-content p').length, 2)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    await act(() => view.editor.commands.redo()); await settle()
    assert.match(promptEditorText(view.editor.getJSON()), /\[\[ref:look\]\]\n的衣物/)
  } finally { await view.destroy() }
})

test('copying and pasting a whole section preserves its markers and gives the new block a separate identity', async () => {
  const view = await mount(sectionText)
  try {
    const position = sectionPosition(view.editor), node = view.editor.state.doc.nodeAt(position)!
    const slice = view.editor.state.doc.slice(position, position + node.nodeSize)
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(slice, view.editor.view))
    assert.equal(copied, editableSection)
    await act(() => view.editor.commands.setTextSelection(view.editor.state.doc.content.size - 1))
    await act(() => view.editor.view.pasteText(`\n${copied}\n`, new dom.window.Event('paste') as ClipboardEvent)); await settle()
    const blocks = [...view.container.querySelectorAll('.pc-prompt-managed-section')]
    assert.equal(blocks.length, 2)
    assert.notEqual(blocks[0].getAttribute('data-prompt-section-id'), blocks[1].getAttribute('data-prompt-section-id'))
    assert.equal((view.changes.at(-1)!.match(/【镜头视觉设定】/g) || []).length, 2)
    assert.ok(isPromptSectionDocument(view.sectionChanges.at(-1)))
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), view.changes.at(-1))
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('read-only sections retain their fixed boundaries and cannot use the explicit remove action', async () => {
  const view = await mount(sectionText, { readOnly: true })
  try {
    assert.equal(view.editor.isEditable, false)
    assert.equal(button('移除区块：镜头视觉设定').disabled, true)
    await act(() => button('移除区块：镜头视觉设定').click())
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.deepEqual(view.changes, [])
  } finally { await view.destroy() }
})

test('compact section presentation preserves source separators, metadata and clipboard text without emitting edits', async () => {
  const visual = '【设定图固定要求】\n保留主体身份与衣物纹理。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n低饱和配色，统一渲染方式。\n【项目画风约束结束】'
  const value = `补充主体描述。\n\n\n${visual}\n\n \n\n${style}\n\n结尾说明。`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.sourceStatus = 'source_changed'
  managed.pendingSourceText = visual.replace('纹理', '褶皱')
  const originalSections = structuredClone(sections)
  const view = await mount(value, { sectionDocument: sections })
  try {
    const separators = [...view.element.querySelectorAll(':scope > p')].filter(paragraph => !paragraph.textContent?.trim())
    assert.ok(separators.length > 4, 'the original prompt contains several consecutive separator lines')
    assert.ok(separators.every(paragraph => paragraph.classList.contains('pc-prompt-section-spacer')))
    const blocks = [...view.container.querySelectorAll('.pc-prompt-managed-section')]
    assert.deepEqual(blocks.map(block => block.querySelector('.pc-prompt-managed-section-head > span')?.textContent), ['设定图固定要求', '项目画风约束'])
    assert.ok(blocks.every(block => block.querySelector('.pc-prompt-managed-section-end')?.getAttribute('aria-hidden') === 'true'))
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections), originalSections)
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(view.editor.state.doc.slice(0, view.editor.state.doc.content.size), view.editor.view))
    assert.equal(copied, value)
    assert.deepEqual(sections, originalSections)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
  } finally { await view.destroy() }
})

test('a compact section separator remains editable and restores its exact text through undo and redo', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const originalManaged = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    let position = -1
    view.editor.state.doc.forEach((node, offset) => {
      if (position < 0 && node.type.name === 'paragraph' && node.childCount === 0) position = offset + 1
    })
    assert.ok(position >= 0)
    const separator = () => view.editor.view.nodeDOM(position - 1) as HTMLElement
    assert.ok(separator().classList.contains('pc-prompt-section-spacer'))
    await act(() => view.editor.commands.setTextSelection(position))
    assert.ok(separator().classList.contains('is-current'), 'the selected separator exposes an editable line')
    assert.deepEqual(view.changes, [], 'moving the cursor changes presentation only')

    await act(() => view.editor.commands.insertContent('补充构图要求。')); await settle()
    const edited = sectionText.replace('\n\n', '\n补充构图要求。\n')
    assert.equal(promptEditorText(view.editor.getJSON()), edited)
    assert.equal(view.changes.at(-1), edited)
    assert.equal(separator().classList.contains('pc-prompt-section-spacer'), false)
    assert.equal(separator().textContent, '补充构图要求。')
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed'), originalManaged)

    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.ok(separator().classList.contains('pc-prompt-section-spacer'))
    assert.ok(separator().classList.contains('is-current'))
    assert.equal(view.changes.at(-1), sectionText)
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), edited)
    assert.equal(separator().classList.contains('pc-prompt-section-spacer'), false)
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), edited)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('ordinary prose spacing, section body spacing and reference-only paragraphs remain uncompressed', async () => {
  const section = '【镜头视觉设定】\n第一段设定。\n\n第二段设定。\n【镜头视觉设定结束】'
  const value = `正文第一行。\n\n正文第三行。\n[[ref:look]]\n${section}\n\n结尾正文。\n\n最后一句。`
  const view = await mount(value)
  try {
    const paragraphs = [...view.element.querySelectorAll(':scope > p')]
    const firstText = paragraphs.findIndex(paragraph => paragraph.textContent === '正文第一行。')
    const trailingText = paragraphs.findIndex(paragraph => paragraph.textContent === '结尾正文。')
    assert.equal(paragraphs[firstText + 1].textContent, '')
    assert.equal(paragraphs[firstText + 1].classList.contains('pc-prompt-section-spacer'), false)
    assert.equal(paragraphs[trailingText + 1].textContent, '')
    assert.equal(paragraphs[trailingText + 1].classList.contains('pc-prompt-section-spacer'), false)
    const reference = paragraphs.find(paragraph => paragraph.querySelector('.pc-prompt-reference'))!
    assert.ok(reference)
    assert.equal(reference.classList.contains('pc-prompt-section-spacer'), false)
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section-content .pc-prompt-section-spacer').length, 0)
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section-content p').length, 3)
    assert.ok(view.element.querySelectorAll(':scope > .pc-prompt-section-spacer').length > 0, 'only the adjacent section separators are compact')
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})
