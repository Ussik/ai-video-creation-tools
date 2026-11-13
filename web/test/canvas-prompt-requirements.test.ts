import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedPromptBlockNames, type ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import type { PromptSectionBlock } from '@video-studio/shared/visuals/prompt-section-document'
import { buildPromptRequirements, promptRequirementNames } from '../src/features/canvas/canvas-prompt-requirements'

const section = (name: ManagedPromptBlockName, id: string = name): PromptSectionBlock => ({
  id, kind: 'managed', name, text: `【${name}】\n当前内容\n【${name}结束】`,
})

test('the requirements catalogue covers all eleven persisted types in the approved display order', () => {
  assert.equal(promptRequirementNames.length, 11)
  assert.equal(new Set(promptRequirementNames).size, 11)
  assert.deepEqual([...promptRequirementNames].sort(), [...managedPromptBlockNames].sort())
  assert.equal(promptRequirementNames[0], '设定图固定要求')
  assert.equal(promptRequirementNames.at(-1), '生成参数约束')
})

test('missing requirements follow the actual setting-board, image and video tasks', () => {
  const cases = [
    { visualBoard: true, modality: 'image' as const, expected: ['设定图固定要求', '图片生成要求', '项目画风约束', '基础身份参考', '基础版本与本次状态变化', '生成参考图', '生成参数约束'] },
    { visualBoard: false, modality: 'image' as const, expected: ['图片生成要求', '项目画风约束', '镜头视觉设定', '图片参考图用途', '生成参数约束'] },
    { visualBoard: false, modality: 'video' as const, expected: ['项目画风约束', '镜头视觉设定', '视频参考图用途', '视频生成要求', '生成参数约束'] },
  ]
  for (const { expected, ...context } of cases) {
    const entries = buildPromptRequirements({ blocks: [], ...context })
    assert.deepEqual(entries.filter(entry => entry.status === 'unconfigured').map(entry => entry.name), expected)
    assert.equal(entries.filter(entry => entry.status === 'not_applicable').length, 11 - expected.length)
    assert.equal(entries.some(entry => entry.status === 'active'), false, 'browsing an empty catalogue cannot configure a section')
    assert.ok(entries.every(entry => entry.id === `missing:${entry.name}` && !entry.block))
  }
})

test('unknown task context leaves missing types unconfigured rather than claiming they do not apply', () => {
  const entries = buildPromptRequirements({ blocks: [], visualBoard: false })
  assert.equal(entries.length, 11)
  assert.ok(entries.every(entry => entry.status === 'unconfigured' && !entry.primary))
  const board = buildPromptRequirements({ blocks: [], visualBoard: true })
  assert.equal(board.find(entry => entry.name === '设定图固定要求')!.primary, true)
  assert.equal(board.find(entry => entry.name === '图片生成要求')!.status, 'unconfigured')
})

test('existing sections always stay active even when their type is unusual for the task', () => {
  const videoReference = section('视频参考图用途', 'imported-video-reference')
  const boardEntries = buildPromptRequirements({ blocks: [videoReference], visualBoard: true, modality: 'image' })
  const imported = boardEntries.find(entry => entry.id === videoReference.id)!
  assert.equal(imported.status, 'active')
  assert.equal(imported.block, videoReference)
  assert.equal(imported.primary, false)
  const primary = section('设定图固定要求', 'imported-board-content')
  for (const modality of ['image', 'video'] as const) {
    const entries = buildPromptRequirements({ blocks: [primary], visualBoard: false, modality })
    assert.equal(entries.find(entry => entry.id === primary.id)!.status, 'active')
    assert.equal(entries.find(entry => entry.id === primary.id)!.primary, false, 'ordinary nodes must not reinterpret imported board blocks as their editable body')
  }
})

test('duplicate active blocks retain every identity while a same-name removed source remains separate', () => {
  const name = '项目画风约束'
  const removed: PromptSectionBlock = { ...section(name, 'old-source'), text: '', deleted: true,
    sourceText: '旧画风', pendingSourceText: '更新画风', mergeBaseText: '旧合并基线', sourceStatus: 'source_changed' }
  const first = { ...section(name, 'first-current'), sourceText: '第一来源', pendingSourceText: '第一更新' }
  const second = section(name, 'pasted-current')
  const blocks = [removed, second, { id: 'body', kind: 'body' as const, text: '保留空白\n\n' }, first]
  const before = structuredClone(blocks)
  blocks.forEach(Object.freeze)
  Object.freeze(blocks)
  const entries = buildPromptRequirements({ blocks, visualBoard: false, modality: 'image' }).filter(entry => entry.name === name)
  assert.deepEqual(entries.map(entry => entry.id), [second.id, first.id], 'display ordering does not combine or reorder same-name active identities')
  assert.ok(entries.every(entry => entry.status === 'active' && entry.removedBlocks?.[0] === removed))
  assert.equal(entries[0]!.block, second)
  assert.equal(entries[1]!.block, first)
  assert.equal(entries[0]!.block!.sourceText, undefined, 'pasted identities do not acquire an old source')
  assert.deepEqual(blocks, before, 'catalogue construction never changes source, deletion, body or ordering data')
})

test('a removed-only type remains absent and keeps its recovery metadata without a new active block', () => {
  const removed: PromptSectionBlock = { ...section('图片生成要求', 'removed-output'), text: '', deleted: true,
    sourceText: '原输出要求', pendingSourceText: '最新输出要求', deletionSource: 'source' }
  const entries = buildPromptRequirements({ blocks: [removed], visualBoard: false, modality: 'image' })
  const entry = entries.find(entry => entry.name === '图片生成要求')!
  assert.equal(entry.id, 'missing:图片生成要求')
  assert.equal(entry.status, 'unconfigured')
  assert.equal(entry.block, undefined)
  assert.equal(entry.removedBlocks?.[0], removed)
  assert.equal(removed.deleted, true)
  assert.equal(removed.pendingSourceText, '最新输出要求')
})

test('all active setting-board primary identities are locatable without merging ambiguous documents', () => {
  const first = section('设定图固定要求', 'primary-a'), second = section('设定图固定要求', 'primary-b')
  const entries = buildPromptRequirements({ blocks: [second, first], visualBoard: true, modality: 'image' })
    .filter(entry => entry.status === 'active')
  assert.deepEqual(entries.map(entry => ({ id: entry.id, primary: entry.primary })), [
    { id: 'primary-b', primary: true }, { id: 'primary-a', primary: true },
  ])
})
