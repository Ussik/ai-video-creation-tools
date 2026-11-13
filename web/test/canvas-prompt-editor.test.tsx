import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act, useRef, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { CanvasPromptEditorHandle, CanvasPromptEditorProps, CanvasPromptReference } from '../src/features/canvas/CanvasPromptEditor'
import { promptClipboardContent, writePromptClipboard } from '../src/features/canvas/canvas-prompt-clipboard'
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
const { default: PromptCopyMenu } = await import('../src/features/canvas/CanvasPromptCopyMenu')
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
async function sectionMenuAction(name: string, action: '移除区块' | '查看区块差异' | '调整参数') {
  await act(() => button(`区块操作：${name}`).click()); await settle()
  return button(`${action}：${name}`)
}
async function adjustParameters(name: string) {
  const action = await sectionMenuAction(name, '调整参数')
  await act(() => action.click()); await settle()
}
async function openMention(editor: Editor) {
  await act(() => editor.chain().setTextSelection(editor.state.doc.content.size - 1).insertContent('@').run())
}
async function mount(value: string, extra: Partial<CanvasPromptEditorProps> = {}, withCopy = false, strict = false) {
  const changes: string[] = [], sectionChanges: PromptSectionDocument[] = [], referenceChanges: Array<[string, string | null]> = [], referenceAdds: CanvasPromptReference[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function Harness() {
    const [text, setText] = useState(value)
    const [sections, setSections] = useState(extra.sectionDocument)
    const editorHandle = useRef<CanvasPromptEditorHandle>(null)
    return <MantineProvider env="test">{withCopy && <PromptCopyMenu visualBoard={extra.visualBoard} getContent={scope => editorHandle.current?.getClipboardContent(scope) || null} />}<PromptEditor ref={editorHandle} value={text} references={references} choices={choices}
      onChange={(next, document) => { changes.push(next); setText(next); if (document) { sectionChanges.push(document); setSections(document) } }} onReferenceChange={(id, replacement) => { referenceChanges.push([id, replacement]) }}
      onReferenceAdd={reference => { referenceAdds.push(reference) }} {...extra} sectionDocument={sections} /></MantineProvider>
  }
  await act(() => root.render(strict ? <React.StrictMode><Harness /></React.StrictMode> : <Harness />)); await settle()
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

test('required inputs protect direct chip removal while whole-prompt clearing keeps the input', async () => {
  const view = await mount('保持 [[ref:base]] 人物')
  try {
    await act(() => button('查看图片引用：角色基础').click())
    assert.match(document.querySelector('.pc-prompt-reference-menu')!.textContent!, /必需引用/)
    assert.equal(document.querySelector('[aria-label="搜索替换图片"]'), null)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '移除此引用'), false)
    const position = referencePosition(view.editor, 'base')
    await act(() => view.editor.chain().setTextSelection({ from: position, to: position + 1 }).deleteSelection().run())
    assert.equal(promptEditorText(view.editor.getJSON()), '保持 [[ref:base]] 人物')
    assert.deepEqual(view.referenceChanges, [])
    assert.deepEqual(view.changes, [])
    await act(() => view.editor.chain().selectAll().deleteSelection().run())
    assert.equal(view.changes.at(-1), '')
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), '保持 [[ref:base]] 人物')
    await act(() => view.editor.commands.redo())
    assert.equal(view.changes.at(-1), '')
    assert.deepEqual(view.referenceChanges, [])
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
  managed.mergeBaseText = editableSection.replace('纹理', '已合并的纹理')
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    await act(() => button('编辑图片引用：雨衣状态').click())
    await act(() => button('夜景车站').click()); await settle()
    const replaced = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(replaced.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', '[[ref:night]]'))
    assert.equal(replaced.pendingSourceText, managed.pendingSourceText.replaceAll('[[ref:look]]', '[[ref:night]]'))
    assert.equal(replaced.mergeBaseText, managed.mergeBaseText.replaceAll('[[ref:look]]', '[[ref:night]]'))
    assert.equal(replaced.sourceStatus, 'source_changed')
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), view.changes.at(-1))
    await act(() => button('编辑图片引用：夜景车站').click())
    await act(() => button('移除此引用').click()); await settle()
    const removed = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(removed.sourceText, managed.sourceText!.replaceAll('[[ref:look]]', ''))
    assert.equal(removed.pendingSourceText, managed.pendingSourceText.replaceAll('[[ref:look]]', ''))
    assert.equal(removed.mergeBaseText, managed.mergeBaseText.replaceAll('[[ref:look]]', ''))
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

test('empty-caret boundary keys stay protected while a full selection can clear structured sections', async () => {
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
    assert.equal(promptEditorText(view.editor.getJSON()), '')
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.undo())
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
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
    const remove = await sectionMenuAction('镜头视觉设定', '移除区块')
    await act(() => remove.click()); await settle()
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
    const remove = await sectionMenuAction('镜头视觉设定', '移除区块')
    assert.equal(remove.disabled, true)
    await act(() => remove.click())
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
    assert.deepEqual(blocks.map(block => block.querySelector('.pc-prompt-managed-section-title')?.textContent), ['设定图固定要求', '项目画风约束'])
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

test('a settings-only prompt exposes an empty body without saving and keeps first edits, caret and undo through parent echoes', async () => {
  const sections = parsePromptSectionDocument(editableSection, { sourceText: editableSection })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(editableSection, { sectionDocument: sections })
  const body = '主角站在雨后的车站，低机位近景。'
  try {
    assert.equal(view.editor.state.doc.firstChild?.type.name, 'paragraph')
    assert.equal(view.editor.state.doc.firstChild?.attrs.promptBodyEntry, true)
    assert.equal(view.editor.state.doc.firstChild?.textContent, '')
    assert.equal(promptEditorText(view.editor.getJSON()), editableSection)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])

    await act(() => view.editor.chain().setTextSelection(1).insertContent(body).run()); await settle()
    assert.equal(view.changes.at(-1), `${body}\n\n${editableSection}`)
    assert.equal(view.editor.state.selection.from, body.length + 1, 'the parent echo keeps the authoring cursor')
    assert.equal(view.editor.state.doc.firstChild?.attrs.promptBodyEntry, true, 'the parent echo preserves the live entry and its history')
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed'), managed)
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), view.changes.at(-1))

    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), editableSection)
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), `${body}\n\n${editableSection}`)
    await act(() => view.editor.view.dispatch(closeHistory(view.editor.state.tr)))
    await act(() => view.editor.chain().setTextSelection({ from: 1, to: body.length + 1 }).deleteSelection().run()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), editableSection, 'deleting the body also removes its synthetic separator')
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), `${body}\n\n${editableSection}`)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('synthetic body entry paragraphs preserve authored blank lines and omit an entirely empty entry run', () => {
  const document = promptEditorDocument(editableSection, references, choices)
  const entry = document.content![0]
  assert.equal(entry.attrs?.promptBodyEntry, true)
  const paragraph = (text = '') => ({ ...entry, ...(text ? { content: [{ type: 'text', text }] } : { content: [] }) })
  document.content = [paragraph(), paragraph(), ...document.content!.slice(1)]
  assert.equal(promptEditorText(document), editableSection)
  document.content = [paragraph('第一行正文。'), paragraph(), paragraph('第三行正文。'), ...document.content.slice(2)]
  assert.equal(promptEditorText(document), `第一行正文。\n\n第三行正文。\n\n${editableSection}`)
})

test('collapsing settings changes presentation only and copied text includes every folded section', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    const toggle = button('展开编辑：镜头视觉设定')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    const contentId = toggle.getAttribute('aria-controls')
    assert.ok(contentId)
    const content = document.getElementById(contentId)
    assert.ok(content)
    assert.ok(content.querySelector('[data-node-view-content]') || content.matches('[data-node-view-content]'), 'folded settings retain their editable content')
    await act(() => toggle.click()); await settle()
    assert.equal(button('收起设定：镜头视觉设定').getAttribute('aria-expanded'), 'true')
    await act(() => button('收起设定：镜头视觉设定').click()); await settle()
    assert.equal(button('展开编辑：镜头视觉设定').getAttribute('aria-expanded'), 'false')
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(view.editor.state.doc.slice(0, view.editor.state.doc.content.size), view.editor.view))
    assert.equal(copied, sectionText)
    assert.equal(promptEditorText(view.editor.getJSON()), sectionText)
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections), sections)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('expanded settings stay editable with source metadata and focusing a folded section reveals the caret', async () => {
  const sections = parsePromptSectionDocument(editableSection, { sourceText: editableSection })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.sourceStatus = 'source_changed'
  managed.pendingSourceText = editableSection.replace('纹理', '褶皱')
  const view = await mount(editableSection, { sectionDocument: sections })
  try {
    await act(() => button('展开编辑：镜头视觉设定').click()); await settle()
    await act(() => view.editor.commands.insertContentAt(sectionPosition(view.editor) + 2, '本节点补充：')); await settle()
    const edited = view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed')!
    assert.equal(edited.id, managed.id)
    assert.equal(edited.sourceText, managed.sourceText)
    assert.equal(edited.pendingSourceText, managed.pendingSourceText)
    assert.equal(edited.sourceStatus, 'source_changed')
    assert.match(edited.text, /本节点补充：保留\[\[ref:look\]\]/)
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), view.changes.at(-1))
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), editableSection)

    await act(() => view.editor.commands.setTextSelection(1))
    await act(() => button('收起设定：镜头视觉设定').click()); await settle()
    const savedChanges = view.changes.length
    await act(() => view.editor.chain().focus().setTextSelection(sectionPosition(view.editor) + 2).run()); await settle()
    assert.equal(button('收起设定：镜头视觉设定').getAttribute('aria-expanded'), 'true', 'keyboard focus cannot leave the caret in hidden settings')
    assert.equal(view.changes.length, savedChanges, 'focusing a folded section never changes the authored text')
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('removing the final setting leaves the authored body and undo restores the folded source block', async () => {
  const sections = parsePromptSectionDocument(editableSection, { sourceText: editableSection })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(editableSection, { sectionDocument: sections })
  const body = '保留我自己的完整画面描述。'
  try {
    await act(() => view.editor.chain().setTextSelection(1).insertContent(body).run()); await settle()
    const remove = await sectionMenuAction('镜头视觉设定', '移除区块')
    await act(() => remove.click()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), body)
    assert.equal(view.changes.at(-1), body)
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    const removed = view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id)!
    assert.equal(removed.deleted, true)
    assert.equal(removed.sourceText, managed.sourceText)
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(view.editor.state.doc.slice(0, view.editor.state.doc.content.size), view.editor.view))
    assert.equal(copied, body)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), `${body}\n\n${editableSection}`)
    assert.equal(view.container.querySelector('.pc-prompt-managed-section')?.getAttribute('data-prompt-section-id'), managed.id)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('pasting authored entry paragraphs into ordinary prose preserves paragraph boundaries', async () => {
  const source = await mount(editableSection)
  let target: Awaited<ReturnType<typeof mount>> | undefined
  try {
    await act(() => source.editor.chain().setTextSelection(1).insertContent('复制第一段。').run()); await settle()
    await act(() => source.editor.commands.splitBlock()); await settle()
    await act(() => source.editor.commands.insertContent('复制第二段。')); await settle()
    assert.equal(promptEditorText(source.editor.getJSON()), `复制第一段。\n复制第二段。\n\n${editableSection}`)
    const entryHTML = source.editor.getHTML().split('<section')[0]
    assert.match(entryHTML, /data-prompt-body-entry/)
    target = await mount('开头保留。\n末尾保留。')
    await act(() => target!.editor.commands.setTextSelection(1))
    await act(() => target!.editor.view.pasteHTML(entryHTML, new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(promptEditorText(target.editor.getJSON()), '复制第一段。\n复制第二段。开头保留。\n末尾保留。')
    assert.equal(target.changes.at(-1), '复制第一段。\n复制第二段。开头保留。\n末尾保留。')
    await act(() => target!.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(target.editor.getJSON()), '开头保留。\n末尾保留。')
    assert.equal(promptEditorText(source.editor.getJSON()), `复制第一段。\n复制第二段。\n\n${editableSection}`)
  } finally { if (target) await target.destroy(); await source.destroy() }
})

test('pasting several prose paragraphs into the empty body keeps their line breaks before folded settings', async () => {
  const view = await mount(editableSection)
  try {
    await act(() => view.editor.commands.setTextSelection(1))
    await act(() => view.editor.view.pasteText('第一段正文。\n第二段正文。', new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), `第一段正文。\n第二段正文。\n\n${editableSection}`)
    assert.equal(view.changes.at(-1), `第一段正文。\n第二段正文。\n\n${editableSection}`)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), editableSection)
  } finally { await view.destroy() }
})

test('removing a leading setting preserves its existing trailing prose and whitespace without serializing the empty entry', async () => {
  const trailing = '\n\n末尾正文保持原有空行。\n'
  const value = `${editableSection}${trailing}`
  const view = await mount(value)
  try {
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    const remove = await sectionMenuAction('镜头视觉设定', '移除区块')
    await act(() => remove.click()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), trailing)
    assert.equal(view.changes.at(-1), trailing)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('pasting an entire authored prompt preserves its body separation and copies the setting with a fresh identity', async () => {
  const sections = parsePromptSectionDocument(editableSection, { sourceText: editableSection })
  const source = await mount(editableSection, { sectionDocument: sections })
  let target: Awaited<ReturnType<typeof mount>> | undefined
  try {
    await act(() => source.editor.chain().setTextSelection(1).insertContent('复制正文。').run()); await settle()
    const copied = promptEditorText(source.editor.getJSON())
    assert.equal(copied, `复制正文。\n\n${editableSection}`)
    target = await mount('原有正文。')
    await act(() => target!.editor.commands.setTextSelection(1))
    await act(() => target!.editor.view.pasteHTML(source.editor.getHTML(), new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(promptEditorText(target.editor.getJSON()), `${copied}原有正文。`)
    const copiedSection = target.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed')!
    assert.notEqual(copiedSection.id, sections.blocks.find(block => block.kind === 'managed')!.id)
    assert.equal(copiedSection.text, editableSection)
    assert.equal(source.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed')!.sourceText, editableSection)
    await act(() => target!.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(target.editor.getJSON()), '原有正文。')
    assert.equal(promptEditorText(source.editor.getJSON()), copied)
  } finally { if (target) await target.destroy(); await source.destroy() }
})

test('folded requirements keep a compact summary and visible conflict decisions with source details in their menu', async () => {
  const source = '【图片生成要求】\n画面比例：16:9\n清晰度要求：2K\n【图片生成要求结束】'
  const value = source.replace('2K', '手工描述')
  const sections = parsePromptSectionDocument(value, { sourceText: source })
  const managed = sections.blocks.find(block => block.kind === 'managed')!
  managed.pendingSourceText = source.replace('2K', '4K')
  managed.sourceStatus = 'source_changed'
  const decisions: Array<[string, string]> = []
  const view = await mount(value, { sectionDocument: sections, onResolveSource: (id, choice) => { decisions.push([id, choice]) } })
  try {
    const block = view.container.querySelector('.pc-prompt-managed-section')!
    assert.equal(block.querySelector('.pc-prompt-managed-origin'), null)
    assert.equal(block.querySelector('.pc-prompt-managed-edit-label'), null)
    assert.equal(block.querySelector('.pc-prompt-managed-state')!.textContent, '待确认')
    assert.match(block.querySelector('.pc-prompt-managed-summary')!.textContent!, /画面比例：16:9 清晰度要求：手工描述/)
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])
    await act(() => button('就地保留本节点修改：图片生成要求', view.container).click())
    assert.deepEqual(decisions, [[managed.id, 'keep_custom']])
    const compare = await sectionMenuAction('图片生成要求', '查看区块差异')
    assert.match(document.querySelector('[role="menu"]')!.textContent!, /生成参数 · 来源：本节点图片参数/)
    await act(() => compare.click()); await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent!, /上次接受的来源内容/)
    assert.match(dialog.querySelector('[aria-label="本节点内容变化"] [data-change="added"]')!.textContent!, /手工描述/)
    assert.match(dialog.querySelector('[aria-label="来源更新"] [data-change="added"]')!.textContent!, /4K/)
    assert.match(dialog.textContent!, /以底部生成参数为准/)
    assert.deepEqual(view.changes, [])
  } finally { await view.destroy() }
})

test('read-only requirements allow comparison while local and modal conflict decisions stay disabled', async () => {
  const source = '【项目画风约束】\n纸张纹理\n【项目画风约束结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const block = sections.blocks.find(block => block.kind === 'managed')!
  block.pendingSourceText = source.replace('纸张', '水彩'); block.sourceStatus = 'source_changed'
  const decisions: string[] = []
  const view = await mount(source, { sectionDocument: sections, readOnly: true, onResolveSource: id => { decisions.push(id) } })
  try {
    const local = button('就地使用来源更新：项目画风约束', view.container)
    assert.equal(local.disabled, true)
    await act(() => local.click())
    const compare = await sectionMenuAction('项目画风约束', '查看区块差异')
    await act(() => compare.click()); await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    const resolve = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用来源更新')!
    assert.equal(resolve.disabled, true)
    await act(() => resolve.click())
    assert.deepEqual(decisions, [])
    assert.deepEqual(view.changes, [])
    assert.equal(promptEditorText(view.editor.getJSON()), source)
  } finally { await view.destroy() }
})

test('whole-prompt delete, typing, paste and cut work across folded sections and preserve inputs through undo', async t => {
  const second = '【项目画风约束】\n水墨线条。\n【项目画风约束结束】'
  const value = `前文[[ref:base]]。\n\n${editableSection}\n\n${second}\n\n尾文。`
  const operations = ['Backspace', 'Delete', 'typing', 'plain paste', 'HTML paste', 'cut'] as const
  for (const operation of operations) await t.test(operation, async () => {
    const sections = parsePromptSectionDocument(value, { sourceText: value })
    const original = sections.blocks.filter(block => block.kind === 'managed')
    original[0]!.pendingSourceText = editableSection.replace('纹理', '褶皱')
    original[0]!.mergeBaseText = editableSection.replace('纹理', '局部纹理')
    original[0]!.sourceStatus = 'source_changed'
    const view = await mount(value, { sectionDocument: sections })
    let expected = ''
    try {
      assert.equal(view.container.querySelector('.pc-prompt-managed-section.is-open'), null)
      await act(() => view.editor.commands.selectAll())
      if (operation === 'Backspace' || operation === 'Delete') {
        await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: operation, bubbles: true, cancelable: true })))
      } else if (operation === 'typing') {
        expected = '新的画面描述。'
        await act(() => view.editor.view.dispatch(view.editor.state.tr.insertText(expected)))
      } else if (operation === 'plain paste') {
        expected = '新的第一行。\n新的第二行。'
        await act(() => view.editor.view.pasteText(expected, new dom.window.Event('paste') as ClipboardEvent))
      } else if (operation === 'HTML paste') {
        expected = '新的第一行。\n新的第二行。'
        await act(() => view.editor.view.pasteHTML('<p>新的第一行。</p><p>新的第二行。</p>', new dom.window.Event('paste') as ClipboardEvent))
      } else {
        const clipboard = new Map<string, string>()
        const event = new dom.window.Event('cut', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: { clearData: () => clipboard.clear(), setData: (type: string, text: string) => clipboard.set(type, text) } })
        await act(() => view.element.dispatchEvent(event))
        assert.equal(clipboard.get('text/plain'), value, 'cut includes complete folded contents and stable reference tokens')
      }
      await settle()
      assert.equal(promptEditorText(view.editor.getJSON()), expected)
      assert.equal(view.changes.at(-1), expected)
      assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
      const deleted = view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed')
      for (const block of original) assert.deepEqual(deleted.find(item => item.id === block.id), { ...block, text: '', deleted: true })
      assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), expected)
      assert.deepEqual(view.referenceChanges, [], 'whole-prompt edits preserve real image inputs')
      await act(() => view.editor.commands.undo()); await settle()
      assert.equal(promptEditorText(view.editor.getJSON()), value)
      for (const block of original) assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(item => item.id === block.id), block)
      await act(() => view.editor.commands.redo()); await settle()
      assert.equal(promptEditorText(view.editor.getJSON()), expected)
      assert.deepEqual(view.referenceChanges, [])
      if (!expected) {
        await act(() => view.editor.view.dispatch(closeHistory(view.editor.state.tr.insertText('清空后继续输入。'))))
        assert.equal(view.changes.at(-1), '清空后继续输入。')
      }
    } finally { await view.destroy() }
  })
})

test('whole-body replacement without managed blocks retains optional and required image inputs on redo', async () => {
  const value = '使用[[ref:look]]和[[ref:base]]。'
  const view = await mount(value)
  try {
    await act(() => view.editor.chain().selectAll().insertContent('换成新的提示词。').run())
    assert.equal(view.changes.at(-1), '换成新的提示词。')
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), value)
    await act(() => view.editor.commands.redo())
    assert.equal(view.changes.at(-1), '换成新的提示词。')
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('a range spanning a whole section removes only the selected content and keeps connected images', async () => {
  const value = sectionText.replace('[[ref:look]]', '[[ref:base]]')
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const original = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(value, { sectionDocument: sections })
  try {
    const position = sectionPosition(view.editor), size = view.editor.state.doc.nodeAt(position)!.nodeSize
    await act(() => view.editor.chain().setTextSelection({ from: position - 1, to: position + size + 1 }).deleteSelection().run())
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    assert.match(view.changes.at(-1)!, /^前文保持空行。/)
    assert.match(view.changes.at(-1)!, /末尾正文。\n$/)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), { ...original, text: '', deleted: true })
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), value)
    await act(() => view.editor.commands.redo())
    assert.equal(view.container.querySelector('.pc-prompt-managed-section'), null)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('pasting a same-name section over the full prompt gets a fresh identity and keeps the deleted source separate', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const original = sections.blocks.find(block => block.kind === 'managed')!
  original.pendingSourceText = editableSection.replace('纹理', '褶皱')
  original.mergeBaseText = editableSection.replace('纹理', '局部纹理')
  original.sourceStatus = 'source_changed'
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    const pasted = editableSection.replace('纹理', '新服装')
    await act(() => view.editor.commands.selectAll())
    await act(() => view.editor.view.pasteText(pasted, new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(view.changes.at(-1), pasted)
    const blocks = view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed')
    const active = blocks.find(block => !block.deleted)!
    assert.notEqual(active.id, original.id)
    assert.equal(active.sourceText, undefined)
    assert.equal(active.pendingSourceText, undefined)
    assert.equal(active.mergeBaseText, undefined)
    assert.deepEqual(blocks.find(block => block.id === original.id), { ...original, text: '', deleted: true })
    assert.equal(serializePromptSectionDocument(view.sectionChanges.at(-1)!), pasted)
    assert.deepEqual(view.referenceChanges, [])
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(view.changes.at(-1), sectionText)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(view.changes.at(-1), pasted)
  } finally { await view.destroy() }
})

test('explicit actions on a prompt containing only one chip still restore actual inputs on undo and redo', async t => {
  for (const replacement of [null, 'night'] as const) await t.test(replacement || 'remove', async () => {
    const view = await mount('[[ref:look]]')
    try {
      await act(() => button('编辑图片引用：雨衣状态').click())
      await act(() => button(replacement ? '夜景车站' : '移除此引用').click()); await settle()
      assert.deepEqual(view.referenceChanges, [['look', replacement]])
      assert.equal(view.changes.at(-1), replacement ? '[[ref:night]]' : '')
      await act(() => view.editor.commands.undo()); await settle()
      assert.equal(view.changes.at(-1), '[[ref:look]]')
      assert.deepEqual(view.referenceChanges.at(-1), ['look', 'look'])
      if (replacement) assert.ok(view.referenceChanges.some(([id, value]) => id === replacement && value === null))
      await act(() => view.editor.commands.redo()); await settle()
      assert.equal(view.changes.at(-1), replacement ? '[[ref:night]]' : '')
      assert.ok(view.referenceChanges.slice(2).some(([id, value]) => id === 'look' && value === null))
      if (replacement) assert.deepEqual(view.referenceChanges.at(-1), [replacement, replacement])
    } finally { await view.destroy() }
  })
})

test('consecutive cut and paste are separate undo steps with source identities restored by the cut undo', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const original = sections.blocks.find(block => block.kind === 'managed')!
  original.pendingSourceText = editableSection.replace('纹理', '褶皱')
  original.sourceStatus = 'source_changed'
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    const clipboard = new Map<string, string>()
    const cut = new dom.window.Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', { value: { clearData: () => clipboard.clear(), setData: (type: string, text: string) => clipboard.set(type, text) } })
    await act(() => view.editor.commands.selectAll())
    await act(() => view.element.dispatchEvent(cut))
    assert.equal(view.changes.at(-1), '')
    await act(() => view.editor.view.pasteText(clipboard.get('text/plain')!, new dom.window.Event('paste') as ClipboardEvent))
    assert.equal(view.changes.at(-1), sectionText)
    assert.notEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed' && !block.deleted)!.id, original.id)
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), '', 'first undo reverses only paste')
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), sectionText)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)
    await act(() => view.editor.commands.redo())
    assert.equal(view.changes.at(-1), '')
    await act(() => view.editor.commands.redo())
    assert.equal(view.changes.at(-1), sectionText)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('pasting identical full prompt text still publishes its new section identities without stale source metadata', async () => {
  const sections = parsePromptSectionDocument(sectionText, { sourceText: sectionText })
  const original = sections.blocks.find(block => block.kind === 'managed')!
  original.pendingSourceText = editableSection.replace('纹理', '褶皱')
  original.sourceStatus = 'source_changed'
  const view = await mount(sectionText, { sectionDocument: sections })
  try {
    await act(() => view.editor.commands.selectAll())
    await act(() => view.editor.view.pasteText(sectionText, new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(view.changes.at(-1), sectionText)
    const active = view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed' && !block.deleted)!
    assert.notEqual(active.id, original.id)
    assert.equal(active.pendingSourceText, undefined)
    assert.equal(active.sourceText, undefined)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(view.changes.at(-1), sectionText)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.kind === 'managed' && !block.deleted)!.id, active.id)
  } finally { await view.destroy() }
})

test('whole-prompt paste preserves existing inputs and connects newly introduced project references', async () => {
  const view = await mount('使用[[ref:look]]和[[ref:base]]。', { choices: references, additionalChoices: [choices[2]] })
  try {
    await act(() => view.editor.commands.selectAll())
    await act(() => view.editor.view.pasteText('采用[[ref:night]]。', new dom.window.Event('paste') as ClipboardEvent)); await settle()
    assert.equal(view.changes.at(-1), '采用[[ref:night]]。')
    assert.deepEqual(view.referenceAdds.map(reference => reference.assetId), ['night'])
    assert.deepEqual(view.referenceChanges, [], 'replacement text does not disconnect the previous inputs')
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), '使用[[ref:look]]和[[ref:base]]。')
    assert.deepEqual(view.referenceChanges, [], 'undoing a whole-prompt edit also leaves image inputs connected')
  } finally { await view.destroy() }
})

test('ordinary main content folds without changing prose, constraints, source metadata or undo history', async () => {
  const requirement = '【项目画风约束】\n保留纸张纹理\n【项目画风约束结束】'
  const value = `完整人物，服装参考[[ref:base]]。\n第二段创作内容\n\n${requirement}\n\n末尾补充`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { sectionDocument: sections, expanded: true })
  try {
    const heading = button('收起设定：主要创作内容', view.container)
    const before = view.editor.getJSON(), beforeHTML = view.editor.getHTML()
    assert.equal(heading.getAttribute('aria-expanded'), 'true')
    assert.ok(document.getElementById(heading.getAttribute('aria-controls')!))
    assert.equal(view.container.querySelector('.is-body-collapsed'), null)
    await act(() => view.editor.chain().focus().setTextSelection(1).run()); await settle()
    await act(() => heading.click()); await settle()
    assert.equal(button('展开编辑：主要创作内容', view.container).getAttribute('aria-expanded'), 'false')
    assert.ok(view.container.querySelector('.is-body-collapsed'))
    assert.match(view.container.querySelector('.pc-prompt-body-summary')!.textContent!, /完整人物，服装参考角色基础。 第二段创作内容 末尾补充/)
    assert.doesNotMatch(view.container.querySelector('.pc-prompt-body-summary')!.textContent!, /保留纸张纹理/)
    assert.equal(view.editor.isFocused, false, 'the caret does not remain focused inside folded prose')
    assert.ok(view.container.querySelector('.pc-prompt-presets-heading'))
    assert.ok(view.container.querySelector('.pc-prompt-managed-toggle'), 'constraint controls stay available')
    assert.deepEqual(view.editor.getJSON(), before)
    assert.equal(view.editor.getHTML(), beforeHTML, 'folded styling does not enter clipboard HTML')
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.referenceChanges, [])

    await act(() => button('展开编辑：主要创作内容', view.container).click()); await settle()
    assert.equal(view.container.querySelector('.is-body-collapsed'), null)
    await act(() => view.editor.commands.insertContentAt(1, '修改'))
    assert.equal(view.changes.at(-1), `修改${value}`)
    const managed = sections.blocks.find(block => block.kind === 'managed')!
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === managed.id), managed)
    await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(view.changes.at(-1), value, 'folding does not add an undo step')
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(view.changes.at(-1), `修改${value}`)

    await act(() => view.editor.chain().focus().setTextSelection(2).run()); await settle()
    assert.equal(view.container.querySelector('.is-body-collapsed'), null, 'focus entering prose reveals it')
    assert.equal(button('收起设定：主要创作内容', view.container).getAttribute('aria-expanded'), 'true')
  } finally { await view.destroy() }
})

test('ordinary empty and readonly main content fold while compact editors keep their inline presentation', async () => {
  for (const extra of [{}, { readOnly: true }, { disabled: true }]) {
    const view = await mount('', extra)
    try {
      await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
      assert.equal(view.container.querySelector('.pc-prompt-body-summary')!.textContent, '暂无创作内容')
      assert.equal(button('展开编辑：主要创作内容', view.container).getAttribute('aria-expanded'), 'false')
      await act(() => button('展开编辑：主要创作内容', view.container).click()); await settle()
      assert.equal(view.container.querySelector('.is-body-collapsed'), null)
      assert.deepEqual(view.changes, [])
    } finally { await view.destroy() }
  }
  const compact = await mount('调整正文', { compact: true })
  try {
    assert.equal(compact.container.querySelector('.pc-prompt-body-toggle'), null)
    assert.equal(compact.container.querySelector('.is-body-collapsed'), null)
  } finally { await compact.destroy() }
})

test('opening a generation constraint and focusing its controls keeps ordinary main content folded', async () => {
  const requirement = '【视频生成要求】\n保留镜头运动，稳定人物外观。\n【视频生成要求结束】'
  const value = `人物在夜色中走过车站。\n\n${requirement}`
  const view = await mount(value)
  try {
    await act(() => view.editor.chain().focus().setTextSelection(2).run()); await settle()
    await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
    const controls = button('展开编辑：视频生成要求', view.container)
    await act(() => {
      controls.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      controls.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      controls.focus()
      // Node-view controls can leave Tiptap's focus signal true while DOM
      // focus belongs to their button and the old prose selection is retained.
      view.element.dispatchEvent(new dom.window.FocusEvent('focus', { relatedTarget: controls }))
      controls.click()
    }); await settle()
    assert.equal(document.activeElement, controls)
    assert.equal(view.container.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, false)
    assert.ok(view.container.querySelector('.is-body-collapsed'))
    assert.equal(button('展开编辑：主要创作内容', view.container).getAttribute('aria-expanded'), 'false')
    await act(() => button('区块操作：视频生成要求', view.container).focus()); await settle()
    assert.ok(view.container.querySelector('.is-body-collapsed'), 'constraint action focus does not reveal prose')
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])
    await act(() => view.editor.chain().focus().setTextSelection(2).run()); await settle()
    assert.equal(view.container.querySelector('.is-body-collapsed'), null, 'actual editor focus still reveals the body caret')
  } finally { await view.destroy() }
})

test('visual-board presentation keeps one editable main task and preserves source metadata through edits and undo', async () => {
  const primary = '【设定图固定要求】\n人物三视图，服装参考[[ref:base]]。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n保留纸张纹理\n【项目画风约束结束】'
  const value = `${primary}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const original = sections.blocks.find(block => block.name === '设定图固定要求')!
  const view = await mount(value, { visualBoard: true, sectionDocument: sections })
  try {
    const main = view.container.querySelector<HTMLElement>('.pc-prompt-managed-section.is-primary')!
    assert.ok(main)
    assert.match(main.querySelector('.pc-prompt-managed-section-title')!.textContent!, /^主要创作内容$/)
    assert.equal(main.querySelector('.pc-prompt-content-scope')!.textContent, '整理对象')
    assert.equal(main.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, false)
    assert.equal(view.container.querySelector<HTMLElement>('.pc-prompt-managed-section.is-secondary .pc-prompt-managed-panel')!.hidden, true)
    assert.equal(view.container.querySelector('.pc-prompt-supplement-heading, .pc-prompt-supplement-line'), null)
    assert.equal(view.editor.state.doc.child(1).attrs.promptBodyEntry, false, 'a board does not create a redundant empty prose field')
    assert.match(view.container.querySelector('.pc-prompt-presets-heading')!.textContent!, /生成约束1 项 · 手动维护 · 整理时保留 · 生成时生效/)
    assert.equal(main.querySelector('.pc-prompt-managed-origin'), null)
    assert.equal(main.querySelector('.pc-prompt-managed-edit-label'), null)
    assert.equal(main.querySelector('.pc-prompt-managed-state'), null)
    assert.equal(main.querySelector('[aria-label="移除区块：主要创作内容"]'), null, 'section removal lives in the board actions menu')
    assert.equal(main.dataset.promptSectionName, '设定图固定要求', 'the display label does not change the persisted marker')
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])

    let position = -1
    view.editor.state.doc.descendants((node, offset) => { if (node.isText && node.text === '人物三视图，服装参考') position = offset })
    assert.ok(position >= 0)
    await act(() => view.editor.commands.insertContentAt(position, '完整展示'))
    assert.match(view.changes.at(-1)!, /【设定图固定要求】\n完整展示人物三视图/)
    assert.equal(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id)!.sourceText, original.sourceText)
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), value)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)

    const savedChanges = view.changes.length
    let mainPosition = -1
    view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.name === '设定图固定要求') mainPosition = offset })
    assert.ok(mainPosition >= 0)
    await act(() => view.editor.chain().focus().setTextSelection(mainPosition + 2).run()); await settle()
    await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
    assert.equal(view.container.querySelector<HTMLElement>('.pc-prompt-managed-section.is-primary .pc-prompt-managed-panel')!.hidden, true)
    assert.equal(view.editor.state.selection.$from.depth, 1, 'folding the main section moves the caret into the visible editor body')
    assert.equal(view.editor.state.selection.$from.parent.type.name, 'paragraph')
    assert.equal(view.changes.length, savedChanges)
    await act(() => button('展开编辑：主要创作内容', view.container).click()); await settle()

    await act(() => button('区块操作：主要创作内容', view.container).click()); await settle()
    await act(() => button('移除此段内容').click()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-managed-section.is-primary'), null)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), { ...original, text: '', deleted: true })
    assert.equal(promptEditorText(view.editor.getJSON()), `\n\n${style}`)
    assert.deepEqual(view.referenceChanges, [], 'removing the board task keeps its image inputs')
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)

    await act(() => view.editor.chain().selectAll().deleteSelection().run())
    assert.equal(view.changes.at(-1), '')
    assert.deepEqual(view.referenceChanges, [], 'clearing the visual task keeps its actual image inputs')
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), value)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id), original)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('copy menu separates reusable board prose from the complete prompt and omits editor chrome', async () => {
  const primary = '【设定图固定要求】\n人物三视图，服装参考[[ref:base]]。\n【设定图固定要求结束】'
  const supplement = '补充细节，参考[[ref:look]]。'
  const requirement = '【项目画风约束】\n保留纸张纹理\n【项目画风约束结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const value = `${primary}\n\n${supplement}\n\n${requirement}\n\n${parameters}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { visualBoard: true, sectionDocument: sections }, true)
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.window.navigator, 'clipboard')
  const written: string[] = []
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text) } } })
  try {
    const body = promptClipboardContent(view.editor, 'body')
    assert.equal(body.text, `人物三视图，服装参考[[ref:base]]。\n\n${supplement}`)
    assert.doesNotMatch(body.html, /data-prompt-section/)
    assert.match(body.html, /data-prompt-reference="base"/)
    assert.match(body.html, /data-prompt-reference="look"/)
    assert.doesNotMatch(body.html, /纸张纹理|16:9|提示词正文|补充说明/)

    const full = promptClipboardContent(view.editor, 'full')
    assert.equal(full.text, value, 'plain clipboard text remains directly pasteable as a complete serialized prompt')
    assert.match(full.html, /data-prompt-section=/)
    assert.match(full.html, /data-prompt-reference="base"/)
    assert.match(full.html, /纸张纹理/)
    assert.match(full.html, /16:9/)
    assert.doesNotMatch(full.html, /pc-prompt-managed-toggle|区块操作|data-placeholder/)
    assert.equal(view.changes.length, 0, 'copy never edits or normalizes the document')
    assert.equal(view.sectionChanges.length, 0)
    await act(() => button('复制提示词', view.container).click()); await settle()
    await act(() => button('复制正文').click()); await settle()
    assert.deepEqual(written, [body.text])
    assert.equal(button('复制提示词', view.container).textContent?.trim(), '已复制')
    await act(() => button('复制提示词', view.container).click()); await settle()
    await act(() => button('复制完整提示词').click()); await settle()
    assert.deepEqual(written, [body.text, full.text])
  } finally {
    await view.destroy()
    if (clipboardDescriptor) Object.defineProperty(dom.window.navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(dom.window.navigator, 'clipboard')
  }
})

test('ordinary node body copy excludes managed requirements and full copy preserves them', async () => {
  const requirement = '【图片生成要求】\n画面比例：4:3\n【图片生成要求结束】'
  const value = `车站夜景，保持角色身份。\n\n${requirement}`
  const view = await mount(value, {}, true)
  try {
    assert.equal(promptClipboardContent(view.editor, 'body').text, '车站夜景，保持角色身份。')
    assert.equal(promptClipboardContent(view.editor, 'full').text, value)
  } finally { await view.destroy() }
})

test('body clipboard HTML pastes into another node while retaining destination requirements and resolving reference chips', async () => {
  const sourceText = '【设定图固定要求】\n人物参考[[ref:base]]\n【设定图固定要求结束】\n\n补充[[ref:look]]'
  const source = await mount(sourceText, { visualBoard: true }, true)
  const targetRequirement = '【图片生成要求】\n画面比例：4:3\n【图片生成要求结束】'
  const destination = await mount(`旧正文\n\n${targetRequirement}`)
  try {
    const copied = promptClipboardContent(source.editor, 'body')
    const clipboard = { 'text/html': copied.html, 'text/plain': copied.text }
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: {
      getData: (type: string) => clipboard[type as keyof typeof clipboard] || '',
      types: Object.keys(clipboard),
      files: [],
    } })
    await act(() => destination.element.dispatchEvent(paste)); await settle()
    assert.match(destination.changes.at(-1) || '', /人物参考\[\[ref:base\]\]/)
    assert.match(destination.changes.at(-1) || '', /补充\[\[ref:look\]\]/)
    assert.match(destination.changes.at(-1) || '', /【图片生成要求】[\s\S]*4:3/)
    referencePosition(destination.editor, 'base')
    referencePosition(destination.editor, 'look')
    assert.deepEqual(destination.referenceAdds, [], 'references already available to the destination do not create duplicate inputs')
    assert.equal(destination.sectionChanges.at(-1)?.blocks.filter(block => block.kind === 'managed' && !block.deleted).length, 1,
      'the source setting-image block was flattened and did not duplicate destination requirements')
    await act(() => destination.editor.commands.undo()); await settle()
    assert.equal(destination.changes.at(-1), `旧正文\n\n${targetRequirement}`)
  } finally { await source.destroy(); await destination.destroy() }
})

test('board main content pastes as ordinary creative prose through full and native clipboard formats', async t => {
  const main = '许门祠堂藏面阁，参考[[ref:base]]。\n入口低矮，石地面保留旧纹理。'
  const primary = `【设定图固定要求】\n${main}\n【设定图固定要求结束】`
  const style = '【项目画风约束】\n保留纸张纹理。\n【项目画风约束结束】'
  const value = `${primary}\n\n${style}`
  const targetRequirement = '【图片生成要求】\n画面比例：4:3\n【图片生成要求结束】'
  for (const format of ['full HTML', 'full text', 'native all', 'native primary', 'native partial primary'] as const) await t.test(format, async () => {
    const source = await mount(value, { visualBoard: true, sectionDocument: parsePromptSectionDocument(value, { sourceText: value }) })
    const targetValue = targetRequirement
    const destination = await mount(targetValue)
    try {
      const copied: Record<string, string> = {}
      if (format === 'full HTML' || format === 'full text') {
        const full = promptClipboardContent(source.editor, 'full')
        copied['text/plain'] = full.text
        if (format === 'full HTML') copied['text/html'] = full.html
      } else {
        const primaryNode = source.editor.state.doc.firstChild!
        await act(() => format === 'native all' ? source.editor.commands.selectAll()
          : source.editor.commands.setTextSelection(format === 'native primary'
            ? { from: 0, to: primaryNode.nodeSize }
            : { from: 2, to: primaryNode.nodeSize - 2 }))
        const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true })
        Object.defineProperty(copy, 'clipboardData', { value: {
          clearData: () => { for (const key of Object.keys(copied)) delete copied[key] },
          setData: (type: string, text: string) => { copied[type] = text },
        } })
        await act(() => source.element.dispatchEvent(copy))
      }
      await act(() => destination.editor.commands.setTextSelection(1))
      const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { getData: (type: string) => copied[type] || '', types: Object.keys(copied), files: [] } })
      await act(() => destination.element.dispatchEvent(paste)); await settle()
      const saved = destination.sectionChanges.at(-1)!
      assert.ok(saved)
      assert.equal(saved.blocks.filter(block => block.kind === 'body').map(block => block.text).join('').trim(), main,
        'the source main task belongs in the destination creative body')
      assert.equal(saved.blocks.some(block => block.kind === 'managed' && !block.deleted && block.name === '设定图固定要求'), false)
      assert.equal(saved.blocks.find(block => block.kind === 'managed' && block.name === '图片生成要求')!.text, targetRequirement)
      if (format === 'full HTML' || format === 'full text' || format === 'native all') {
        const pastedStyle = saved.blocks.find(block => block.kind === 'managed' && block.name === '项目画风约束')!
        assert.equal(pastedStyle.text, style, 'full copy keeps actual generation constraints')
        assert.equal(pastedStyle.sourceText, undefined, 'source ownership is not copied')
      }
      assert.equal(destination.element.querySelectorAll('.pc-prompt-reference').length, 1)
      await act(() => destination.editor.commands.undo()); await settle()
      assert.equal(promptEditorText(destination.editor.getJSON()), targetValue)
      await act(() => destination.editor.commands.redo()); await settle()
      assert.equal(destination.sectionChanges.at(-1)!.blocks.some(block => block.kind === 'managed' && !block.deleted && block.name === '设定图固定要求'), false)
      assert.equal(promptEditorText(source.editor.getJSON()), value)
      assert.deepEqual(source.changes, [])
    } finally { await source.destroy(); await destination.destroy() }
  })
})

test('full clipboard HTML pastes editable requirements with fresh identities and no source metadata', async () => {
  const primary = '【设定图固定要求】\n人物三视图[[ref:base]]\n【设定图固定要求结束】'
  const requirement = '【项目画风约束】\n保留纸张纹理\n【项目画风约束结束】'
  const value = `${primary}\n\n${requirement}`
  const sourceSections = parsePromptSectionDocument(value, { sourceText: value })
  const sourceRequirement = sourceSections.blocks.find(block => block.kind === 'managed' && block.name === '项目画风约束')!
  if (sourceRequirement.kind === 'managed') {
    sourceRequirement.pendingSourceText = requirement.replace('纸张纹理', '绢本纹理')
    sourceRequirement.sourceStatus = 'source_changed'
  }
  const source = await mount(value, { visualBoard: true, sectionDocument: sourceSections }, true)
  const targetSections = parsePromptSectionDocument(value, { sourceText: value })
  const oldRequirement = targetSections.blocks.find(block => block.kind === 'managed' && block.name === '项目画风约束')!
  if (oldRequirement.kind === 'managed') {
    oldRequirement.pendingSourceText = requirement.replace('纸张纹理', '绢本纹理')
    oldRequirement.sourceStatus = 'source_changed'
  }
  const destination = await mount(value, { visualBoard: true, sectionDocument: targetSections })
  try {
    const copied = promptClipboardContent(source.editor, 'full')
    await act(() => destination.editor.commands.selectAll())
    const clipboard = { 'text/html': copied.html, 'text/plain': copied.text }
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: {
      getData: (type: string) => clipboard[type as keyof typeof clipboard] || '',
      types: Object.keys(clipboard), files: [],
    } })
    await act(() => destination.element.dispatchEvent(paste)); await settle()
    assert.equal(destination.changes.at(-1), value, copied.html)
    const activeRequirement = destination.sectionChanges.at(-1)?.blocks.find(block => block.kind === 'managed' && !block.deleted && block.name === '项目画风约束')
    assert.ok(activeRequirement && activeRequirement.id !== oldRequirement.id, 'pasted sections receive independent identities')
    assert.equal(activeRequirement.kind, 'managed')
    assert.equal(activeRequirement.pendingSourceText, undefined)
    assert.equal(activeRequirement.sourceText, undefined)
    assert.equal(activeRequirement.sourceStatus, undefined)
    await act(() => destination.editor.commands.undo()); await settle()
    assert.deepEqual(destination.sectionChanges.at(-1)?.blocks.find(block => block.id === oldRequirement.id), oldRequirement)
  } finally { await source.destroy(); await destination.destroy() }
})

test('legacy board prose stays plain and editable without a separate supplement surface', async () => {
  const primary = '【设定图固定要求】\n人物三视图，完整展示外套。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n保留纸张纹理。\n【项目画风约束结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n清晰度要求：2K\n【图片生成要求结束】'
  const prefix = '开头补充：衣领保留三道缝线，参考[[ref:look]]。\n\n'
  const interleaved = '\n\n夹层补充：腰带保持窄版。\n \n'
  const tail = '\n\n尾部补充：袖口保持平整，参考[[ref:base]]。\n\n'
  const ending = '\n\n收尾补充：禁止额外文字。'
  const value = `${prefix}${style}${interleaved}${primary}${tail}${parameters}${ending}`
  const expected = `${primary}\n\n${prefix}${interleaved}${tail}${ending}\n\n${style}\n\n${parameters}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const original = structuredClone(sections)
  const view = await mount(value, { visualBoard: true, sectionDocument: sections })
  try {
    assert.equal(view.editor.state.doc.firstChild?.type.name, 'promptManagedSection')
    assert.equal(view.editor.state.doc.firstChild?.attrs.section.name, '设定图固定要求')
    assert.equal(promptEditorText(view.editor.getJSON()), expected)
    assert.deepEqual([...view.container.querySelectorAll('.pc-prompt-managed-section')].map(section => section.getAttribute('data-prompt-section-name')),
      ['设定图固定要求', '项目画风约束', '图片生成要求'])
    assert.equal(view.container.querySelectorAll('.pc-prompt-reference').length, 2)
    assert.equal(view.container.querySelector('.pc-prompt-supplement-heading, .pc-prompt-supplement-line'), null)
    assert.equal(view.container.querySelectorAll('.pc-prompt-editor-content > p:not(.pc-prompt-section-spacer)').length > 0, true,
      'historical body text remains ordinary editable prose')
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(view.editor.state.doc.slice(0, view.editor.state.doc.content.size), view.editor.view))
    assert.equal(copied, expected, 'copy uses the same main, supplement and setting order as the editor')
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections).blocks.filter(block => block.kind === 'managed'),
      [original.blocks.find(block => block.name === '设定图固定要求'), original.blocks.find(block => block.name === '项目画风约束'), original.blocks.find(block => block.name === '图片生成要求')])
    assert.deepEqual(sections, original, 'opening and copying never mutate the saved legacy document')
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    assert.deepEqual(view.referenceChanges, [])

    let position = -1
    view.editor.state.doc.descendants((node, offset) => { if (node.isText && node.text?.startsWith('夹层补充：')) position = offset + '夹层补充：'.length })
    assert.ok(position >= 0)
    await act(() => view.editor.chain().setTextSelection(position).insertContent('本次确认，').run()); await settle()
    assert.equal(view.changes.at(-1), expected.replace('夹层补充：', '夹层补充：本次确认，'))
    assert.equal(view.editor.state.selection.from, position + '本次确认，'.length, 'the main-first parent echo keeps the caret in the edited supplement')
    assert.equal(view.editor.state.selection.to, view.editor.state.selection.from)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), expected)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed'),
      [original.blocks.find(block => block.name === '设定图固定要求'), original.blocks.find(block => block.name === '项目画风约束'), original.blocks.find(block => block.name === '图片生成要求')])
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('board content edits in place without a redundant supplement field and keeps references, caret and undo', async () => {
  const primary = '【设定图固定要求】\n人物三视图，保持服装一致。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n保留纸张纹理。\n【项目画风约束结束】'
  const value = `${primary}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const original = structuredClone(sections.blocks.filter(block => block.kind === 'managed'))
  const view = await mount(value, { visualBoard: true, sectionDocument: sections })
  try {
    const first = view.editor.state.doc.firstChild!
    assert.equal(first.type.name, 'promptManagedSection')
    assert.equal(view.editor.state.doc.child(1).attrs.promptBodyEntry, false)
    assert.equal(view.container.querySelector('.pc-prompt-supplement-heading, .pc-prompt-supplement-line'), null)
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.changes, [])

    let position = -1
    view.editor.state.doc.descendants((node, offset) => { if (node.isText && node.text === '人物三视图，保持服装一致。') position = offset + node.nodeSize })
    assert.ok(position >= 0)
    const addition = ' 本次重点：袖口保持平整。'
    await act(() => view.editor.chain().setTextSelection(position).insertContent(addition).run()); await settle()
    const editedPrimary = primary.replace('保持服装一致。', `保持服装一致。${addition}`)
    assert.equal(view.changes.at(-1), `${editedPrimary}\n\n${style}`)
    assert.equal(view.editor.state.selection.from, position + addition.length)
    assert.equal(view.editor.state.selection.to, position + addition.length)
    assert.equal(view.editor.state.doc.child(1).attrs.promptBodyEntry, false)
    assert.equal(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed').length, original.length)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    await act(() => view.editor.commands.redo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), `${editedPrimary}\n\n${style}`)

    await act(() => view.editor.view.dispatch(closeHistory(view.editor.state.tr)))
    await act(() => view.editor.chain().setTextSelection(position + addition.length).insertContent('@雨').run())
    assert.match(document.querySelector('[role="option"]')!.textContent!, /雨衣状态/)
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); await settle()
    const withReference = `${editedPrimary.replace('本次重点：袖口保持平整。', '本次重点：袖口保持平整。[[ref:look]] ')}\n\n${style}`
    assert.equal(view.changes.at(-1), withReference)
    assert.equal(view.editor.state.selection.from, position + addition.length + 2, 'the chip and following space do not move the caret on echo')
    assert.equal(view.editor.state.selection.to, view.editor.state.selection.from)
    const copied = view.editor.view.someProp('clipboardTextSerializer', serialize => serialize(view.editor.state.doc.slice(0, view.editor.state.doc.content.size), view.editor.view))
    assert.equal(copied, withReference)
    const editedManaged = view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed')
    assert.deepEqual(editedManaged.map(block => block.id), original.map(block => block.id))
    assert.equal(editedManaged[0]!.sourceText, original[0]!.sourceText, 'in-place edits retain the source snapshot identity')
    assert.equal(editedManaged[1]!.text, original[1]!.text)
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('immediately clearing a board after picking a reference has a separate undo step from the reference insertion', async () => {
  const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n保留纸张纹理。\n【项目画风约束结束】'
  const supplement = '本次补充：配饰参考'
  const value = `${primary}\n\n${supplement}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { visualBoard: true, sectionDocument: sections })
  try {
    let position = -1
    view.editor.state.doc.descendants((node, offset) => { if (node.isText && node.text === supplement) position = offset + node.nodeSize })
    assert.ok(position >= 0)
    await act(() => view.editor.chain().setTextSelection(position).insertContent('@雨').run())
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    const withReference = `${primary}\n\n${supplement}[[ref:look]] \n\n${style}`
    assert.equal(promptEditorText(view.editor.getJSON()), withReference)
    await act(() => view.editor.chain().selectAll().deleteSelection().run())
    assert.equal(view.changes.at(-1), '')
    await act(() => view.editor.commands.undo())
    assert.equal(view.changes.at(-1), withReference, 'one undo restores the entire board including the newly selected reference')
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed'), sections.blocks.filter(block => block.kind === 'managed'))
    assert.deepEqual(view.referenceChanges, [], 'clearing and restoring the whole document keep actual image inputs')
    await act(() => view.editor.commands.undo())
    assert.doesNotMatch(promptEditorText(view.editor.getJSON()), /\[\[ref:look\]\]/, 'only the second undo can remove the inserted reference')
    assert.match(promptEditorText(view.editor.getJSON()), /【设定图固定要求】\n人物三视图。/)
  } finally { await view.destroy() }
})

test('ordinary prompt requirements stay compact without changing source metadata or clipboard content', async () => {
  const names = ['图片生成要求', '镜头视觉设定', '图片参考图用途', '项目画风约束']
  const value = '香炉近景，低饱和青灰夜色。\n\n' + names.map((name, index) =>
    `【${name}】\n${index === 0 ? '画面比例：16:9，清晰度要求：4K' : '保留场景和材质细节，参考[[ref:base]]。'}\n【${name}结束】`).join('\n\n')
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  let adjustments = 0
  const view = await mount(value, { sectionDocument: sections, onEditParameters: () => { adjustments++ }, parameterSummary: '16:9 · 4K' })
  try {
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section.is-secondary').length, 4)
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-summary.is-inline').length, 4)
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-origin, .pc-prompt-managed-edit-label, .pc-prompt-managed-state').length, 0)
    for (const name of names) {
      const block = view.container.querySelector<HTMLElement>(`[data-prompt-section-name="${name}"]`)!
      assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, true)
      assert.ok(button(`区块操作：${name}`, block))
    }
    await act(() => button('展开编辑：镜头视觉设定').click()); await settle()
    assert.equal(view.container.querySelector<HTMLElement>('[data-prompt-section-name="镜头视觉设定"] .pc-prompt-managed-panel')!.hidden, false)
    await act(() => button('收起设定：镜头视觉设定').click()); await settle()
    await adjustParameters('图片生成要求')
    assert.equal(adjustments, 1)
    await act(() => button('展开编辑：图片生成要求').click()); await settle()
    assert.equal(view.container.querySelector<HTMLElement>('[data-prompt-section-name="图片生成要求"] .pc-prompt-managed-panel')!.hidden, false)
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections), sections)
    const copied: Record<string, string> = {}
    await act(() => view.editor.commands.selectAll())
    const event = new dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { clearData: () => { for (const type of Object.keys(copied)) delete copied[type] }, setData: (type: string, text: string) => { copied[type] = text } } })
    await act(() => view.element.dispatchEvent(event))
    assert.equal(copied['text/plain'], value, 'copy includes folded requirements without UI labels')
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
  } finally { await view.destroy() }
})

test('board parameter requirements use the same disclosure as other rows and keep controls in the menu', async () => {
  const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n清晰度要求：2K\n【图片生成要求结束】'
  const value = `${primary}\n\n${parameters}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  let adjustments = 0
  const view = await mount(value, { visualBoard: true, sectionDocument: sections, parameterSummary: '16:9 · 2K', onEditParameters: () => { adjustments++ } })
  try {
    const block = view.container.querySelector<HTMLElement>('[data-prompt-section-name="图片生成要求"]')!
    assert.ok(block.querySelector('.pc-prompt-managed-toggle'))
    assert.ok(block.querySelector('.pc-prompt-managed-chevron'))
    assert.equal(block.querySelector('.pc-prompt-parameter-adjust'), null)
    assert.equal(block.querySelector('.pc-prompt-parameter-values')!.textContent, '16:9 · 2K')
    assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, true)
    await adjustParameters('图片生成要求')
    assert.equal(adjustments, 1)
    assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, true, 'the regular shortcut opens parameter controls')
    await act(() => button('展开编辑：图片生成要求', view.container).click()); await settle()
    assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, false)
    assert.match(block.querySelector('.pc-prompt-managed-panel')!.textContent!, /比例、清晰度等以底部生成参数为准/)
    let parameterPosition = -1
    view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.name === '图片生成要求') parameterPosition = offset })
    assert.ok(parameterPosition >= 0)
    await act(() => view.editor.chain().focus().setTextSelection(parameterPosition + 2).run()); await settle()
    await act(() => button('收起设定：图片生成要求', view.container).click()); await settle()
    assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, true)
    const parameterNode = view.editor.state.doc.nodeAt(parameterPosition)!
    assert.ok(!view.editor.isFocused || view.editor.state.selection.from <= parameterPosition
      || view.editor.state.selection.from >= parameterPosition + parameterNode.nodeSize,
    'closing advanced text keeps a focused caret outside the folded parameter section')
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections), sections)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
  } finally { await view.destroy() }
})

test('same-document parameter updates refresh the summary, callback and read-only controls without prompt edits', async () => {
  const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n清晰度要求：1K\n【图片生成要求结束】'
  const value = `${primary}\n\n${parameters}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const changes: string[] = [], adjustments: string[] = []
  async function render(parameterSummary: string, callbackName: string, readOnly = false) {
    await act(() => root.render(<MantineProvider env="test"><PromptEditor value={value} sectionDocument={sections}
      references={references} choices={choices} visualBoard parameterSummary={parameterSummary} readOnly={readOnly}
      onEditParameters={() => { adjustments.push(callbackName) }} onChange={next => { changes.push(next) }} /></MantineProvider>))
    await settle()
  }
  try {
    await render('16:9 · 1K', 'initial')
    const element = container.querySelector('[contenteditable]') as HTMLElement & { editor: Editor }
    const editor = element.editor
    const original = editor.getJSON()
    await adjustParameters('图片生成要求')
    assert.deepEqual(adjustments, ['initial'])
    await render('16:9 · 4K', 'updated')
    assert.equal(container.querySelector('.pc-prompt-parameter-values')!.textContent, '16:9 · 4K')
    await adjustParameters('图片生成要求')
    assert.deepEqual(adjustments, ['initial', 'updated'], 'the node view uses the latest callback with the same prompt document')
    assert.deepEqual(editor.getJSON(), original)
    assert.deepEqual(changes, [])

    await render('16:9 · 4K', 'read-only', true)
    assert.equal(editor.isEditable, false)
    const adjust = await sectionMenuAction('图片生成要求', '调整参数')
    assert.equal(adjust.disabled, true)
    await act(() => adjust.click())
    assert.equal(button('移除此段内容').disabled, true)
    await act(() => button('区块操作：图片生成要求', container).click()); await settle()
    await act(() => button('展开编辑：图片生成要求', container).click()); await settle()
    assert.equal(container.querySelector<HTMLElement>('[data-prompt-section-name="图片生成要求"] .pc-prompt-managed-panel')!.hidden, false)
    assert.deepEqual(adjustments, ['initial', 'updated'])
    assert.deepEqual(editor.getJSON(), original, 'runtime UI updates leave prompt text, source snapshots and identities intact')
    assert.deepEqual(changes, [])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('read-only and disabled boards retain comparison and full text while blocking removal and parameter changes', async t => {
  for (const mode of ['readOnly', 'disabled'] as const) await t.test(mode, async () => {
    const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
    const parameters = '【图片生成要求】\n画面比例：16:9\n清晰度要求：2K\n【图片生成要求结束】'
    const value = `${primary}\n\n${parameters}`
    const sections = parsePromptSectionDocument(value, { sourceText: value })
    let adjustments = 0
    const view = await mount(value, { visualBoard: true, sectionDocument: sections, [mode]: true, parameterSummary: '16:9 · 2K', onEditParameters: () => { adjustments++ } })
    try {
      assert.equal(view.editor.isEditable, false)
      const adjust = await sectionMenuAction('图片生成要求', '调整参数')
      assert.equal(adjust.disabled, true)
      await act(() => adjust.click())
      assert.equal(adjustments, 0)
      const remove = button('移除此段内容')
      assert.equal(remove.disabled, true)
      await act(() => remove.click())
      await act(() => button('区块操作：图片生成要求', view.container).click()); await settle()
      await act(() => button('展开编辑：图片生成要求', view.container).click()); await settle()
      const block = view.container.querySelector<HTMLElement>('[data-prompt-section-name="图片生成要求"]')!
      assert.equal(block.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, false)
      await act(() => button('区块操作：图片生成要求', view.container).click()); await settle()
      await act(() => button('查看与来源的差异').click()); await settle()
      assert.match(document.querySelector('[role="dialog"]')!.textContent!, /图片生成要求 · 内容对比/)
      assert.match(document.querySelector('[role="dialog"]')!.textContent!, /内容未变化/)
      assert.equal(promptEditorText(view.editor.getJSON()), value)
      assert.deepEqual(view.changes, [])
      assert.deepEqual(view.sectionChanges, [])
      assert.deepEqual(view.referenceChanges, [])
    } finally { await view.destroy() }
  })
})

test('rendering and syncing an authoritative same-text pasted primary never revives its deleted source identity', async () => {
  const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const source = parsePromptSectionDocument(primary, { sourceText: primary })
  const original = source.blocks.find(block => block.kind === 'managed')!
  original.pendingSourceText = primary.replace('人物', '来源人物')
  original.sourceStatus = 'source_changed'
  const removed = { ...original, text: '', deleted: true }
  const pasted = { id: 'pasted-primary-saved', kind: 'managed' as const, name: '设定图固定要求' as const, text: primary }
  const saved: PromptSectionDocument = { version: 1, blocks: [removed, pasted] }
  const loaded = await mount(primary, { sectionDocument: saved, visualBoard: true })
  try {
    assert.equal(loaded.container.querySelector('.pc-prompt-managed-section')!.getAttribute('data-prompt-section-id'), pasted.id)
    assert.equal(loaded.editor.getJSON().content!.find(node => node.type === 'promptManagedSection')!.attrs!.section.sourceText, undefined)
    await act(() => loaded.editor.commands.insertContentAt(sectionPosition(loaded.editor) + 2, '本次补充：'))
    const next = loaded.sectionChanges.at(-1)!
    assert.deepEqual(next.blocks.find(block => block.id === original.id), removed)
    const active = next.blocks.find(block => block.id === pasted.id)!
    assert.match(active.text, /本次补充：人物三视图/)
    assert.equal(active.sourceText, undefined)
    assert.equal(active.pendingSourceText, undefined)
  } finally { await loaded.destroy() }

  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const changes: PromptSectionDocument[] = []
  let replaceDocument: (next: PromptSectionDocument) => void = () => {}
  function Harness() {
    const [document, setDocument] = useState(source)
    replaceDocument = setDocument
    return <MantineProvider env="test"><PromptEditor value={serializePromptSectionDocument(document)} sectionDocument={document}
      references={references} choices={choices} visualBoard onChange={(_value, next) => { if (next) { changes.push(next); setDocument(next) } }} /></MantineProvider>
  }
  await act(() => root.render(<Harness />)); await settle()
  const element = container.querySelector('[contenteditable]') as HTMLElement & { editor: Editor }
  try {
    assert.equal(container.querySelector('.pc-prompt-managed-section')!.getAttribute('data-prompt-section-id'), original.id)
    await act(() => replaceDocument(saved)); await settle()
    assert.equal(container.querySelector('.pc-prompt-managed-section')!.getAttribute('data-prompt-section-id'), pasted.id,
      'external metadata changes are respected even when the serialized prompt is identical')
    await act(() => element.editor.commands.insertContentAt(sectionPosition(element.editor) + 2, '手动编辑：'))
    assert.deepEqual(changes.at(-1)!.blocks.find(block => block.id === original.id), removed)
    const active = changes.at(-1)!.blocks.find(block => block.id === pasted.id)!
    assert.equal(active.deleted, undefined)
    assert.equal(active.sourceText, undefined)
    assert.equal(active.pendingSourceText, undefined)
    await act(() => element.editor.commands.undo())
    assert.equal(promptEditorText(element.editor.getJSON()), primary)
    assert.deepEqual(changes.at(-1)!.blocks.find(block => block.id === original.id), removed)
    assert.equal(changes.at(-1)!.blocks.find(block => block.id === pasted.id)!.sourceText, undefined)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('programmatic text replacement retains source metadata for existing active identities', async () => {
  const source = '【镜头视觉设定】\n人物：蓝色校服\n场景：旧站台\n【镜头视觉设定结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const original = sections.blocks.find(block => block.kind === 'managed')!
  const view = await mount(source, { sectionDocument: sections })
  try {
    const changed = source.replace('蓝色校服', '用户指定的深蓝外套')
    await act(() => view.editor.chain().setMeta('promptDocumentReplace', true)
      .setContent(promptEditorDocument(changed, references), { emitUpdate: true }).run())
    const current = view.sectionChanges.at(-1)!.blocks.find(block => block.id === original.id)!
    assert.equal(current.text, changed)
    assert.equal(current.sourceText, original.sourceText)
    assert.equal(current.deleted, undefined)
  } finally { await view.destroy() }
})

function promptDialog(title: string) {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(node => {
    const label = node.getAttribute('aria-labelledby')
    return node.getAttribute('aria-label') === title || label?.split(' ').some(id => document.getElementById(id)?.textContent === title)
  })
  assert.ok(dialog, `dialog ${title}`)
  return dialog
}

async function openUnifiedRequirements(view: Awaited<ReturnType<typeof mount>>) {
  await act(() => button('查看固定设定', view.container).click()); await settle()
  return promptDialog('固定设定')
}

async function editUnifiedRequirement(view: Awaited<ReturnType<typeof mount>>, id: string) {
  const dialog = await openUnifiedRequirements(view)
  const action = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.getAttribute('aria-label')?.startsWith('单独编辑要求：') && node.getAttribute('aria-label')?.endsWith(` · ${id}`))
  assert.ok(action, `edit requirement ${id}`)
  const control = action.closest('.mantine-Accordion-item')?.querySelector<HTMLButtonElement>('.mantine-Accordion-control')
  if (control?.getAttribute('aria-expanded') === 'false') { await act(() => control.click()); await settle() }
  await act(() => action.click()); await settle()
}

function unifiedSection(view: Awaited<ReturnType<typeof mount>>, id: string) {
  const section = [...view.container.querySelectorAll<HTMLElement>('.pc-prompt-managed-section')]
    .find(node => node.dataset.promptSectionId === id)
  assert.ok(section, `section ${id}`)
  return section
}

test('compact readonly requirements and independent full preview preserve document, clipboard and the next undo step', async () => {
  const output = '【图片生成要求】\n背景保持夜景；暗部材质可辨。\n【图片生成要求结束】'
  const style = '【项目画风约束】\n保留木刻纹理。\n【项目画风约束结束】'
  const body = '无人物的藏面阁夜景。'
  const value = `${body}\n\n${output}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections })
  try {
    const original = view.editor.getJSON(), before = structuredClone(sections)
    const fullCopy = promptClipboardContent(view.editor, 'full')
    const bodyCopy = promptClipboardContent(view.editor, 'body')
    const sourceIds = sections.blocks.filter(block => block.kind === 'managed').map(block => block.id)
    assert.equal(view.container.querySelectorAll('.pc-prompt-requirement-choice').length, 0, 'no permanent catalogue occupies the prose editor')
    assert.ok(button('收起设定：主要创作内容', view.container), 'prose starts expanded')
    assert.equal(unifiedSection(view, sourceIds[0]!).hidden, true)
    assert.equal(unifiedSection(view, sourceIds[1]!).hidden, true)
    const fixed = await openUnifiedRequirements(view)
    assert.equal(fixed.querySelectorAll('pre').length, 2)
    assert.equal(fixed.querySelector('[contenteditable="true"], textarea, input'), null, 'settings inspection is read-only')
    assert.match(fixed.querySelector('[aria-label="图片生成要求只读内容"]')!.textContent!, /背景保持夜景/)
    assert.equal(fixed.querySelector('[aria-label*="视频生成要求"]'), null, 'missing types are not a catalogue entry')
    await act(() => button('关闭固定设定', fixed).click()); await settle()
    await editUnifiedRequirement(view, sourceIds[1]!)
    assert.equal(unifiedSection(view, sourceIds[0]!).hidden, true)
    assert.equal(unifiedSection(view, sourceIds[1]!).hidden, false)
    assert.equal(view.container.querySelector('[aria-label="要求显示范围"]'), null)
    assert.equal(view.container.querySelector('[data-requirement-id="missing:视频生成要求"]'), null)
    assert.equal(view.container.querySelector('.pc-prompt-requirement-choice-head small'), null)
    assert.equal(view.container.querySelector('.pc-prompt-detail-state'), null)
    assert.doesNotMatch(view.container.textContent!, /全部 11 种|当前生效/)
    await act(() => button('预览完整提示词', view.container).click()); await settle()
    const preview = promptDialog('完整提示词预览')
    assert.equal(preview.querySelector('pre')!.textContent, `【主要创作内容】\n${body}\n【主要创作内容结束】\n\n${output}\n\n${style}`)
    assert.equal(preview.querySelector('[contenteditable="true"], textarea, input'), null)
    assert.equal(view.container.querySelector('.pc-prompt-requirements-preview'), null, 'full preview is independent of the editing surface')
    await act(() => button('关闭完整提示词预览', preview).click()); await settle()
    await act(() => button('完成编辑：项目画风约束', unifiedSection(view, sourceIds[1]!)).click()); await settle()
    assert.equal(unifiedSection(view, sourceIds[1]!).hidden, true)
    assert.deepEqual(view.editor.getJSON(), original)
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections), before)
    assert.deepEqual(promptClipboardContent(view.editor, 'full'), fullCopy)
    assert.deepEqual(promptClipboardContent(view.editor, 'body'), bodyCopy)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    assert.deepEqual(view.referenceChanges, [])
    assert.equal(view.editor.can().undo(), false, 'presentation controls do not create undo history')

    await act(() => view.editor.chain().focus().setTextSelection(1).insertContent('本次：').run()); await settle()
    await editUnifiedRequirement(view, sourceIds[1]!)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value, 'one undo removes the content edit despite intervening requirement navigation')
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed'), before.blocks.filter(block => block.kind === 'managed'))
  } finally { await view.destroy() }
})

test('unified duplicate requirements select and edit their own IDs without inheriting a removed same-name source', async () => {
  const first = '【项目画风约束】\n第一块保留纸张纹理。\n【项目画风约束结束】'
  const second = '【项目画风约束】\n第二块保留绢本纹理。\n【项目画风约束结束】'
  const value = `主体构图。\n\n${first}\n\n${second}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const active = sections.blocks.filter(block => block.kind === 'managed')
  const firstId = active[0]!.id, secondId = active[1]!.id
  delete active[1]!.sourceText
  const removed = { ...active[0]!, id: 'previous-style-source', text: '', deleted: true,
    pendingSourceText: first.replace('纸张', '旧来源'), sourceStatus: 'source_changed' as const }
  sections.blocks.unshift(removed)
  const original = structuredClone(sections)
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections })
  try {
    const fixed = await openUnifiedRequirements(view)
    const actions = [...fixed.querySelectorAll<HTMLButtonElement>('[aria-label^="单独编辑要求："]')]
    assert.equal(actions.length, 2)
    assert.deepEqual(actions.map(node => node.getAttribute('aria-label')!.split(' · ').at(-1)), [firstId, secondId])
    assert.doesNotMatch(fixed.textContent!, /旧来源/, 'removed source records do not appear as active requirements')
    await act(() => button('关闭固定设定', fixed).click()); await settle()
    const firstDOM = unifiedSection(view, firstId), secondDOM = unifiedSection(view, secondId)
    await editUnifiedRequirement(view, secondId)
    assert.equal(firstDOM.hidden, true)
    assert.equal(secondDOM.hidden, false)
    assert.match(secondDOM.querySelector('.pc-prompt-managed-section-content')!.textContent!, /第二块保留绢本纹理/)
    assert.ok(button('完成编辑：项目画风约束', secondDOM))
    assert.deepEqual(view.changes, [])
    assert.deepEqual(promptEditorSectionDocument(view.editor.getJSON(), sections).blocks.filter(block => block.kind === 'managed'), original.blocks.filter(block => block.kind === 'managed'))
    assert.equal(promptEditorText(view.editor.getJSON()), value)

    let position = -1
    view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.id === secondId) position = offset + 2 })
    assert.ok(position >= 0)
    await act(() => view.editor.chain().focus().setTextSelection(position).insertContent('仅第二块：').run()); await settle()
    const updated = view.sectionChanges.at(-1)!
    assert.deepEqual(updated.blocks.find(block => block.id === firstId), original.blocks.find(block => block.id === firstId))
    assert.deepEqual(updated.blocks.find(block => block.id === removed.id), removed)
    assert.match(updated.blocks.find(block => block.id === secondId)!.text, /仅第二块：第二块/)
    assert.equal(updated.blocks.find(block => block.id === secondId)!.sourceText, undefined)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed'), original.blocks.filter(block => block.kind === 'managed'))
    assert.equal(unifiedSection(view, firstId), firstDOM, 'switching and editing never replaces the other content DOM')
    assert.equal(unifiedSection(view, secondId), secondDOM)
  } finally { await view.destroy() }
})

test('unified parameter details call the existing parameter action and preserve semantic output requirements', async () => {
  const output = '【视频生成要求】\n视频时长：5 秒\n首帧要求：保持首帧构图，连续运动，不切镜。\n【视频生成要求结束】'
  const parameters = '【生成参数约束】\n画面比例：16:9\n清晰度要求：1080p\n【生成参数约束结束】'
  const value = `从低门持续向供格推进。\n\n${output}\n\n${parameters}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const calls: string[] = []
  const view = await mount(value, { requirementsLayout: true, modality: 'video', sectionDocument: sections,
    parameterSummary: '16:9 · 1080p · 5 秒', onEditParameters: () => { calls.push('existing-panel') } })
  try {
    const original = view.editor.getJSON()
    const parameterId = sections.blocks.find(block => block.name === '生成参数约束')!.id
    const outputId = sections.blocks.find(block => block.name === '视频生成要求')!.id
    const fixed = await openUnifiedRequirements(view)
    const parametersControl = [...fixed.querySelectorAll<HTMLButtonElement>('[aria-label^="查看要求："]')]
      .find(node => node.getAttribute('aria-label')!.endsWith(` · ${parameterId}`))!
    assert.ok(parametersControl)
    if (parametersControl.getAttribute('aria-expanded') === 'false') { await act(() => parametersControl.click()); await settle() }
    const parameterPanel = parametersControl.closest('.mantine-Accordion-item')!
    assert.equal(parameterPanel.querySelector('[contenteditable="true"], textarea, input'), null)
    assert.equal(parameterPanel.querySelector('[aria-label^="单独编辑要求："]'), null, 'structured generation parameters are adjusted through the existing controls')
    await act(() => button('调整生成参数', parameterPanel).click()); await settle()
    assert.deepEqual(calls, ['existing-panel'])
    assert.equal(unifiedSection(view, parameterId).hidden, true)
    await editUnifiedRequirement(view, outputId)
    const semantics = unifiedSection(view, outputId).querySelector('.pc-prompt-managed-section-content')!
    assert.match(semantics.textContent!, /保持首帧构图，连续运动，不切镜/)
    assert.notEqual(semantics.getAttribute('contenteditable'), 'false', 'output semantics remain editable independently of structured controls')
    assert.deepEqual(view.editor.getJSON(), original)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.referenceChanges, [])
  } finally { await view.destroy() }
})

test('programmatic and keyboard selection reveal hidden unified details without changing the prompt', async () => {
  const output = '【图片生成要求】\n暗部保留材质。\n【图片生成要求结束】'
  const shot = '【镜头视觉设定】\n香炉位于右前景。\n【镜头视觉设定结束】'
  const style = '【项目画风约束】\n保留冷灰夜景。\n【项目画风约束结束】'
  const value = `从低门向内观察。\n\n${output}\n\n${shot}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections })
  try {
    const original = view.editor.getJSON()
    const shotId = sections.blocks.find(block => block.name === '镜头视觉设定')!.id
    const outputId = sections.blocks.find(block => block.name === '图片生成要求')!.id
    const shotDOM = unifiedSection(view, shotId)
    assert.equal(shotDOM.hidden, true)
    let shotPosition = -1
    view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.id === shotId) shotPosition = offset + 2 })
    await act(() => view.editor.chain().focus().setTextSelection(shotPosition).run()); await settle()
    assert.equal(shotDOM.hidden, false)
    assert.ok(button('完成编辑：镜头视觉设定', shotDOM))
    assert.equal(unifiedSection(view, outputId).hidden, true)

    let outputEnd = -1
    view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.id === outputId) outputEnd = offset + node.nodeSize })
    await act(() => view.editor.chain().focus().setTextSelection(outputEnd + 1).run()); await settle()
    await act(() => view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
    // ProseMirror's browser-native character movement is unavailable in jsdom;
    // simulate the resulting selection update that the arrow key produces.
    await act(() => view.editor.commands.setTextSelection(outputEnd - 2)); await settle()
    assert.equal(unifiedSection(view, outputId).hidden, false)
    assert.ok(button('完成编辑：图片生成要求', unifiedSection(view, outputId)))
    assert.equal(shotDOM.hidden, true)
    assert.deepEqual(view.editor.getJSON(), original)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
  } finally { await view.destroy() }
})

test('mouse selection of another current unified detail releases the hidden editing focus', async () => {
  const output = '【图片生成要求】\n暗部保留材质。\n【图片生成要求结束】'
  const style = '【项目画风约束】\n低饱和夜景。\n【项目画风约束结束】'
  const value = `从低门向内观察。\n\n${output}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections })
  try {
    const original = view.editor.getJSON()
    const outputId = sections.blocks.find(block => block.name === '图片生成要求')!.id
    const styleId = sections.blocks.find(block => block.name === '项目画风约束')!.id
    const focusDetail = async (id: string) => {
      let position = -1
      view.editor.state.doc.forEach((node, offset) => { if (node.type.name === 'promptManagedSection' && node.attrs.section.id === id) position = offset + 2 })
      assert.ok(position >= 0)
      await act(() => view.editor.chain().focus().setTextSelection(position).run()); await settle()
      assert.equal(view.editor.isFocused, true)
      assert.equal(document.activeElement, view.element)
      assert.equal(unifiedSection(view, id).hidden, false)
    }
    const chooseWithMouse = async (id: string) => {
      await editUnifiedRequirement(view, id)
      assert.equal(view.editor.isFocused, false, 'the newly hidden detail must not remain the keyboard input target')
      assert.notEqual(document.activeElement, view.element)
      const typingTarget = document.activeElement || document.body
      await act(() => typingTarget.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })))
      assert.deepEqual(view.editor.getJSON(), original)
    }

    await focusDetail(outputId)
    await chooseWithMouse(styleId)
    assert.equal(unifiedSection(view, outputId).hidden, true)
    assert.equal(unifiedSection(view, styleId).hidden, false)

    await focusDetail(styleId)
    await chooseWithMouse(outputId)
    assert.equal(unifiedSection(view, styleId).hidden, true)
    assert.equal(unifiedSection(view, outputId).hidden, false)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
  } finally { await view.destroy() }
})

test('unified reference edits undo with their source metadata while same-name removed records stay independent', async () => {
  const reference = '【图片参考图用途】\n[[ref:look]] 用于衣物材质。\n【图片参考图用途结束】'
  const style = '【项目画风约束】\n低饱和夜景。\n【项目画风约束结束】'
  const value = `无人物的藏面阁。\n\n${reference}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const referenceBlock = sections.blocks.find(block => block.name === '图片参考图用途')!
  referenceBlock.pendingSourceText = reference.replace('衣物材质', '衣物与布面褶皱')
  referenceBlock.mergeBaseText = reference
  referenceBlock.sourceStatus = 'source_changed'
  const removed = { ...sections.blocks.find(block => block.name === '项目画风约束')!, id: 'removed-old-style', text: '', deleted: true }
  sections.blocks.unshift(removed)
  const original = structuredClone(sections)
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections })
  try {
    await editUnifiedRequirement(view, referenceBlock.id)
    await act(() => button('编辑图片引用：雨衣状态', unifiedSection(view, referenceBlock.id)).click()); await settle()
    await act(() => button('夜景车站').click()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value.replace('[[ref:look]]', '[[ref:night]]'))
    assert.deepEqual(view.referenceChanges, [['look', 'night']])
    const edited = view.sectionChanges.at(-1)!
    const editedReference = edited.blocks.find(block => block.id === referenceBlock.id)!
    assert.equal(editedReference.sourceText, referenceBlock.sourceText!.replace('[[ref:look]]', '[[ref:night]]'))
    assert.equal(editedReference.pendingSourceText, referenceBlock.pendingSourceText!.replace('[[ref:look]]', '[[ref:night]]'))
    assert.equal(editedReference.mergeBaseText, referenceBlock.mergeBaseText!.replace('[[ref:look]]', '[[ref:night]]'))
    assert.deepEqual(edited.blocks.find(block => block.id === removed.id), removed)
    const styleId = sections.blocks.find(block => block.name === '项目画风约束' && !block.deleted)!.id
    await editUnifiedRequirement(view, styleId)
    await act(() => view.editor.chain().focus().undo().run()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value)
    assert.deepEqual(view.sectionChanges.at(-1)!.blocks.filter(block => block.kind === 'managed'), original.blocks.filter(block => block.kind === 'managed'))
    await editUnifiedRequirement(view, referenceBlock.id)
    assert.equal(unifiedSection(view, referenceBlock.id).hidden, false)
    assert.ok(button('编辑图片引用：雨衣状态', unifiedSection(view, referenceBlock.id)), 'the restored token uses its original bound reference')
  } finally { await view.destroy() }
})

test('compact setting-board requirements exclude the single editable primary rather than duplicating its contents', async () => {
  const primary = '【设定图固定要求】\n藏面阁主视图，低门与供架关系明确。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n沿用风格化 3D 画风。\n【项目画风约束结束】'
  const supplement = '细节图不要遮挡主视图。'
  const value = `${primary}\n\n${supplement}\n\n${style}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const primaryId = sections.blocks.find(block => block.name === '设定图固定要求')!.id
  const view = await mount(value, { requirementsLayout: true, visualBoard: true, modality: 'image', sectionDocument: sections })
  try {
    const original = view.editor.getJSON()
    const main = unifiedSection(view, primaryId)
    const contentDOM = main.querySelector('.pc-prompt-managed-section-content')!
    assert.equal(view.container.querySelectorAll('.pc-prompt-managed-section.is-primary').length, 1)
    assert.equal(main.querySelector('.pc-prompt-content-scope'), null)
    await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
    assert.equal(main.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, true)
    const fixed = await openUnifiedRequirements(view)
    assert.equal(fixed.querySelectorAll('.mantine-Accordion-item').length, 1)
    assert.match(fixed.textContent!, /项目画风约束/)
    assert.doesNotMatch(fixed.textContent!, /设定图固定要求|藏面阁主视图|细节图不要遮挡/, 'prose and its supplement do not appear again in the fixed list')
    assert.equal(fixed.querySelector('[contenteditable="true"]'), null)
    await act(() => button('关闭固定设定', fixed).click()); await settle()
    await act(() => button('展开编辑：主要创作内容', view.container).click()); await settle()
    assert.equal(main.querySelector<HTMLElement>('.pc-prompt-managed-panel')!.hidden, false)
    assert.equal(main.querySelector('.pc-prompt-managed-section-content'), contentDOM)
    assert.deepEqual(view.editor.getJSON(), original)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    assert.equal(promptClipboardContent(view.editor, 'full').text, value)
    assert.equal(promptClipboardContent(view.editor, 'body').text, `藏面阁主视图，低门与供架关系明确。\n\n${supplement}`)
  } finally { await view.destroy() }
})

test('compact fixed inspection supports all eleven active types while preserving removed metadata and read-only boundaries', async () => {
  const names = ['设定图固定要求', '图片生成要求', '项目画风约束', '镜头视觉设定', '图片参考图用途', '视频参考图用途',
    '视频生成要求', '基础身份参考', '基础版本与本次状态变化', '生成参考图', '生成参数约束']
  const value = `沿用现有对象事实与展示要求。\n\n${names.map(name => `【${name}】\n${name}的现有内容。\n【${name}结束】`).join('\n\n')}`
  const sections = parsePromptSectionDocument(value, { sourceText: value })
  const first = sections.blocks.find(block => block.kind === 'managed')!
  sections.blocks.unshift({ ...first, id: 'removed-legacy-requirement', text: '', deleted: true,
    pendingSourceText: '不得出现在生效列表的旧记录', sourceStatus: 'source_changed' })
  const before = structuredClone(sections)
  const view = await mount(value, { requirementsLayout: true, modality: 'image', sectionDocument: sections, readOnly: true })
  try {
    const original = view.editor.getJSON()
    assert.equal(view.container.querySelectorAll('.pc-prompt-requirement-choice').length, 0)
    assert.match(view.container.querySelector('[aria-label="固定设定摘要"]')!.textContent!, /设定与要求 · 11 项/)
    const fixed = await openUnifiedRequirements(view)
    const controls = [...fixed.querySelectorAll<HTMLButtonElement>('[aria-label^="查看要求："]')]
    assert.equal(controls.length, 11, 'all supported active types fit the on-demand settings view')
    assert.deepEqual(controls.map(node => node.textContent), names)
    assert.equal(fixed.querySelectorAll('pre').length, 11)
    assert.equal(fixed.querySelector('[contenteditable="true"], textarea, input'), null)
    assert.doesNotMatch(fixed.textContent!, /不得出现在生效列表的旧记录/)
    for (const action of fixed.querySelectorAll<HTMLButtonElement>('[aria-label^="单独编辑要求："]')) assert.equal(action.disabled, true)
    await act(() => button('关闭固定设定', fixed).click()); await settle()
    assert.deepEqual(view.editor.getJSON(), original)
    const after = promptEditorSectionDocument(view.editor.getJSON(), sections)
    assert.deepEqual(after.blocks.filter(block => block.kind === 'managed'), before.blocks.filter(block => block.kind === 'managed'))
    assert.equal(promptClipboardContent(view.editor, 'full').text, value)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    assert.equal(view.editor.can().undo(), false)
  } finally { await view.destroy() }
})

test('collapsing a focused unified board keeps its caret out of empty separators and preserves editing history', async () => {
  const primary = '【设定图固定要求】\n藏面阁主视图，低门与供架关系明确。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n沿用风格化 3D 画风。\n【项目画风约束结束】'
  const value = `${primary}\n\n${style}`
  const view = await mount(value, { requirementsLayout: true, visualBoard: true, modality: 'image' })
  try {
    const original = view.editor.getJSON()
    const contentDOM = view.container.querySelector('.is-primary .pc-prompt-managed-section-content')!
    await act(() => view.editor.chain().focus().setTextSelection(2).run()); await settle()
    assert.equal(view.editor.isFocused, true)
    const selection = view.editor.state.selection.from
    await act(() => button('收起设定：主要创作内容', view.container).click()); await settle()
    assert.equal(view.editor.isFocused, false, 'folding leaves no caret in a newly revealed blank row')
    assert.equal(view.editor.state.selection.from, selection, 'folding never parks the caret in a separator')
    assert.equal(view.container.querySelector('.pc-prompt-section-spacer.is-current'), null)
    assert.deepEqual(view.editor.getJSON(), original)
    assert.deepEqual(view.changes, [])
    assert.deepEqual(view.sectionChanges, [])
    await act(() => button('展开编辑：主要创作内容', view.container).click()); await settle()
    assert.equal(view.container.querySelector('.is-primary .pc-prompt-managed-section-content'), contentDOM)
    await act(() => view.editor.chain().focus().insertContent('本次：').run()); await settle()
    assert.equal(promptEditorText(view.editor.getJSON()), value.replace('藏面阁', '本次：藏面阁'))
    await act(() => view.editor.commands.undo()); await settle()
    assert.deepEqual(view.editor.getJSON(), original, 'one undo restores the edit without undoing folding')
  } finally { await view.destroy() }
})

test('StrictMode gives each editor its own requirements host without an observer loop', async () => {
  const { default: PromptSkillAction } = await import('../src/features/skills/PromptSkillAction')
  const BaseObserver = dom.window.MutationObserver
  let observations = 0, runaway = false
  // A shared widget can bounce forever between StrictMode's two initial
  // editors. Bound callbacks so a regression fails instead of hanging tests.
  class BoundedObserver extends BaseObserver {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        if (++observations > 50) { runaway = true; observer.disconnect(); return }
        callback(records as unknown as MutationRecord[], observer as unknown as MutationObserver)
      })
    }
  }
  Object.defineProperty(dom.window, 'MutationObserver', { configurable: true, value: BoundedObserver })
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: BoundedObserver })
  const value = '主体。\n\n【图片生成要求】\n暗部材质清楚。\n【图片生成要求结束】'
  let view: Awaited<ReturnType<typeof mount>> | undefined
  try {
    view = await mount(value, { requirementsLayout: true, modality: 'image', mainAction: <PromptSkillAction
      projectId="project" nodeId="node" modality="image" prompt={value} promptDocument models={[]} disabled={false}
      targetModelId="" shotId={null} ratio="16:9" duration={5} mode="text" referenceAssetIds={[]} onApply={() => {}} /> }, false, true)
    assert.equal(runaway, false, 'initial editors must not move the same widget between their views')
    const host = view.container.querySelector('.pc-prompt-requirements-host')
    assert.ok(host)
    assert.equal(view.container.querySelectorAll('.pc-prompt-requirements-host').length, 1)
    assert.ok(button('使用技能整理提示词', view.container))
    assert.equal(view.container.querySelectorAll('.pc-prompt-requirement-choice').length, 0)
    assert.ok(button('查看固定设定', view.container))
    assert.deepEqual(view.changes, [])
    await act(() => view!.editor.chain().focus().setTextSelection(1).insertContent('本次：').run()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-requirements-host'), host, 'typing retains this editor’s stable host')
    assert.equal(runaway, false)
  } finally {
    await view?.destroy()
    Object.defineProperty(dom.window, 'MutationObserver', { configurable: true, value: BaseObserver })
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: BaseObserver })
  }
})

test('removing board primary retains the prose heading and refinement action without restoring deleted facts', async () => {
  const primary = '【设定图固定要求】\n对象：旧面具\n需要展示：正面和侧面。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n保留冷灰画风。\n【项目画风约束结束】'
  const supplement = '当前补充正文。'
  const view = await mount(`${primary}\n\n${supplement}\n\n${style}`, { visualBoard: true, requirementsLayout: true,
    mainAction: <button type="button" data-test-refinement>整理提示词</button> })
  try {
    const action = await sectionMenuAction('主要创作内容', '移除区块')
    await act(() => action.click()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-managed-section.is-primary'), null)
    assert.equal(view.container.querySelectorAll('[data-test-refinement]').length, 1, 'remaining prose still has one refinement entry')
    assert.ok(button('收起设定：主要创作内容', view.container))
    assert.equal(view.container.querySelector('.pc-prompt-supplement-heading'), null, 'standalone prose is no longer labeled as a supplement')
    assert.match(view.element.textContent!, /当前补充正文/)
    const removed = view.sectionChanges.at(-1)!.blocks.find(block => block.name === '设定图固定要求')!
    assert.equal(removed.deleted, true)
    assert.doesNotMatch(promptClipboardContent(view.editor, 'full').text, /旧面具/)
    await act(() => view.editor.commands.undo()); await settle()
    assert.equal(view.container.querySelectorAll('[data-test-refinement]').length, 1)
    assert.ok(view.container.querySelector('.pc-prompt-managed-section.is-primary'))
    assert.match(promptClipboardContent(view.editor, 'full').text, /旧面具/)
  } finally { await view.destroy() }
})
