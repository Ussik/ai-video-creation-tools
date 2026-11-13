import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { omitRepeatedScriptTitle, parseScriptDocument, serializeScriptDocument } from '../src/features/script/script-rich-document.ts'
import { textDocumentText } from '../src/shared/lib/editor/text-document.ts'

function roundTrip(value: string): [JSONContent, string, JSONContent] {
  const parsed = parseScriptDocument(value)
  const markdown = serializeScriptDocument(parsed)
  return [parsed, markdown, parseScriptDocument(markdown)]
}

test('document bodies omit only the leading heading matching their title without mutating source content', () => {
  for (const heading of ['# 概要设计', '##概要设计', '# **概要**_设计_']) {
    const document = parseScriptDocument(`${heading}\n\n## 核心冲突\n\n凛在**地下**救援。\n\n## 概要设计\n\n后续小节。`)
    const original = JSON.stringify(document)
    const body = omitRepeatedScriptTitle(document, ' 概要设计 ')
    assert.deepEqual(body.content, document.content!.slice(1))
    assert.equal(textDocumentText(body.content![0]), '核心冲突')
    assert.equal(textDocumentText(body.content![2]), '概要设计', 'later headings remain intact')
    assert.equal(JSON.stringify(document), original)
    assert.equal(omitRepeatedScriptTitle(body, '概要设计'), body, 'normalization is stable')
  }
  for (const value of ['## 核心冲突\n\n正文。', '概要设计\n\n正文。', '正文。\n\n# 概要设计']) {
    const document = parseScriptDocument(value)
    assert.equal(omitRepeatedScriptTitle(document, '概要设计'), document, 'keeps nonmatching headings and prose')
  }
  const document = parseScriptDocument('# 概要设计')
  assert.equal(omitRepeatedScriptTitle(document), document)
  assert.equal(omitRepeatedScriptTitle(document, '  '), document)
  assert.deepEqual(omitRepeatedScriptTitle(document, '概要设计'), { type: 'doc', content: [{ type: 'paragraph' }] })
})

test('scene and relationship tables have real rows and cells across Markdown reloads', () => {
  const source = '## 全剧场景设计\n说明正文。\n| 地点（暂名） | 类别 | 主要剧情功能 | 出现阶段 |\n| --- | :---: | --- | ---: |\n| **旧祠堂** | 核心场景 | 家族记忆与真相浮出水面 | 1—20集 |\n| 桥头 | 外景 | 追逐与冲突 | 中段 |\n## 人物关系\n关系 | 性质 | 变化方向\n--- | --- | ---\n林晚与奶奶 | 亲情 | 依赖转为理解'
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(parsed.content?.map(node => node.type), ['heading', 'paragraph', 'table', 'heading', 'table'])
  const scenes = parsed.content![2]
  assert.equal(scenes.content?.length, 3)
  assert.equal(scenes.content?.[0].content?.every(cell => cell.type === 'tableHeader'), true)
  assert.equal(scenes.content?.[1].content?.every(cell => cell.type === 'tableCell'), true)
  assert.equal(scenes.content?.[1].content?.[1].attrs?.align, 'center')
  assert.equal(scenes.content?.[1].content?.[3].attrs?.align, 'right')
  assert.match(markdown, /\| --- \| :---: \| --- \| ---: \|/)
  assert.deepEqual(reloaded, parsed)
  assert.equal(textDocumentText(parsed.content![4]), '关系\t性质\t变化方向\n林晚与奶奶\t亲情\t依赖转为理解')
})

test('table cells preserve escaped pipes, backslashes, marks, empty cells and explicit breaks', () => {
  const source = String.raw`| 名称 | 说明 |
| :--- | --- |
| 林晚\|奶奶 | **第一行**<br/>_第二行_<BR>第三行 |
| 路径\\末尾 | \<br\> 与 <script>普通文本</script> |
|  | 空白名称 |`
  const [parsed, markdown, reloaded] = roundTrip(source)
  const rows = parsed.content![0].content!
  assert.equal(rows.length, 4)
  assert.equal(textDocumentText(rows[1]), '林晚|奶奶\t第一行\n第二行\n第三行')
  assert.equal(textDocumentText(rows[2]), '路径\\末尾\t<br> 与 <script>普通文本</script>')
  assert.equal(rows[3].content?.[0].content?.[0].content, undefined)
  assert.match(markdown, /林晚\\\|奶奶/)
  assert.deepEqual(reloaded, parsed)
})

test('malformed pipe prose and fenced table examples remain text', () => {
  for (const source of ['甲 | 乙\n仍是正文', '| 名称 | 状态 |\n| --- | 待定 |', '| 名称 | 状态 |\n| --- |', '```md\n| 名称 | 状态 |\n| --- | --- |\n| 林晚 | 已确认 |\n```']) {
    const [parsed, , reloaded] = roundTrip(source)
    assert.equal(parsed.content?.some(node => node.type === 'table'), false)
    assert.deepEqual(reloaded, parsed)
  }
})

test('tables preserve missing cells and quoted or list-indented structures', () => {
  for (const source of ['> | 人物 | 说明 |\n> | --- | --- |\n> | 林晚 |', '- 设定\n\n  | 人物 | 说明 |\n  | --- | --- |\n  | 林晚 | 已确认 |']) {
    const [parsed, , reloaded] = roundTrip(source)
    assert.deepEqual(reloaded, parsed)
    assert.match(JSON.stringify(parsed), /tableHeader/)
    assert.match(textDocumentText(parsed), /林晚/)
  }
})

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

test('recognizes compact book titles and numbered Chinese headings across block boundaries', () => {
  const source = '#《旧祠堂门》全剧故事大纲\n##编剧视角总述\n正文\n##1.林晚与奶奶\n关系正文\n- 关系变化\n###2、父女关系\n变化正文'
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(parsed.content?.map(node => [node.type, node.attrs?.level, textDocumentText(node)]), [
    ['heading', 1, '《旧祠堂门》全剧故事大纲'],
    ['heading', 2, '编剧视角总述'],
    ['paragraph', undefined, '正文'],
    ['heading', 2, '1.林晚与奶奶'],
    ['paragraph', undefined, '关系正文'],
    ['bulletList', undefined, '关系变化'],
    ['heading', 3, '2、父女关系'],
    ['paragraph', undefined, '变化正文'],
  ])
  assert.match(markdown, /^# 《旧祠堂门》全剧故事大纲/)
  assert.deepEqual(reloaded, parsed)
})

test('recognizes Chinese quoted titles without consuming title punctuation or numbering', () => {
  for (const title of ['《旧祠堂门》全剧故事大纲', '〈故事设定〉', '「人物关系」', '『故事方向』', '【场景设计】', '〔创作禁区〕', '（背景设定）', '“故事主线”', '‘故事主线’', '【20集大纲】', '1．人物目标', '2）人物关系', '3) 场景设计']) {
    const [parsed, , reloaded] = roundTrip(`##${title}`)
    assert.equal(parsed.content?.[0]?.type, 'heading', title)
    assert.equal(parsed.content?.[0]?.attrs?.level, 2, title)
    assert.equal(textDocumentText(parsed), title)
    assert.deepEqual(reloaded, parsed)
  }
})

test('outline chapter headings through level six retain their hierarchy at paragraph and list boundaries', () => {
  const source = '### 二、全剧脉络与四大篇章概要\n#### 第一篇章：幽冥专列篇（第1–15集）\n- **起因与入局**：深夜误入列车。\n#####冲突与对决\n规则逆转。\n######1、结算与交接\n回到钟表铺。'
  const [parsed, markdown, reloaded] = roundTrip(source)
  assert.deepEqual(parsed.content?.map(node => [node.type, node.attrs?.level, textDocumentText(node)]), [
    ['heading', 3, '二、全剧脉络与四大篇章概要'],
    ['heading', 4, '第一篇章：幽冥专列篇（第1–15集）'],
    ['bulletList', undefined, '起因与入局：深夜误入列车。'],
    ['heading', 5, '冲突与对决'],
    ['paragraph', undefined, '规则逆转。'],
    ['heading', 6, '1、结算与交接'],
    ['paragraph', undefined, '回到钟表铺。'],
  ])
  assert.match(markdown, /\n\n#### 第一篇章/)
  assert.match(markdown, /\n\n##### 冲突与对决/)
  assert.match(markdown, /\n\n###### 1、结算与交接/)
  assert.deepEqual(reloaded, parsed)
})

test('preserves literal compact heading markers, hashtags and inline hashes', () => {
  for (const text of ['#全剧故事大纲', '##项目信息', '###人物目标', '#### 第一篇章', '#####冲突与对决', '######1、结算与交接', '##20集暂定总体结构', '###1至5集家庭记忆裂缝', '#《旧祠堂门》全剧故事大纲', '##【人物关系】', '##1.林晚', '###2、父女关系', '#tag', '#123', '编号 #全剧故事大纲']) {
    const document: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    assert.deepEqual(parseScriptDocument(serializeScriptDocument(document)), document)
  }
  for (const text of ['#tag', '#123', '##2026', '##123abc', '#[tag]', '##1.2', '编号 #全剧故事大纲', '编号 ##20集', '正文 #《旧祠堂门》', '\\#全剧故事大纲', '\\##20集', '\\#《旧祠堂门》', '\\##1.林晚', '\\#### 第一篇章', '\\#####冲突与对决', '\\###### 结算与交接', '####### 超出六级的标记']) {
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
