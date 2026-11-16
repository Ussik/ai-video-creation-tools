import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyResolvedEdits, documentParagraphs, resolvePassageEdits, ScriptToolProblem } from '../src/modules/script/script-revision.js'

const doc = { id: 'document', title: '当前正文' }
const edit = (find: string) => ({ find, replace: '新内容', reason: '修订目标片段' })

test('text locators reject both halves of an emoji without changing the original', () => {
  const content = '前文🚆后文'
  for (const find of ['\ud83d', '\ude86', '前文\ud83d', '\ude86后文']) {
    assert.throws(() => resolvePassageEdits(content, 'version', [edit(find)], [[0, content.length]], doc),
      (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'invalid_passage_boundary')
  }
  assert.equal(content, '前文🚆后文')
  const changes = resolvePassageEdits(content, 'version', [edit('🚆')], [[0, content.length]], doc)
  assert.equal(applyResolvedEdits(content, changes), '前文新内容后文')
})

test('paragraph-only edit uses the exact occurrence even when paragraph text repeats', () => {
  const content = '重复🚆段落\r\n\r\n重复🚆段落', paragraphs = documentParagraphs(content, 'version')
  assert.equal(paragraphs.length, 2)
  const second = paragraphs[1]!
  const changes = resolvePassageEdits(content, 'version', [{ paragraph_id: second.id, replace: '只改第二段', reason: '定向修订' }],
    [[second.start, second.end]], doc)
  assert.equal(changes[0]!.start, second.start); assert.equal(changes[0]!.end, second.end)
  assert.equal(applyResolvedEdits(content, changes), '重复🚆段落\r\n\r\n只改第二段')
  assert.throws(() => resolvePassageEdits(content, 'next-version', [{ paragraph_id: second.id, replace: '新内容', reason: '修订' }],
    [[0, content.length]], doc), (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'anchor_stale')
  assert.throws(() => resolvePassageEdits(content, 'version', [{ paragraph_id: second.id, replace: '新内容', reason: '修订' }],
    [[0, paragraphs[0]!.end]], doc), (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'unread_passage')
})

test('replacement values cannot introduce unpaired surrogates and valid emoji replacements remain exact', () => {
  const content = '前🚆后  '
  for (const replace of ['\ud83d', '\ude86', '前\ud83d后', '前\ude86后']) {
    assert.throws(() => resolvePassageEdits(content, 'version', [{ ...edit('🚆'), replace }], [[0, content.length]], doc),
      (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'invalid_passage_replacement'
        && error.diagnostic.item_index === 0)
  }
  const changes = resolvePassageEdits(content, 'version', [{ ...edit('🚆'), replace: '🚂🚆' }], [[0, content.length]], doc)
  assert.equal(applyResolvedEdits(content, changes), '前🚂🚆后  ')
})

test('overlap diagnostics retain both original input indices after sorting locators', () => {
  const content = '甲乙丙丁戊己'
  const changes = resolvePassageEdits(content, 'version', [edit('丁戊'), edit('己'), edit('丙丁')], [[0, content.length]], doc)
  assert.throws(() => applyResolvedEdits(content, changes), (error: unknown) => {
    if (!(error instanceof ScriptToolProblem) || error.diagnostic.code !== 'overlapping_passages') return false
    assert.equal(error.diagnostic.item_index, 0)
    assert.deepEqual(error.diagnostic.conflict_indices, [2, 0])
    return true
  })
  const independent = resolvePassageEdits(content, 'version', [edit('己')], [[0, content.length]], doc)
  assert.equal(applyResolvedEdits(content, independent), '甲乙丙丁戊新内容')
  assert.equal(content, '甲乙丙丁戊己')
})

test('valid surrogate-adjacent edits preserve spacing and existing ambiguity and overlap guards', () => {
  const content = '前🚆中🚆后  '
  assert.throws(() => resolvePassageEdits(content, 'version', [edit('🚆')], [[0, content.length]], doc),
    (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'ambiguous_passage')
  const changes = resolvePassageEdits(content, 'version', [edit('前'), edit('后')], [[0, content.length]], doc)
  assert.equal(applyResolvedEdits(content, changes), '新内容🚆中🚆新内容  ')
  const overlap = resolvePassageEdits(content, 'version', [edit('前🚆'), edit('🚆中')], [[0, content.length]], doc)
  assert.throws(() => applyResolvedEdits(content, overlap),
    (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === 'overlapping_passages')
})
