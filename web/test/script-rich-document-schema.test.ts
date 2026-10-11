import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { JSDOM } from 'jsdom'
import { Editor, type JSONContent } from '@tiptap/core'
import { normalizeTextDocument, textDocumentText } from '../src/text-document.ts'
import { scriptEditorExtensions } from '../src/script-editor-extensions.ts'
import { parseScriptDocument, serializeScriptDocument } from '../src/script-rich-document.ts'

// Tiptap only needs a small DOM shim to validate the codec output. Keeping the
// check here catches invalid attrs or node nesting that a plain JSON equality
// test would miss.
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

function withEditor(content: JSONContent, run: (editor: Editor) => void) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: scriptEditorExtensions(), content })
  try { run(editor) } finally { editor.destroy(); element.remove() }
}

test('real script editor edits tables, supports undo and reloads cell formatting and line breaks', () => {
  const original = parseScriptDocument('| 关系 | 变化 |\n| :--- | ---: |\n| 林晚与奶奶 | 依赖转为理解 |')
  withEditor(original, editor => {
    assert.equal(editor.view.dom.querySelectorAll('.tableWrapper table').length, 1)
    assert.equal(editor.view.dom.querySelectorAll('th[scope="col"]').length, 2)
    assert.equal(editor.view.dom.querySelector('td:last-child')?.getAttribute('style'), 'text-align: right;')
    let target = 0
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === '依赖转为理解') target = pos })
    editor.commands.setTextSelection({ from: target, to: target + '依赖转为理解'.length })
    editor.commands.insertContent([
      { type: 'text', text: '误解|冲突', marks: [{ type: 'bold' }] },
      { type: 'hardBreak' },
      { type: 'text', text: '理解与信任', marks: [{ type: 'italic' }] },
    ])
    const edited = normalizeTextDocument(editor.getJSON())
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(normalizeTextDocument(editor.getJSON()), original)
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(normalizeTextDocument(editor.getJSON()), edited)
    editor.state.doc.check()
    const markdown = serializeScriptDocument(edited)
    withEditor(parseScriptDocument(markdown), reloaded => {
      assert.deepEqual(normalizeTextDocument(reloaded.getJSON()), edited)
      assert.equal(reloaded.view.dom.querySelector('td strong')?.textContent, '误解|冲突')
      assert.equal(reloaded.view.dom.querySelector('td em')?.textContent, '理解与信任')
      assert.equal(reloaded.view.dom.querySelectorAll('td br:not(.ProseMirror-trailingBreak)').length, 1)
    })
  })
})

test('multiple paragraphs typed inside a cell retain every line and mark after Markdown storage', () => {
  const doc = parseScriptDocument('| 人物 | 说明 |\n| --- | --- |\n| 林晚 | 第一行 |')
  doc.content![0].content![1].content![1].content!.push({ type: 'paragraph', content: [{ type: 'text', text: '第二行', marks: [{ type: 'strike' }] }] })
  withEditor(doc, editor => {
    const before = textDocumentText(editor.getJSON())
    withEditor(parseScriptDocument(serializeScriptDocument(normalizeTextDocument(editor.getJSON()))), reloaded => {
      assert.equal(textDocumentText(reloaded.getJSON()), before)
      assert.equal(reloaded.view.dom.querySelector('td s')?.textContent, '第二行')
    })
  })
})

test('compact Chinese outline headings render as real Tiptap headings and survive saving', () => {
  const parsed = parseScriptDocument('#全剧故事大纲\n##20集暂定总体结构\n正文\n###1至5集家庭记忆裂缝\n目标正文')
  withEditor(parsed, editor => {
    assert.equal(editor.view.dom.querySelector('h1')?.textContent, '全剧故事大纲')
    assert.equal(editor.view.dom.querySelector('h2')?.textContent, '20集暂定总体结构')
    assert.equal(editor.view.dom.querySelector('h3')?.textContent, '1至5集家庭记忆裂缝')
    const stored = serializeScriptDocument(normalizeTextDocument(editor.getJSON()))
    withEditor(parseScriptDocument(stored), reloaded => {
      assert.equal(reloaded.view.dom.querySelector('h2')?.textContent, '20集暂定总体结构')
      assert.deepEqual(normalizeTextDocument(reloaded.getJSON()), normalizeTextDocument(editor.getJSON()))
    })
  })
})

test('compact book titles and numbered headings render with heading styles and survive saving', () => {
  const parsed = parseScriptDocument('#《旧祠堂门》全剧故事大纲\n##编剧视角总述\n正文\n##1.林晚与奶奶\n关系正文')
  withEditor(parsed, editor => {
    assert.equal(editor.view.dom.querySelector('h1')?.textContent, '《旧祠堂门》全剧故事大纲')
    assert.deepEqual(Array.from(editor.view.dom.querySelectorAll('h2'), node => node.textContent), ['编剧视角总述', '1.林晚与奶奶'])
    assert.equal(editor.view.dom.textContent?.includes('#'), false)
    const stored = serializeScriptDocument(normalizeTextDocument(editor.getJSON()))
    withEditor(parseScriptDocument(stored), reloaded => {
      assert.deepEqual(normalizeTextDocument(reloaded.getJSON()), normalizeTextDocument(editor.getJSON()))
      assert.equal(reloaded.view.dom.querySelector('h1')?.textContent, '《旧祠堂门》全剧故事大纲')
    })
  })
})

test('serialized rich script content is accepted by the real Tiptap schema', () => {
  const original: JSONContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '片头', marks: [{ type: 'bold' }, { type: 'italic' }] }] },
      { type: 'paragraph', content: [
        { type: 'text', text: '正文', marks: [{ type: 'bold' }] },
        { type: 'text', text: '强调', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }] },
        { type: 'hardBreak' },
        { type: 'text', text: '第二行' },
      ] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旁白' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '场景' }] },
        { type: 'orderedList', attrs: { start: 4 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '镜头' }] }] }] },
      ] }] },
      { type: 'horizontalRule' },
      { type: 'paragraph' },
    ],
  }

  withEditor(original, editor => {
    const source = normalizeTextDocument(editor.getJSON())
    const markdown = serializeScriptDocument(source)
    const parsed = parseScriptDocument(markdown)
    withEditor(parsed, reloaded => {
      assert.deepEqual(normalizeTextDocument(reloaded.getJSON()), parsed)
      assert.equal(reloaded.view.dom.querySelector('h1')?.textContent, '片头')
      assert.equal(reloaded.view.dom.querySelector('strong em')?.textContent, '片头')
      assert.equal(reloaded.view.dom.querySelector('s')?.textContent, '强调')
      assert.equal(reloaded.view.dom.querySelector('ul > li ol[start="4"]')?.textContent, '镜头')
      assert.equal(reloaded.view.dom.querySelector('hr') instanceof dom.window.HTMLHRElement, true)
      assert.equal(reloaded.view.dom.querySelectorAll('p').length >= 2, true)
    })
  })
})

test('adjacent marks and empty paragraphs remain stable in Markdown storage', () => {
  const source: JSONContent = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
        { type: 'text', text: '斜体', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: '  ' },
        { type: 'text', text: '删除', marks: [{ type: 'strike' }] },
      ] },
      { type: 'paragraph' },
      { type: 'paragraph' },
    ],
  }
  const markdown = serializeScriptDocument(source)
  assert.equal(markdown, '**加粗_斜体_**  ~~删除~~\n\n\n\n')
  assert.deepEqual(parseScriptDocument(markdown), source)
})

test('literal block markers are escaped so they do not become structure on reload', () => {
  const source: JSONContent = {
    type: 'doc',
    content: ['---', '***', '___', '> quote', '- list', '1. item'].map(text => ({
      type: 'paragraph', content: [{ type: 'text', text }],
    })),
  }
  const markdown = serializeScriptDocument(source)
  assert.match(markdown, /\\---/)
  assert.match(markdown, /\\\*\\\*\\\*/)
  assert.match(markdown, /\\> quote/)
  assert.deepEqual(parseScriptDocument(markdown), source)
})
