import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { JSDOM } from 'jsdom'
import { Editor, type JSONContent } from '@tiptap/core'
import { normalizeTextDocument } from '../src/text-document.ts'
import { textEditorExtensions } from '../src/text-editor.ts'
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
  const editor = new Editor({ element, extensions: textEditorExtensions(), content })
  try { run(editor) } finally { editor.destroy(); element.remove() }
}

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
