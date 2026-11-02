import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPromptSectionDocument, parsePromptSectionDocument, reconcilePromptSectionDocument,
  resolvePromptSectionSource, serializePromptSectionDocument } from '../../packages/shared/src/visuals/prompt-section-document.js'
import { stripManagedPromptBlocks } from '../../packages/shared/src/visuals/prompt-document.js'

const block = (name: string, content: string) => `【${name}】\n${content}\n【${name}结束】`
const visual = (content: string) => block('镜头视觉设定', content)
const managed = (document: ReturnType<typeof parsePromptSectionDocument>) => document.blocks.filter(section => section.kind === 'managed')

test('old text round trips literally with all whitespace, unknown headings and incomplete markers', () => {
  const text = `\n\t人工正文。\r\n\r\n${visual('人物：林晚\r\n场景：站台')}\n\n【未知章节】保留\n\n` +
    '【图片参考图用途】尚未补全结束标记\n\t'
  const document = parsePromptSectionDocument(text, { sourceText: text })
  assert.equal(serializePromptSectionDocument(document), text)
  assert.equal(managed(document).length, 1)
  assert.equal(managed(document)[0]!.sourceText, visual('人物：林晚\r\n场景：站台'))
  assert.ok(document.blocks.some(section => section.kind === 'body' && section.text.includes('尚未补全结束标记')))
  const nested = visual(block('图片参考图用途', '错误嵌套'))
  assert.equal(serializePromptSectionDocument(parsePromptSectionDocument(nested)), nested)
  assert.equal(managed(parsePromptSectionDocument(nested)).length, 0)
  assert.ok(isPromptSectionDocument(document))
})

test('parsing an edit keeps stable IDs and source metadata, and deletion tombstones survive repeated saves', () => {
  const source = `正文\n\n${visual('人物：林晚')}\n\n${block('图片生成要求', '16:9')}`
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const first = managed(original)[0]!
  first.pendingSourceText = visual('人物：林晚雨衣')
  first.sourceStatus = 'source_changed'
  const edited = parsePromptSectionDocument(source.replace('人物：林晚', '人物：人工蓝衣'), { previousDocument: original })
  assert.equal(managed(edited)[0]!.id, first.id)
  assert.equal(managed(edited)[0]!.sourceText, first.sourceText)
  assert.equal(managed(edited)[0]!.pendingSourceText, first.pendingSourceText)
  const removedText = serializePromptSectionDocument(edited).replace(managed(edited)[0]!.text, '')
  const removed = parsePromptSectionDocument(removedText, { previousDocument: edited })
  assert.equal(serializePromptSectionDocument(removed), removedText)
  assert.equal(removed.blocks.find(section => section.id === first.id)!.deleted, true)
  assert.equal(removed.blocks.find(section => section.id === first.id)!.text, '')
  const reopened = parsePromptSectionDocument(serializePromptSectionDocument(removed), { previousDocument: removed })
  assert.equal(reopened.blocks.find(section => section.id === first.id)!.deleted, true)
  assert.equal(managed(reopened).length, 2)
  assert.ok(isPromptSectionDocument(reopened))
})

test('independent line edits merge automatically without changing body text or section identity', () => {
  const source = `  我的动作\n\n${visual('人物：灰衣\n场景：旧站台\n道具：木箱')}\n尾段。  `
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('人物：灰衣', '人物：人工蓝衣'), { previousDocument: original })
  const next = source.replace('场景：旧站台', '场景：雨夜新站台')
  const result = reconcilePromptSectionDocument(edited, next)
  assert.equal(serializePromptSectionDocument(result), source.replace('人物：灰衣', '人物：人工蓝衣').replace('场景：旧站台', '场景：雨夜新站台'))
  assert.equal(managed(result)[0]!.id, managed(original)[0]!.id)
  assert.equal(managed(result)[0]!.sourceText, visual('人物：灰衣\n场景：雨夜新站台\n道具：木箱'))
  assert.equal(managed(result)[0]!.sourceStatus, undefined)
  assert.equal(serializePromptSectionDocument(reconcilePromptSectionDocument(result, next)), serializePromptSectionDocument(result))
})

test('overlapping line edits keep creator text, apply other upstream lines and require an explicit decision', () => {
  const source = visual('人物：灰衣\n场景：站台\n道具：箱子')
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('人物：灰衣', '人物：人工蓝衣'), { previousDocument: original })
  const next = visual('人物：来源红衣\n场景：新站台\n道具：箱子')
  const result = reconcilePromptSectionDocument(edited, next), section = managed(result)[0]!
  assert.equal(section.text, visual('人物：人工蓝衣\n场景：新站台\n道具：箱子'))
  assert.equal(section.sourceText, source)
  assert.equal(section.pendingSourceText, next)
  assert.equal(section.sourceStatus, 'source_changed')
  const kept = resolvePromptSectionSource(result, section.id, 'keep_custom')
  assert.equal(managed(kept)[0]!.text, section.text)
  assert.equal(managed(kept)[0]!.sourceText, next)
  assert.equal(managed(kept)[0]!.sourceStatus, undefined)
  const followed = resolvePromptSectionSource(result, section.id, 'follow_source')
  assert.equal(managed(followed)[0]!.text, next)
  assert.equal(managed(followed)[0]!.pendingSourceText, undefined)
  assert.equal(serializePromptSectionDocument(reconcilePromptSectionDocument(kept, next.replace('箱子', '铜箱'))), visual('人物：人工蓝衣\n场景：新站台\n道具：铜箱'))
})

test('line insertions and matching changes retain both contributions without false conflicts', () => {
  const source = visual('人物：灰衣\n场景：站台')
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('场景：站台', '人工新增：低机位\n场景：站台'), { previousDocument: original })
  const result = reconcilePromptSectionDocument(edited, source.replace('场景：站台', '场景：新站台'))
  assert.equal(managed(result)[0]!.text, visual('人物：灰衣\n人工新增：低机位\n场景：新站台'))
  assert.equal(managed(result)[0]!.sourceStatus, undefined)
  const same = reconcilePromptSectionDocument(edited, serializePromptSectionDocument(edited))
  assert.equal(managed(same)[0]!.sourceStatus, undefined)
  assert.equal(managed(same)[0]!.sourceText, managed(edited)[0]!.text)
})

test('source removal follows untouched defaults while preserving edited and manually deleted sections', () => {
  const source = visual('人物：林晚')
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const removedSource = reconcilePromptSectionDocument(original, '')
  assert.equal(serializePromptSectionDocument(removedSource), '')
  assert.equal(managed(removedSource)[0]!.deleted, true)
  assert.equal(managed(removedSource)[0]!.deletionSource, 'source')
  assert.ok(isPromptSectionDocument(removedSource))
  assert.equal(serializePromptSectionDocument(reconcilePromptSectionDocument(removedSource, source)), source)
  const edited = parsePromptSectionDocument(source.replace('林晚', '人工蓝衣'), { previousDocument: original })
  const conflict = reconcilePromptSectionDocument(edited, '')
  assert.equal(managed(conflict)[0]!.text, visual('人物：人工蓝衣'))
  assert.equal(managed(conflict)[0]!.pendingSourceText, '')
  assert.equal(managed(conflict)[0]!.sourceStatus, 'source_changed')
  assert.equal(serializePromptSectionDocument(resolvePromptSectionSource(conflict, managed(conflict)[0]!.id, 'follow_source')), '')
  assert.equal(managed(resolvePromptSectionSource(conflict, managed(conflict)[0]!.id, 'follow_source'))[0]!.deleted, true)
  const deleted = parsePromptSectionDocument('', { previousDocument: original })
  assert.equal(serializePromptSectionDocument(reconcilePromptSectionDocument(deleted, source)), '')
  const updated = reconcilePromptSectionDocument(deleted, source.replace('林晚', '新来源'))
  assert.equal(serializePromptSectionDocument(updated), '')
  assert.equal(managed(updated)[0]!.sourceStatus, 'source_changed')
  const kept = resolvePromptSectionSource(updated, managed(updated)[0]!.id, 'keep_custom')
  assert.equal(managed(kept)[0]!.deleted, true)
  assert.equal(serializePromptSectionDocument(reconcilePromptSectionDocument(kept, source.replace('林晚', '新来源'))), '')
})

test('new source sections append without overwriting custom blocks and optional body replacement keeps metadata', () => {
  const source = `旧正文\n\n${visual('人物：林晚')}`
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('人物：林晚', '人物：人工蓝衣'), { previousDocument: original })
  const next = `${source}\n\n${block('图片生成要求', '16:9')}`
  const result = reconcilePromptSectionDocument(edited, next)
  assert.equal(serializePromptSectionDocument(result), `${source.replace('人物：林晚', '人物：人工蓝衣')}\n\n${block('图片生成要求', '16:9')}`)
  const replaced = reconcilePromptSectionDocument(result, next, { body: '新的连接正文' })
  assert.equal(serializePromptSectionDocument(replaced), `新的连接正文\n\n${visual('人物：人工蓝衣')}\n\n${block('图片生成要求', '16:9')}`)
  assert.deepEqual(managed(replaced).map(section => section.id), managed(result).map(section => section.id))
  assert.deepEqual(managed(replaced).map(section => section.sourceText), managed(result).map(section => section.sourceText))
  assert.deepEqual(reconcilePromptSectionDocument(result, next, { body: '旧正文' }), result)
})

test('body replacement and newly introduced source sections retain authored trailing whitespace', () => {
  const source = visual('人物：林晚')
  for (const body of ['正文\n', '正文\n\n', '正文\r\n', '正文\n\t']) {
    const original = parsePromptSectionDocument(`旧正文\n\n${source}`, { sourceText: source })
    const replaced = reconcilePromptSectionDocument(original, source, { body })
    assert.equal(serializePromptSectionDocument(replaced), `${body}\n\n${source}`)
    assert.equal(stripManagedPromptBlocks(serializePromptSectionDocument(replaced)), body)
    assert.deepEqual(reconcilePromptSectionDocument(replaced, source, { body }), replaced)

    const appended = reconcilePromptSectionDocument(parsePromptSectionDocument(body), source)
    assert.equal(serializePromptSectionDocument(appended), `${body}\n\n${source}`)
    assert.equal(stripManagedPromptBlocks(serializePromptSectionDocument(appended)), body)
  }
})

test('switching reference mode preserves the exact body while source sections disappear and return', () => {
  const body = '正文\n'
  const parameters = block('视频生成要求', '视频时长：6秒')
  const references = block('视频参考图用途', '图1：人物身份')
  const style = block('项目画风约束', '画风：日漫')
  const referenceSource = `${parameters}\n\n${references}\n\n${style}`
  const textSource = `${parameters}\n\n${style}`
  let document = parsePromptSectionDocument(`${body}\n\n${referenceSource}`, { sourceText: referenceSource })
  const sectionIds = managed(document).map(section => section.id)
  for (const nextSource of [textSource, referenceSource, textSource, referenceSource]) {
    document = reconcilePromptSectionDocument(document, nextSource, { body })
    const serialized = serializePromptSectionDocument(document)
    assert.equal(stripManagedPromptBlocks(serialized), body)
    assert.equal(serialized.includes('【视频参考图用途】'), nextSource === referenceSource)
    assert.deepEqual(managed(document).map(section => section.id), sectionIds)
    assert.deepEqual(reconcilePromptSectionDocument(document, nextSource, { body }), document)
  }
})

test('duplicate names match exact source identity across insertion and preserve old IDs', () => {
  const first = visual('人物：甲\n场景：旧站台'), second = visual('人物：乙\n场景：旧码头')
  const source = `${first}\n\n${second}`
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('人物：乙', '人物：乙人工蓝衣'), { previousDocument: original })
  const next = `${visual('人物：新插入丙')}\n\n${first}\n\n${second.replace('旧码头', '新码头')}`
  const result = reconcilePromptSectionDocument(edited, next)
  const current = result.blocks.find(section => section.id === managed(original)[1]!.id)!
  assert.equal(current.text, visual('人物：乙人工蓝衣\n场景：新码头'))
  assert.equal(current.sourceStatus, undefined)
  assert.equal(managed(result).length, 3)
  const reordered = parsePromptSectionDocument(`${second}\n\n${first}`, { previousDocument: original })
  assert.equal(managed(reordered)[0]!.id, managed(original)[1]!.id)
  assert.equal(managed(reordered)[1]!.id, managed(original)[0]!.id)
  const between = reconcilePromptSectionDocument(edited, `${first}\n\n${visual('人物：新插入丙')}\n\n${second.replace('旧码头', '新码头')}`)
  assert.equal(between.blocks.find(section => section.id === managed(original)[1]!.id)!.text, visual('人物：乙人工蓝衣\n场景：新码头'))
  const changedAndReordered = reconcilePromptSectionDocument(edited, `${second.replace('旧码头', '新码头')}\n\n${first.replace('旧站台', '新站台')}`)
  assert.equal(managed(changedAndReordered).length, 2)
  assert.equal(managed(changedAndReordered)[0]!.text, first.replace('旧站台', '新站台'))
  assert.equal(managed(changedAndReordered)[1]!.text, visual('人物：乙人工蓝衣\n场景：新码头'))
  assert.ok(managed(changedAndReordered).every(section => section.sourceStatus === undefined))
})

test('the persisted structure rejects duplicate IDs and invalid tombstones', () => {
  const document = parsePromptSectionDocument(visual('林晚'))
  assert.ok(isPromptSectionDocument(document))
  assert.equal(isPromptSectionDocument({ version: 2, blocks: [] }), false)
  assert.equal(isPromptSectionDocument({ version: 1, blocks: [...document.blocks, document.blocks[0]] }), false)
  assert.equal(isPromptSectionDocument({ version: 1, blocks: [{ ...managed(document)[0], name: '未知系统区' }] }), false)
  assert.equal(isPromptSectionDocument({ version: 1, blocks: [{ ...managed(document)[0], deleted: true }] }), false)
})

test('duplicate source blocks without identity anchors stay unchanged across repeated reconciliation', () => {
  const first = visual('人物：甲\n场景：甲家\n道具：木箱\n要求：保留材质'), second = visual('人物：乙\n场景：乙家\n道具：竹篮\n要求：保留材质')
  const body = '  人工正文\n\t'
  const source = `${body}\n\n${first}\n\n${second}`
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const custom = source.replace('道具：木箱', '道具：人工金箱')
  const edited = parsePromptSectionDocument(custom, { previousDocument: original })
  const next = `${visual('人物：乙新\n场景：乙新家\n道具：竹篮新\n要求：保留材质')}\n\n${visual('人物：甲新\n场景：甲新家\n道具：木箱新\n要求：保留材质')}`
  const result = reconcilePromptSectionDocument(edited, next)
  assert.equal(serializePromptSectionDocument(result), custom)
  assert.deepEqual(managed(result).map(section => section.id), managed(original).map(section => section.id))
  assert.ok(managed(result).every(section => section.sourceStatus === 'source_changed'))
  assert.deepEqual(reconcilePromptSectionDocument(result, next), result)
  const reopened = parsePromptSectionDocument(serializePromptSectionDocument(result), { previousDocument: result })
  assert.deepEqual(reconcilePromptSectionDocument(reopened, next), result)
  const firstId = managed(result)[0]!.id
  const kept = resolvePromptSectionSource(result, firstId, 'keep_custom')
  assert.equal(managed(kept)[0]!.text, first.replace('道具：木箱', '道具：人工金箱'))
  assert.equal(managed(reconcilePromptSectionDocument(kept, next))[0]!.sourceStatus, undefined)
  const withoutBaseline = reconcilePromptSectionDocument(parsePromptSectionDocument(custom), next)
  assert.equal(serializePromptSectionDocument(withoutBaseline), custom)
  assert.ok(managed(withoutBaseline).every(section => section.sourceStatus === 'source_changed'))
})

test('pending source changes advance only automatically merged lines and survive save and explicit resolution', () => {
  const source = visual('人物：灰衣\n场景：旧站台\n道具：箱子')
  const original = parsePromptSectionDocument(source, { sourceText: source })
  const edited = parsePromptSectionDocument(source.replace('人物：灰衣', '人物：人工蓝衣'), { previousDocument: original })
  const firstSource = visual('人物：来源红衣\n场景：新站台\n道具：箱子')
  const first = reconcilePromptSectionDocument(edited, firstSource)
  assert.equal(managed(first)[0]!.mergeBaseText, visual('人物：灰衣\n场景：新站台\n道具：箱子'))
  assert.equal(managed(first)[0]!.sourceText, source)
  assert.ok(isPromptSectionDocument(first))
  const reopened = parsePromptSectionDocument(serializePromptSectionDocument(first), { previousDocument: first })
  const latestSource = visual('人物：来源红衣\n场景：再次更新站台\n道具：铜箱')
  const latest = reconcilePromptSectionDocument(reopened, latestSource)
  assert.equal(managed(latest)[0]!.text, visual('人物：人工蓝衣\n场景：再次更新站台\n道具：铜箱'))
  assert.equal(managed(latest)[0]!.pendingSourceText, latestSource)
  assert.equal(managed(latest)[0]!.sourceText, source)
  assert.deepEqual(reconcilePromptSectionDocument(latest, latestSource), latest)
  const legacyPending = { ...first, blocks: first.blocks.map(({ mergeBaseText: _mergeBase, ...section }) => section) }
  assert.deepEqual(reconcilePromptSectionDocument(legacyPending, latestSource), latest)
  const kept = resolvePromptSectionSource(latest, managed(latest)[0]!.id, 'keep_custom')
  assert.equal(managed(kept)[0]!.mergeBaseText, undefined)
  assert.equal(managed(kept)[0]!.sourceText, latestSource)
  assert.equal(managed(kept)[0]!.text, managed(latest)[0]!.text)
  assert.equal(managed(resolvePromptSectionSource(latest, managed(latest)[0]!.id, 'follow_source'))[0]!.text, latestSource)
  const reverted = reconcilePromptSectionDocument(latest, latestSource.replace('人物：来源红衣', '人物：灰衣'))
  assert.equal(managed(reverted)[0]!.sourceStatus, undefined)
  assert.equal(managed(reverted)[0]!.mergeBaseText, undefined)
  assert.equal(managed(reverted)[0]!.text, managed(latest)[0]!.text)
  assert.equal(isPromptSectionDocument({ ...first, blocks: first.blocks.map(section => ({ ...section, mergeBaseText: 1 })) }), false)
})
