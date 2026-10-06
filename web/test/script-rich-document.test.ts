import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { parseScriptDocument, serializeScriptDocument } from '../src/script-rich-document.ts'
import { textDocumentText } from '../src/text-document.ts'

function roundTrip(value: string): [JSONContent, string, JSONContent] {
  const parsed = parseScriptDocument(value)
  const markdown = serializeScriptDocument(parsed)
  return [parsed, markdown, parseScriptDocument(markdown)]
}

test('recognizes compact Chinese headings from generated outlines without blank separators', () => {
  const source = '#全剧故事大纲\n##项目信息\n项目名称：未命名项目\n##故事主线\n正文\n###人物目标\n目标正文'
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(parsed.content?.map(node => [node.type, node.attrs?.level, textDocumentText(node)]), [
    ['heading', 1, '全剧故事大纲'],
    ['heading', 2, '项目信息'],
    ['paragraph', undefined, '项目名称：未命名项目'],
    ['heading', 2, '故事主线'],
    ['paragraph', undefined, '正文'],
    ['heading', 3, '人物目标'],
    ['paragraph', undefined, '目标正文'],
  ])
  assert.match(markdown, /^# 全剧故事大纲\n\n## 项目信息/)
  assert.deepEqual(reloaded, parsed)
})

test('recognizes numeric Chinese headings in director replies at paragraph and list boundaries', () => {
  const source = '先确认故事方向。\n##20集暂定总体结构\n目前按20集推进。\n- 第一阶段\n###1至5集家庭记忆裂缝\n调查旧相框。'
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(parsed.content?.map(node => [node.type, node.attrs?.level, textDocumentText(node)]), [
    ['paragraph', undefined, '先确认故事方向。'],
    ['heading', 2, '20集暂定总体结构'],
    ['paragraph', undefined, '目前按20集推进。'],
    ['bulletList', undefined, '第一阶段'],
    ['heading', 3, '1至5集家庭记忆裂缝'],
    ['paragraph', undefined, '调查旧相框。'],
  ])
  assert.match(markdown, /## 20集暂定总体结构/)
  assert.deepEqual(reloaded, parsed)
})

test('preserves literal compact heading markers, hashtags and inline hashes', () => {
  for (const text of ['#全剧故事大纲', '##项目信息', '###人物目标', '##20集暂定总体结构', '###1至5集家庭记忆裂缝', '#tag', '#123', '编号 #全剧故事大纲']) {
    const document: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    assert.deepEqual(parseScriptDocument(serializeScriptDocument(document)), document)
  }
  for (const text of ['#tag', '#123', '##2026', '##123abc', '编号 #全剧故事大纲', '编号 ##20集', '\\#全剧故事大纲', '\\##20集', '####更深层标题']) {
    assert.equal(parseScriptDocument(text).content?.[0]?.type, 'paragraph')
  }
})

test('round trips headings, Chinese marks, combined marks, hard breaks, quote and nested lists', () => {
  const source = [
    '# 故事大纲',
    '',
    '## 核心冲突',
    '',
    '### 视觉节奏',
    '',
    '正文 **粗体**、_中文斜体_、~~删除线~~，以及 **加粗_加粗斜体_**。\\',
    '下一行。',
    '',
    '> 引用第一行',
    '> 引用第二行',
    '',
    '- 第一项',
    '- 第二项',
    '  - 嵌套一',
    '  - 嵌套二',
    '',
    '3. 第三项',
    '4. 第四项',
  ].join('\n')
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(reloaded, parsed)
  assert.match(markdown, /\*\*粗体\*\*/)
  assert.match(markdown, /_中文斜体_/)
  assert.match(markdown, /~~删除线~~/)
  assert.match(markdown, /\*\*加粗_加粗斜体_\*\*/)
  assert.equal(parsed.content?.find(node => node.type === 'blockquote')?.type, 'blockquote')
  const bullet = parsed.content?.find(node => node.type === 'bulletList')
  assert.equal(bullet?.content?.[1]?.content?.[1]?.type, 'bulletList')
  assert.equal(parsed.content?.find(node => node.type === 'orderedList')?.attrs?.start, 3)
})

test('keeps escaped prose literal and does not turn it into formatting', () => {
  const source = String.raw`\*literal asterisk\* and \_literal underscore\_ and \~\~literal\~\~ and \# heading`
  const parsed = parseScriptDocument(source)
  const paragraph = parsed.content?.[0]
  assert.equal(paragraph?.type, 'paragraph')
  assert.equal(paragraph?.content?.every(node => !node.marks), true)
  assert.equal(paragraph?.content?.map(node => node.text || '').join(''), '*literal asterisk* and _literal underscore_ and ~~literal~~ and # heading')
  assert.equal(parseScriptDocument(serializeScriptDocument(parsed)).content?.[0]?.content?.map(node => node.text || '').join(''), '*literal asterisk* and _literal underscore_ and ~~literal~~ and # heading')
})

test('preserves a document created by the Tiptap editor across Markdown persistence', () => {
  const document: JSONContent = {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '片头', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [
        { type: 'text', text: '中文', marks: [{ type: 'italic' }] },
        { type: 'text', text: '组合', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }] },
        { type: 'hardBreak' },
        { type: 'text', text: '第二行' },
      ] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旁白' }] }] },
      { type: 'orderedList', attrs: { start: 7 }, content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '七' }] }, { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '子项' }] }] },
        ] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '八' }] }] },
      ] },
    ],
  }
  const markdown = serializeScriptDocument(document)
  assert.match(markdown, /_中文_/)
  assert.match(markdown, /\*\*_~~组合~~_\*\*/)
  assert.match(markdown, /7\. 七\n   - 子项\n8\. 八/)
  assert.deepEqual(parseScriptDocument(markdown), document)
  assert.equal(serializeScriptDocument(parseScriptDocument(markdown)), markdown)
})
