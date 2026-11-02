import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPromptSectionDocument, parsePromptSectionDocument, reconcilePromptSectionDocument, serializePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { canvasPromptSectionDocument, rewriteCanvasPromptSections, visualBoardEditorDocument } from '../src/features/canvas/canvas-prompt-composition'

test('reference replacement keeps a pending source merge consistent through the next source update', () => {
  const source = '【镜头视觉设定】\n人物：灰衣[[ref:original]]\n场景：旧站台\n【镜头视觉设定结束】'
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const authored = parsePromptSectionDocument(source.replace('灰衣', '蓝衣'), { previousDocument: original })
  const pending = reconcilePromptSectionDocument(authored, source.replace('灰衣', '红衣').replace('旧站台', '新站台'))
  const rewritten = rewriteCanvasPromptSections(pending, text => text.replaceAll('[[ref:original]]', '[[ref:replacement]]'))!
  assert.ok(rewritten.blocks.some(block => block.mergeBaseText?.includes('[[ref:replacement]]')))
  assert.doesNotMatch(JSON.stringify(rewritten), /ref:original/)
  const updated = reconcilePromptSectionDocument(rewritten, source.replaceAll('[[ref:original]]', '[[ref:replacement]]')
    .replace('灰衣', '红衣').replace('旧站台', '再次更新的站台'))
  assert.match(serializePromptSectionDocument(updated), /人物：蓝衣\[\[ref:replacement\]\]/)
  assert.match(serializePromptSectionDocument(updated), /场景：再次更新的站台/)
  assert.ok(updated.blocks.some(block => block.pendingSourceText !== undefined))
})

test('authoritative same-text pasted sections retain their identity while removed sources stay deleted', () => {
  const primary = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const source = parsePromptSectionDocument(primary, { sourceText: primary }).blocks.find(block => block.kind === 'managed')!
  const removed = { ...source, text: '', deleted: true, pendingSourceText: primary.replace('人物', '来源人物'), sourceStatus: 'source_changed' as const }
  const current = { version: 1 as const, blocks: [removed, { id: 'pasted-primary', kind: 'managed' as const, name: '设定图固定要求' as const, text: primary }] }
  assert.equal(canvasPromptSectionDocument(primary, { previousDocument: current, sourceText: primary }), current,
    'an exact authored document needs no metadata reconstruction')
  const changed = primary.replace('人物三视图。', '人物三视图，重点呈现服装纹理。')
  const updated = canvasPromptSectionDocument(changed, { previousDocument: current, sourceText: primary })
  assert.deepEqual(updated.blocks.find(block => block.id === removed.id), removed)
  const active = updated.blocks.find(block => block.id === 'pasted-primary')!
  assert.equal(active.text, changed)
  assert.equal(active.deleted, undefined)
  assert.equal(active.sourceText, undefined)
  assert.equal(active.pendingSourceText, undefined)
  assert.equal(serializePromptSectionDocument(updated), changed)
  assert.equal(new Set(updated.blocks.map(block => block.id)).size, updated.blocks.length)
})

const boardPrimary = '【设定图固定要求】\n人物三视图，身份参考[[ref:hero]]。\n【设定图固定要求结束】'
const boardStyle = '【项目画风约束】\n木刻与纸张纹理。\n【项目画风约束结束】'
const boardReferences = '【生成参考图】\n[[ref:coat]]用于衣物材质。\n【生成参考图结束】'

test('board ordering puts the main task before all authored supplements and preserves source identities', () => {
  const document = parsePromptSectionDocument(`  前置补充[[ref:coat]]。\t\n\n${boardStyle}\n\n中间补充。\n${boardPrimary}\n\n${boardReferences}\n尾部补充。  \n`, {
    sourceText: [boardPrimary, boardStyle, boardReferences].join('\n\n'),
  })
  const primary = document.blocks.find(block => block.name === '设定图固定要求')!
  primary.pendingSourceText = boardPrimary.replace('三视图', '四视图')
  primary.mergeBaseText = boardPrimary.replace('人物', '来源人物')
  primary.sourceStatus = 'source_changed'
  const original = structuredClone(document)
  const next = visualBoardEditorDocument(document)
  assert.equal(next.blocks[0], primary)
  const originalBodies = document.blocks.filter(block => block.kind === 'body')
  const oldIds = new Set(document.blocks.map(block => block.id))
  assert.deepEqual(next.blocks.filter(block => oldIds.has(block.id) && block.kind === 'body'), originalBodies)
  assert.deepEqual(next.blocks.filter(block => block.kind === 'managed'), [primary,
    ...document.blocks.filter(block => block.kind === 'managed' && block !== primary)])
  assert.equal(serializePromptSectionDocument(next), `${boardPrimary}\n\n${originalBodies.map(block => block.text).join('')}\n${boardStyle}\n\n${boardReferences}`)
  assert.deepEqual(document, original, 'ordering never mutates saved authoring data')
  assert.equal(isPromptSectionDocument(next), true)
  assert.equal(new Set(next.blocks.map(block => block.id)).size, next.blocks.length)
  assert.equal(visualBoardEditorDocument(next), next)
})

test('board ordering keeps all whitespace bytes and structural normalization is stable through parse and reload', () => {
  const document = parsePromptSectionDocument(`\n\t作者空行。\n\n\n${boardStyle}\n \t\n\n${boardPrimary}\n\n\n${boardReferences}\n\t`)
  const bodies = document.blocks.filter(block => block.kind === 'body').map(block => block.text)
  const next = visualBoardEditorDocument(document)
  const bodyIds = new Set(document.blocks.filter(block => block.kind === 'body').map(block => block.id))
  assert.deepEqual(next.blocks.filter(block => bodyIds.has(block.id)).map(block => block.text), bodies)
  const serialized = serializePromptSectionDocument(next)
  const reload = parsePromptSectionDocument(serialized, { previousDocument: next })
  assert.equal(visualBoardEditorDocument(reload), reload)
  assert.equal(serializePromptSectionDocument(visualBoardEditorDocument(reload)), serialized)
})

test('board ordering retains removed sources and fresh primary metadata separately', () => {
  const removed = { id: 'removed-primary', kind: 'managed' as const, name: '设定图固定要求' as const,
    text: '', sourceText: boardPrimary, pendingSourceText: boardPrimary.replace('人物', '旧来源人物'),
    mergeBaseText: boardPrimary, sourceStatus: 'source_changed' as const, deleted: true }
  const active = { id: 'pasted-primary', kind: 'managed' as const, name: '设定图固定要求' as const, text: boardPrimary.replace('人物', '新人物') }
  const document: PromptSectionDocument = { version: 1, blocks: [removed,
    { id: 'body-note', kind: 'body', text: '保留补充。' }, { id: 'style', kind: 'managed', name: '项目画风约束', text: boardStyle }, active] }
  const next = visualBoardEditorDocument(document)
  assert.equal(next.blocks[0], active)
  assert.equal(next.blocks.find(block => block.id === removed.id), removed)
  assert.equal(next.blocks.find(block => block.id === active.id)!.sourceText, undefined)
  assert.deepEqual(next.blocks.filter(block => block.kind === 'managed' && block !== active), [removed, document.blocks[2]])
  assert.equal(visualBoardEditorDocument(next), next)
})

test('board ordering leaves absent and ambiguous primary documents untouched', () => {
  for (const value of ['正文。', boardStyle, '', `${boardPrimary}\n\n${boardPrimary}`]) {
    const document = parsePromptSectionDocument(value)
    assert.equal(visualBoardEditorDocument(document), document)
  }
  const document = parsePromptSectionDocument(boardPrimary)
  const primary = document.blocks.find(block => block.kind === 'managed')!
  primary.text = ''; primary.deleted = true
  assert.equal(visualBoardEditorDocument(document), document)
})

test('board ordering does not need dummy supplemental prose and handles existing separator IDs safely', () => {
  const document: PromptSectionDocument = { version: 1, blocks: [
    { id: 'visual-board-editor-separator-1', kind: 'body', text: '作者使用相同前缀的内容。' },
    { id: 'visual-board-editor-separator-2', kind: 'body', text: '\n\n' },
    { id: 'style', kind: 'managed', name: '项目画风约束', text: boardStyle },
    { id: 'primary', kind: 'managed', name: '设定图固定要求', text: boardPrimary },
  ] }
  const next = visualBoardEditorDocument(document)
  assert.equal(next.blocks.find(block => block.id === document.blocks[0].id), document.blocks[0])
  assert.equal(next.blocks.find(block => block.id === document.blocks[1].id), document.blocks[1])
  assert.equal(new Set(next.blocks.map(block => block.id)).size, next.blocks.length)
  const primaryOnly = parsePromptSectionDocument(boardPrimary)
  assert.equal(visualBoardEditorDocument(primaryOnly), primaryOnly)
  assert.equal(serializePromptSectionDocument(primaryOnly), boardPrimary)
})
