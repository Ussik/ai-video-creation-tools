import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import {
  normalizeTextDocument, plainTextDocument, resolveTextDocument, textDocumentText,
} from '../src/text-document.ts'

test('plain text preserves blank lines, whitespace, and a trailing newline', () => {
  for (const text of ['', '第一场', '第一场\n第二场', '\n第一场\n\n第二场\n', '  保留缩进  \n\n']) {
    assert.equal(textDocumentText(plainTextDocument(text)), text)
  }
  assert.deepEqual(plainTextDocument('开场\n\n'), {
    type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '开场' }] },
      { type: 'paragraph' },
      { type: 'paragraph' },
    ],
  })
})

const formattedDocument: JSONContent = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '雨夜' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '少年', marks: [{ type: 'bold' }] },
      { type: 'text', text: '拔剑', marks: [{ type: 'italic' }] },
      { type: 'hardBreak' },
      { type: 'text', text: '雷声响起' },
    ] },
    { type: 'orderedList', attrs: { start: 3 }, content: [
      { type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '近景' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '手握剑柄' }] }] },
        ] },
      ] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '远景' }] }] },
    ] },
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'text', text: '结束' }] },
  ],
}

test('headings, inline marks, nested lists, and rules serialize as plain model text', () => {
  assert.equal(textDocumentText(formattedDocument), '雨夜\n少年拔剑\n雷声响起\n近景\n手握剑柄\n远景\n\n结束')
})

test('normalization strips null and unrelated attributes, unsupported marks, and duplicate marks', () => {
  const doc: JSONContent = {
    type: 'doc', attrs: { language: null }, extra: true, content: [
      { type: 'heading', attrs: { level: 3, textAlign: null, class: 'title' }, content: [
        { type: 'text', text: '标题', attrs: { color: 'red' }, marks: [
          { type: 'bold', attrs: { style: null } },
          { type: 'italic' },
          { type: 'link', attrs: { href: 'https://example.com' } },
          { type: 'bold' },
        ] },
      ] },
      { type: 'orderedList', attrs: { start: 3, type: null }, content: [
        { type: 'listItem', attrs: { checked: null }, content: [{ type: 'paragraph', attrs: { textAlign: null } }] },
      ] },
      { type: 'orderedList', attrs: { start: null }, content: [
        { type: 'listItem', content: [{ type: 'paragraph' }] },
      ] },
    ],
  }
  const before = structuredClone(doc)
  const normalized = normalizeTextDocument(doc)
  assert.deepEqual(normalized, {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 3 }, content: [
        { type: 'text', text: '标题', marks: [{ type: 'bold' }, { type: 'italic' }] },
      ] },
      { type: 'orderedList', attrs: { start: 3 }, content: [
        { type: 'listItem', content: [{ type: 'paragraph' }] },
      ] },
      { type: 'orderedList', content: [
        { type: 'listItem', content: [{ type: 'paragraph' }] },
      ] },
    ],
  })
  assert.deepEqual(doc, before)
  assert.equal(textDocumentText(normalized), textDocumentText(doc))
})

test('matching plain text reuses formatting, while external changes replace stale documents', () => {
  const text = textDocumentText(formattedDocument)
  assert.equal(resolveTextDocument(text, formattedDocument), formattedDocument)
  const externalText = '故事板修改后的正文\n\n保留空行'
  assert.deepEqual(resolveTextDocument(externalText, formattedDocument), plainTextDocument(externalText))
  assert.deepEqual(resolveTextDocument('', formattedDocument), plainTextDocument(''))
  assert.deepEqual(resolveTextDocument(externalText), plainTextDocument(externalText))
  assert.deepEqual(resolveTextDocument(externalText, null), plainTextDocument(externalText))
})
