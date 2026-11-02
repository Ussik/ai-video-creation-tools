import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedPromptBlockNames } from '@video-studio/shared/visuals/prompt-document'
import { promptSectionDetails, promptSectionLineDiff, readablePromptSection } from '../src/features/canvas/canvas-prompt-section-details'

test('requirements identify their actual source and keep node parameters separate from project style', () => {
  for (const name of managedPromptBlockNames) {
    const text = `【${name}】\n原要求\n【${name}结束】`
    const details = promptSectionDetails({ id: name, kind: 'managed', name, text, sourceText: text })
    assert.ok(details.category)
    assert.ok(details.source)
    assert.equal(details.state, '沿用来源')
    assert.equal(details.summary, '原要求')
  }
  const parameter = promptSectionDetails({ id: 'p', kind: 'managed', name: '图片生成要求', text: '' })
  assert.equal(parameter.source, '本节点图片参数')
  assert.equal(parameter.parameters, true)
  assert.equal(parameter.state, '本节点自定义')
  assert.equal(promptSectionDetails({ id: 's', kind: 'managed', name: '项目画风约束', text: '' }).source, '项目画风')
})

test('summaries resolve stable references for display without modifying original text or exposing markers', () => {
  const text = '【基础身份参考】\n[[ref:hero]] 保持身份。\n下一行。\n【基础身份参考结束】'
  const block = { id: 'identity', kind: 'managed' as const, name: '基础身份参考' as const, text, sourceText: text }
  assert.equal(promptSectionDetails(block, [{ assetId: 'hero', label: '林晚基础' }]).summary, '@林晚基础 保持身份。 下一行。')
  assert.equal(readablePromptSection(text), '@原参考图片 保持身份。\n下一行。')
  assert.equal(block.text, text)
  assert.equal(promptSectionDetails({ ...block, pendingSourceText: '' }).state, '待确认')
  assert.equal(promptSectionDetails({ ...block, text: '', deleted: true }).state, '已移除')
})

test('a deliberately deleted requirement stays removed while retaining the latest source for recovery', () => {
  const source = '【项目画风约束】\n原画风\n【项目画风约束结束】'
  const pending = source.replace('原画风', '最新画风')
  const block = { id: 'removed', kind: 'managed' as const, name: '项目画风约束' as const, text: '', deleted: true,
    sourceText: source, pendingSourceText: pending, mergeBaseText: source, sourceStatus: 'source_changed' as const }
  const before = structuredClone(block)
  const details = promptSectionDetails(block)
  assert.equal(details.pending, false)
  assert.equal(details.state, '已移除')
  assert.equal(details.summary, '最新画风')
  assert.deepEqual(block, before, 'presentation does not discard recovery or undo metadata')
})

test('line comparison distinguishes independent insertions, replacements, deletions and unchanged context', () => {
  const before = '同一身份\n蓝衣\n同一材质', after = '同一身份\n白衣\n新增标签\n同一材质'
  const changes = promptSectionLineDiff(before, after)
  assert.deepEqual(changes, [
    { kind: 'same', text: '同一身份' }, { kind: 'removed', text: '蓝衣' },
    { kind: 'added', text: '白衣' }, { kind: 'added', text: '新增标签' }, { kind: 'same', text: '同一材质' },
  ])
  assert.deepEqual(changes.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), before)
  assert.deepEqual(changes.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), after)
  assert.deepEqual(promptSectionLineDiff('旧来源', ''), [{ kind: 'removed', text: '旧来源' }])
  assert.deepEqual(promptSectionLineDiff('', '新要求'), [{ kind: 'added', text: '新要求' }])
  assert.deepEqual(promptSectionLineDiff('一致\n', '一致\n'), [{ kind: 'same', text: '一致' }, { kind: 'same', text: '' }])
})
