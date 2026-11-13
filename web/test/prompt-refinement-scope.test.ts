import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedPromptBlockNames, type ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument, serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { applyPromptRefinementContent, promptRefinementContent, promptRefinementContentError, promptRefinementSource } from '../src/features/skills/prompt-refinement-scope'

const section = (name: ManagedPromptBlockName, content: string) => `【${name}】\n${content}\n【${name}结束】`

test('ordinary refinement replaces only creative prose and retains all eleven current requirement identities and metadata', () => {
  const prompt = `  首段创作内容\n\n${managedPromptBlockNames.map((name, index) => section(name, `当前要求 ${index}`)).join('\n\n')}\n\n补充创作内容\n`
  const document = parsePromptSectionDocument(prompt)
  document.blocks.filter(block => block.kind === 'managed').forEach((block, index) => Object.assign(block, {
    sourceText: section(block.name!, `旧来源 ${index}`), pendingSourceText: section(block.name!, `待审来源 ${index}`),
    mergeBaseText: section(block.name!, `合并基线 ${index}`), sourceStatus: 'source_changed',
  }))
  const before = structuredClone(document)
  const source = promptRefinementSource({ prompt, promptSections: document })
  const applied = applyPromptRefinementContent(source, '重新组织后的主要内容')
  assert.equal(source.protectedNames.length, 11)
  assert.deepEqual(applied.document.blocks.filter(block => block.kind === 'managed'), before.blocks.filter(block => block.kind === 'managed'))
  assert.equal(applied.body.trim(), '重新组织后的主要内容')
  assert.deepEqual(document, before, 'source document is never mutated')
  assert.equal(serializePromptSectionDocument(applied.document), applied.prompt)
})

test('setting board merges the optional prose into its one primary while preserving context and source history exactly', () => {
  const prompt = `${section('基础身份参考', '沿用基础身份')}\n\n补充：细节图不要遮挡主视图。\n\n${section('设定图固定要求', '对象定义、四个视图与信息图版式。')}\n\n${section('项目画风约束', '当前项目画风')}`
  const document = parsePromptSectionDocument(prompt)
  const primary = document.blocks.find(block => block.name === '设定图固定要求')!
  primary.sourceText = section('设定图固定要求', '原始对象定义')
  const source = promptRefinementSource({ prompt, promptSections: document, visualBoard: true })
  assert.match(source.content, /对象定义、四个视图与信息图版式/)
  assert.match(source.content, /细节图不要遮挡/)
  assert.deepEqual(source.protectedNames, ['基础身份参考', '项目画风约束'])
  const applied = applyPromptRefinementContent(source, '整理后的对象、视图与版式，并落实补充要求。')
  const currentPrimary = applied.document.blocks.find(block => block.id === primary.id)!
  assert.equal(currentPrimary.text, section('设定图固定要求', '整理后的对象、视图与版式，并落实补充要求。'))
  assert.equal(currentPrimary.sourceText, primary.sourceText)
  assert.equal(applied.body.trim(), '')
  assert.deepEqual(applied.document.blocks.filter(block => block.kind === 'managed' && block.id !== primary.id), document.blocks.filter(block => block.kind === 'managed' && block.id !== primary.id))
})

test('deleted sections and a same-name active section retain distinct identities after applying', () => {
  const prompt = `${section('设定图固定要求', '当前主内容')}\n\n${section('项目画风约束', '创作者当前画风')}`
  const document = parsePromptSectionDocument(prompt)
  document.blocks.splice(1, 0, { id: 'removed-style', kind: 'managed', name: '项目画风约束', text: '', deleted: true,
    sourceText: section('项目画风约束', '已移除的旧画风'), pendingSourceText: section('项目画风约束', '不应复活的新画风'), sourceStatus: 'source_changed' })
  const source = promptRefinementSource({ prompt, promptSections: document, visualBoard: true })
  const applied = applyPromptRefinementContent(source, '只修改主内容')
  assert.deepEqual(applied.document.blocks.filter(block => block.name === '项目画风约束'), document.blocks.filter(block => block.name === '项目画风约束'))
  assert.doesNotMatch(applied.prompt, /旧画风|不应复活/)
})

test('a removed primary remains removed and a prose-only setting task stays prose-only', () => {
  const prompt = `手写的设定任务\n\n${section('图片生成要求', '当前输出要求')}`
  const document = parsePromptSectionDocument(prompt)
  const tombstone = { id: 'removed-primary', kind: 'managed' as const, name: '设定图固定要求' as const, text: '', deleted: true,
    sourceText: section('设定图固定要求', '已删除主区块') }
  document.blocks.unshift(tombstone)
  const applied = applyPromptRefinementContent(promptRefinementSource({ prompt, promptSections: document, visualBoard: true }), '重新整理的手写设定任务')
  assert.deepEqual(applied.document.blocks[0], tombstone)
  assert.doesNotMatch(applied.prompt, /设定图固定要求/)
  assert.match(applied.prompt, /重新整理的手写设定任务/)
})

test('a document with only context can receive a new prose body without rebuilding its context', () => {
  const prompt = section('项目画风约束', '保持当前画风')
  const source = promptRefinementSource({ prompt })
  const applied = applyPromptRefinementContent(source, '添加的主要内容')
  assert.equal(applied.prompt, `添加的主要内容\n\n${prompt}`)
  assert.deepEqual(applied.document.blocks[1], source.document.blocks[0])
})

test('ambiguous or malformed primary documents do not offer a refinement scope', () => {
  const duplicated = `${section('设定图固定要求', '第一份')}\n\n${section('设定图固定要求', '第二份')}`
  const ambiguous = promptRefinementSource({ prompt: duplicated, visualBoard: true })
  assert.match(ambiguous.error, /多个设定图/)
  assert.throws(() => applyPromptRefinementContent(ambiguous, '不应应用'), /多个设定图/)
  const malformed = promptRefinementSource({ prompt: '正文\n【项目画风约束】\n未闭合' })
  assert.match(malformed.error, /尚未结束/)
})

test('manual drafts cannot inject any managed requirement markers into editable content', () => {
  const source = promptRefinementSource({ prompt: '当前创作正文' })
  for (const name of managedPromptBlockNames) {
    assert.match(promptRefinementContentError(section(name, '企图覆盖要求')), /只能包含主要创作内容/)
    assert.throws(() => applyPromptRefinementContent(source, `正文\n【${name}】未闭合`), /区块标记/)
  }
  assert.throws(() => applyPromptRefinementContent(source, '  '), /不能为空/)
})

test('response extraction exposes only allowed text and never imports response-managed context', () => {
  assert.equal(promptRefinementContent(`候选正文\n\n${section('项目画风约束', '模型改写的画风')}`, false), '候选正文')
  const board = `${section('设定图固定要求', '候选设定内容')}\n\n候选补充\n\n${section('图片生成要求', '模型改写的要求')}`
  assert.equal(promptRefinementContent(board, true), '候选设定内容\n\n候选补充')
})
