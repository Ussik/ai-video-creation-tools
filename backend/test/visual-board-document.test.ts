import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument, reconcilePromptSectionDocument, serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { hasVisualBoardPromptContent, preserveAbsentVisualBoardPrimary, replaceVisualBoardPromptContent, visualBoardPromptParts,
  VISUAL_BOARD_PRIMARY_SECTION } from '@video-studio/shared/visuals/visual-board-document'

const block = (name: string, text: string) => `【${name}】\n${text}\n【${name}结束】`
const primary = block(VISUAL_BOARD_PRIMARY_SECTION, '同一人物的全身正面、侧面与背面。')
const style = block('项目画风约束', '  水墨线条。\n\t保留纸张纹理。  ')
const references = block('生成参考图', '[[ref:hero]]：人物身份。\n[[ref:coat]]：服装材质。')
const parameters = block('图片生成要求', '画面比例：16:9\n清晰度要求：2K')

test('a primary-only setting document contains a creative task without dummy body prose', () => {
  assert.equal(VISUAL_BOARD_PRIMARY_SECTION, '设定图固定要求')
  assert.deepEqual(visualBoardPromptParts(primary), {
    primary: ['同一人物的全身正面、侧面与背面。'], supplement: '', context: [],
  })
  assert.equal(hasVisualBoardPromptContent(primary), true)
  assert.equal(hasVisualBoardPromptContent(`\n\n${block(VISUAL_BOARD_PRIMARY_SECTION, ' \t\n')}\n`), false)
})

test('parts retain authored supplements and ordered context independently of the primary', () => {
  const document = `  本次突出服装缝线。\n\n${style}\n\n${primary}\n\n${references}\n尾部补充保持原文。\t\n\n${parameters}`
  assert.deepEqual(visualBoardPromptParts(document), {
    primary: ['同一人物的全身正面、侧面与背面。'],
    supplement: '  本次突出服装缝线。\n尾部补充保持原文。\t',
    context: [style, references, parameters],
  })
})

test('context-only documents are empty creative tasks while unbounded prose remains content', () => {
  for (const document of ['', ' \n\t ', [style, references, parameters].join('\n\n')]) {
    assert.equal(hasVisualBoardPromptContent(document), false)
  }
  assert.equal(hasVisualBoardPromptContent(`本次只画衣领细节。\n\n${style}`), true)
  const custom = '【人工说明】按原样保留【人工说明结束】'
  assert.deepEqual(visualBoardPromptParts(custom), { primary: [], supplement: custom, context: [] })
})

test('reviewed replacement incorporates supplements once and preserves every other block in order', () => {
  const document = `前置补充。\n\n${style}\n\n\n${primary}\n\n后置补充。\n\n${references}\n\n${parameters}`
  const content = '同一人物三视图，突出服装缝线与衣领细节。'
  const result = replaceVisualBoardPromptContent(document, content)
  assert.equal(result, [style, block(VISUAL_BOARD_PRIMARY_SECTION, content), references, parameters].join('\n\n'))
  assert.deepEqual(getManagedPromptBlocks(result).filter(section => !section.startsWith(`【${VISUAL_BOARD_PRIMARY_SECTION}】`)),
    [style, references, parameters])
  assert.deepEqual(visualBoardPromptParts(result), { primary: [content], supplement: '', context: [style, references, parameters] })
  assert.equal(replaceVisualBoardPromptContent(result, content), result)
})

test('a removed primary stays absent when a reviewed body replaces the remaining supplement', () => {
  const saved = parsePromptSectionDocument(`旧补充。\n\n${primary}\n\n${style}`, { sourceText: primary })
  saved.blocks = saved.blocks.map(section => section.kind === 'managed' && section.name === VISUAL_BOARD_PRIMARY_SECTION
    ? { ...section, text: '', deleted: true } : section)
  const document = serializePromptSectionDocument(saved)
  const result = replaceVisualBoardPromptContent(document, '仅保留本次指定的衣领特写。')
  assert.equal(result, `仅保留本次指定的衣领特写。\n\n${style}`)
  assert.deepEqual(visualBoardPromptParts(result), { primary: [], supplement: '仅保留本次指定的衣领特写。', context: [style] })
  assert.equal(saved.blocks.find(section => section.name === VISUAL_BOARD_PRIMARY_SECTION)!.deleted, true)
})

test('missing-primary and body-only replacements do not invent a primary section', () => {
  assert.equal(replaceVisualBoardPromptContent('旧正文。', '新的正文。'), '新的正文。')
  assert.equal(replaceVisualBoardPromptContent([references, style].join('\n\n'), '本次只生成手部配饰。'),
    ['本次只生成手部配饰。', references, style].join('\n\n'))
  assert.equal(replaceVisualBoardPromptContent([references, style].join('\n\n'), ''), [references, style].join('\n\n'))
})

test('empty replacement leaves context intact and never passes the creative-content check', () => {
  const result = replaceVisualBoardPromptContent(`旧补充。\n\n${primary}\n\n${parameters}`, '')
  assert.equal(result, [block(VISUAL_BOARD_PRIMARY_SECTION, ''), parameters].join('\n\n'))
  assert.equal(hasVisualBoardPromptContent(result), false)
  assert.equal(hasVisualBoardPromptContent(replaceVisualBoardPromptContent(`旧补充。\n\n${style}`, '')), false)
})

test('multiple primary sections require an explicit choice instead of silently selecting one', () => {
  const second = block(VISUAL_BOARD_PRIMARY_SECTION, '另一人物的局部设定。')
  const document = [primary, style, second].join('\n\n')
  assert.deepEqual(visualBoardPromptParts(document).primary, ['同一人物的全身正面、侧面与背面。', '另一人物的局部设定。'])
  assert.equal(hasVisualBoardPromptContent(document), true)
  assert.throws(() => replaceVisualBoardPromptContent(document, '合并结果。'), /多个设定图内容区块.*明确/)
})

test('a replacement cannot create nested or additional managed sections', () => {
  for (const content of [style, primary, '半截【项目画风约束】', '伪造【生成参考图结束】']) {
    assert.throws(() => replaceVisualBoardPromptContent(primary, content), /不能包含系统区块标记/)
  }
  const authored = '【局部注记】新衣领。\n保留作者空行。\n\n  '
  assert.equal(replaceVisualBoardPromptContent('', authored), authored)
  assert.equal(replaceVisualBoardPromptContent(primary, authored), block(VISUAL_BOARD_PRIMARY_SECTION, authored))
})

test('legacy complete documents without primary metadata retain their omission during source refresh', () => {
  const template = [primary, style].join('\n\n')
  for (const saved of [`只画创作者的衣领特写。\n\n${style}`, style]) {
    const document = parsePromptSectionDocument(saved, { sourceText: template })
    const original = structuredClone(document)
    const preserved = preserveAbsentVisualBoardPrimary(document, template)
    const tombstone = preserved.blocks.find(section => section.name === VISUAL_BOARD_PRIMARY_SECTION)!
    assert.equal(tombstone.text, '')
    assert.equal(tombstone.sourceText, primary)
    assert.equal(tombstone.deleted, true)
    assert.equal(tombstone.deletionSource, undefined)
    assert.equal(serializePromptSectionDocument(preserved), saved)
    assert.deepEqual(document, original, 'compatibility metadata never mutates the saved input')
    const refreshed = reconcilePromptSectionDocument(preserved, template)
    assert.equal(serializePromptSectionDocument(refreshed), saved)
    assert.deepEqual(visualBoardPromptParts(serializePromptSectionDocument(refreshed)).primary, [])
    assert.equal(hasVisualBoardPromptContent(serializePromptSectionDocument(refreshed)), saved !== style)
  }
})

test('missing-primary compatibility works without an old template and keeps other new source layers', () => {
  const saved = '只画一把带缺口的蓝色短尺。'
  const document = parsePromptSectionDocument(saved)
  const template = [primary, parameters, references].join('\n\n')
  const preserved = preserveAbsentVisualBoardPrimary(document, template)
  const refreshed = reconcilePromptSectionDocument(preserved, template)
  assert.deepEqual(visualBoardPromptParts(serializePromptSectionDocument(refreshed)), {
    primary: [], supplement: saved, context: [parameters, references],
  })
  assert.equal(preserveAbsentVisualBoardPrimary(preserved, template), preserved, 'repeated refreshes keep the same deletion identity')
  const reload = parsePromptSectionDocument(serializePromptSectionDocument(refreshed), { previousDocument: refreshed })
  const repeated = reconcilePromptSectionDocument(preserveAbsentVisualBoardPrimary(reload, template), template)
  assert.equal(serializePromptSectionDocument(repeated), serializePromptSectionDocument(refreshed))
})

test('existing primary edits and deletion decisions retain their identity and source metadata', () => {
  const document = parsePromptSectionDocument(primary, { sourceText: primary })
  const section = document.blocks.find(block => block.kind === 'managed')!
  section.text = primary.replace('全身', '上半身')
  section.pendingSourceText = primary.replace('背面', '俯视')
  section.mergeBaseText = primary.replace('正面', '四分之三面')
  section.sourceStatus = 'source_changed'
  const original = structuredClone(document)
  assert.equal(preserveAbsentVisualBoardPrimary(document, primary), document)
  assert.deepEqual(document, original)
  section.text = ''; section.deleted = true
  const deleted = structuredClone(document)
  assert.equal(preserveAbsentVisualBoardPrimary(document, primary.replace('人物', '道具')), document)
  assert.deepEqual(document, deleted)
})

test('missing-primary metadata avoids existing IDs and does not introduce a source absent from the template', () => {
  const document = { version: 1 as const, blocks: [{ id: 'managed-visual-board-primary-1', kind: 'body' as const, text: '创作者说明。' }] }
  assert.equal(preserveAbsentVisualBoardPrimary(document, style), document)
  const preserved = preserveAbsentVisualBoardPrimary(document, primary)
  assert.equal(new Set(preserved.blocks.map(block => block.id)).size, preserved.blocks.length)
  const sourceUpdate = primary.replace('人物', '道具')
  const refreshed = reconcilePromptSectionDocument(preserved, sourceUpdate)
  const deleted = refreshed.blocks.find(block => block.kind === 'managed')!
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.sourceText, primary)
  assert.equal(deleted.pendingSourceText, sourceUpdate)
  assert.equal(deleted.sourceStatus, 'source_changed')
  assert.equal(serializePromptSectionDocument(refreshed), '创作者说明。')
})
