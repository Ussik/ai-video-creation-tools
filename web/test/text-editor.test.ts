import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { Editor, type JSONContent } from '@tiptap/core'
import { applyTextFormat, textEditorExtensions } from '../src/shared/lib/editor/text-editor.ts'
import { normalizeTextDocument, plainTextDocument, textDocumentText } from '../src/shared/lib/editor/text-document.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'DOMParser', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: clearTimeout })
const emptyRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => emptyRect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
after(() => dom.window.close())

function withEditor(content: string | JSONContent, run: (editor: Editor) => void) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: textEditorExtensions(), content: typeof content === 'string' ? plainTextDocument(content) : content })
  try { run(editor) } finally { editor.destroy(); element.remove() }
}

function rangeFor(editor: Editor, text: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, position) => {
    if (result || !node.isText) return
    const offset = node.text!.indexOf(text)
    if (offset >= 0) result = { from: position + offset, to: position + offset + text.length }
  })
  assert.ok(result, `正文中应存在 ${text}`)
  return result
}

function selectText(editor: Editor, text: string) {
  editor.commands.setTextSelection(rangeFor(editor, text))
}

function inlineContent(editor: Editor, block = 0): JSONContent[] {
  return normalizeTextDocument(editor.getJSON()).content?.[block]?.content || []
}

test('heading commands transform old plain text into headings without inserting Markdown characters', () => {
  withEditor('雨夜追逐\n雷声响起', editor => {
    editor.commands.setTextSelection(2)
    assert.equal(applyTextFormat(editor, 'h1'), true)
    assert.equal(editor.getJSON().content?.[0]?.type, 'heading')
    assert.equal(editor.getJSON().content?.[0]?.attrs?.level, 1)
    assert.equal(editor.view.dom.querySelector('h1')?.textContent, '雨夜追逐')
    assert.equal(applyTextFormat(editor, 'h2'), true)
    assert.equal(editor.getJSON().content?.[0]?.attrs?.level, 2)
    assert.equal(editor.view.dom.querySelector('h1'), null)
    assert.equal(editor.view.dom.querySelector('h2')?.textContent, '雨夜追逐')
    assert.equal(textDocumentText(editor.getJSON()), '雨夜追逐\n雷声响起')
    assert.equal(editor.getText().includes('#'), false)
  })
})

test('bold and italic affect only selected text and toggle off on the next click', () => {
  withEditor('少年拔剑冲向桥头', editor => {
    selectText(editor, '拔剑')
    assert.equal(applyTextFormat(editor, 'bold'), true)
    assert.equal(applyTextFormat(editor, 'italic'), true)
    assert.deepEqual(inlineContent(editor), [
      { type: 'text', text: '少年' },
      { type: 'text', text: '拔剑', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'text', text: '冲向桥头' },
    ])
    assert.equal(editor.view.dom.querySelector('strong em')?.textContent, '拔剑')
    assert.equal(applyTextFormat(editor, 'bold'), true)
    assert.deepEqual(inlineContent(editor)[1]?.marks, [{ type: 'italic' }])
    assert.equal(applyTextFormat(editor, 'italic'), true)
    assert.deepEqual(inlineContent(editor), [{ type: 'text', text: '少年拔剑冲向桥头' }])
  })
})

test('list commands wrap multiple paragraphs and the paragraph command restores the selected items', () => {
  withEditor('开场\n追逐\n结束', editor => {
    const first = rangeFor(editor, '开场')
    const second = rangeFor(editor, '追逐')
    editor.commands.setTextSelection({ from: first.from, to: second.to })
    assert.doesNotThrow(() => assert.equal(applyTextFormat(editor, 'bulletList'), true), '跨段段落转换为项目列表')
    assert.equal(editor.getJSON().content?.[0]?.type, 'bulletList')
    assert.equal(editor.getJSON().content?.[0]?.content?.length, 2)
    assert.equal(editor.view.dom.querySelectorAll('ul > li').length, 2)
    assert.equal(editor.getJSON().content?.[1]?.type, 'paragraph')
    assert.doesNotThrow(() => assert.equal(applyTextFormat(editor, 'orderedList'), true), '项目列表转换为编号列表')
    assert.equal(editor.getJSON().content?.[0]?.type, 'orderedList')
    assert.equal(editor.view.dom.querySelectorAll('ol > li').length, 2)
    assert.doesNotThrow(() => assert.equal(applyTextFormat(editor, 'paragraph'), true), '跨段列表项转换回普通段落')
    assert.deepEqual(editor.getJSON().content?.map(node => node.type), ['paragraph', 'paragraph', 'paragraph'])
    assert.equal(textDocumentText(editor.getJSON()), '开场\n追逐\n结束')
    assert.equal(editor.view.dom.querySelector('ul, ol'), null)
  })
})

test('clear with a caret clears its current line while preserving neighbouring headings and marks', () => {
  withEditor({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '片头', marks: [{ type: 'bold' }] }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '雨夜', marks: [{ type: 'bold' }, { type: 'italic' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '远景', marks: [{ type: 'italic' }] }] },
  ] }, editor => {
    editor.commands.setTextSelection(rangeFor(editor, '雨夜').from + 1)
    assert.equal(applyTextFormat(editor, 'clear'), true)
    assert.deepEqual(normalizeTextDocument(editor.getJSON()).content, [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '片头', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '雨夜' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '远景', marks: [{ type: 'italic' }] }] },
    ])
  })
})

test('clear with a text range removes only its selected marks', () => {
  withEditor({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '强风雨夜急促', marks: [{ type: 'bold' }, { type: 'italic' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '另一场', marks: [{ type: 'bold' }] }] },
  ] }, editor => {
    selectText(editor, '雨夜')
    assert.equal(applyTextFormat(editor, 'clear'), true)
    assert.deepEqual(inlineContent(editor), [
      { type: 'text', text: '强风', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'text', text: '雨夜' },
      { type: 'text', text: '急促', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ])
    assert.deepEqual(inlineContent(editor, 1), [{ type: 'text', text: '另一场', marks: [{ type: 'bold' }] }])
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), '雨夜')
  })
})

test('the rule command inserts a real horizontalRule node and hr element', () => {
  withEditor('雨夜\n追逐', editor => {
    editor.commands.setTextSelection(rangeFor(editor, '雨夜').to)
    assert.equal(applyTextFormat(editor, 'rule'), true)
    assert.ok(editor.getJSON().content?.some(node => node.type === 'horizontalRule'))
    assert.equal(editor.view.dom.querySelectorAll('hr').length, 1)
    assert.equal(editor.getText().includes('---'), false)
    assert.equal(editor.state.doc.textContent, '雨夜追逐')
  })
})

test('formatting can be undone and redone without altering the text', () => {
  withEditor('雨夜追逐', editor => {
    editor.commands.setTextSelection(2)
    applyTextFormat(editor, 'h3')
    const formatted = normalizeTextDocument(editor.getJSON())
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(normalizeTextDocument(editor.getJSON()), plainTextDocument('雨夜追逐'))
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(normalizeTextDocument(editor.getJSON()), formatted)
    assert.equal(textDocumentText(formatted), '雨夜追逐')
  })
})

test('normalized editor JSON reloads with the same formatting and model-facing plain text', () => {
  withEditor('雨夜\n少年拔剑\n追逐\n结束', editor => {
    editor.commands.setTextSelection(rangeFor(editor, '雨夜').from)
    applyTextFormat(editor, 'h2')
    selectText(editor, '少年')
    applyTextFormat(editor, 'bold')
    selectText(editor, '拔剑')
    applyTextFormat(editor, 'italic')
    editor.commands.setTextSelection({ from: rangeFor(editor, '追逐').from, to: rangeFor(editor, '结束').to })
    applyTextFormat(editor, 'orderedList')
    editor.commands.updateAttributes('orderedList', { start: 3 })
    const saved = normalizeTextDocument(editor.getJSON())
    const text = textDocumentText(saved)
    assert.equal(text, '雨夜\n少年拔剑\n追逐\n结束')
    withEditor(JSON.parse(JSON.stringify(saved)) as JSONContent, reloaded => {
      assert.deepEqual(normalizeTextDocument(reloaded.getJSON()), saved)
      assert.equal(textDocumentText(reloaded.getJSON()), text)
      assert.equal(reloaded.view.dom.querySelector('h2')?.textContent, '雨夜')
      assert.equal(reloaded.view.dom.querySelector('strong')?.textContent, '少年')
      assert.equal(reloaded.view.dom.querySelector('em')?.textContent, '拔剑')
      assert.equal(reloaded.view.dom.querySelector('ol')?.getAttribute('start'), '3')
      assert.equal(reloaded.view.dom.querySelectorAll('ol > li').length, 2)
    })
  })
})

test('oversized edits are rejected before they can become unsavable canvas content', () => {
  withEditor('保留原文', editor => {
    const original = editor.getJSON()
    editor.commands.setContent(plainTextDocument('字'.repeat(20001)))
    assert.deepEqual(editor.getJSON(), original)
    editor.commands.setContent(plainTextDocument('\n'.repeat(2000)))
    assert.deepEqual(editor.getJSON(), original)
  })
})
