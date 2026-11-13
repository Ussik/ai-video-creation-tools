import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { buildScriptChatSourceContext, planScriptChatSourceContext, type ScriptChatSourceContextOptions, type ScriptChatSemanticScope } from '../src/modules/script/script-chat-source-context.js'
import { scriptDocumentVersion, scriptSourceVersion } from '../src/modules/script/script-source-identity.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'

function sourceFixture(): ScriptSourceDocument {
  const source: ScriptSourceDocument = { project_id: 'isolated-fixture', filename: '长剧本.md', updated_at: '2026-10-19T00:00:00.000Z', revision: 2, content: '' }
  const sections = Array.from({ length: 24 }, (_, id) => {
    const offset = source.content.length
    const fact = id === 5 ? '林舟问路。赵师傅指向旧桥。' : id === 16 ? '赵师傅在车站说：“末班车七点开。”' : `居民在第${id + 1}集沿街行走。`
    source.content += `第${id + 1}集\n${fact}\n${'雨水落在青石路面，街边灯光亮起。'.repeat(90)}\n`
    return { offset, length: source.content.length - offset, title: `第${id + 1}集`, episode_number: id + 1, summary: fact,
      characters: id === 5 ? [{ name: '林舟', description: '问路的人', evidence: { offset: offset + `第${id + 1}集\n`.length, quote: '林舟问路。' } }] : [],
      events: [], continues_previous: false }
  })
  source.analysis = { id: 'analysis-fixture', source_version: scriptSourceVersion(source), model_id: 'fixture', status: 'ready', phase: 'ready',
    pipeline_version: 6, completed_chunks: 1, total_chunks: 1, completed_characters: source.content.length, error: null, updated_at: source.updated_at,
    sections, quality: { input_hash: 'fixture-quality', status: 'passed', findings: [] },
    story: { summary: '林舟沿旧街寻找车站，居民提供路线信息。', characters: [{ name: '林舟', aliases: [], description: '问路的人', section_ids: [5] }],
      timeline: [], threads: [], ending: { summary: '林舟走到车站。', section_ids: [23] }, uncertainties: [] } }
  refreshQuality(source)
  return source
}

function refreshQuality(source: ScriptSourceDocument) {
  source.analysis!.quality = { input_hash: sourceQualityInputHash(source.analysis!), status: 'passed', findings: [] }
}

const scope = (source: ScriptSourceDocument, overrides: Partial<ScriptChatSemanticScope> = {}): ScriptChatSemanticScope =>
  ({ mode: 'targeted', source_version: scriptDocumentVersion(source), section_ids: [], literal_queries: ['赵师傅'], reason: '明确的称呼位置查询。', ...overrides })
const options = (source: ScriptSourceDocument, overrides: Partial<ScriptChatSourceContextOptions> = {}): ScriptChatSourceContextOptions =>
  ({ messages: [{ role: 'user', text: '请核实这一处细节。' }], toolsAvailable: true, semantic_scope: scope(source), ...overrides })
function packFor(prompt: string) {
  return JSON.parse(prompt.split('【局部原文资料包】\n')[1]!.split('\n【局部原文资料包结束】')[0]!)
}

test('explicit model literal subjects retain every raw occurrence and exact adjacent source ranges', () => {
  const source = sourceFixture(), result = buildScriptChatSourceContext(source, options(source))
  assert.equal(result.mode, 'targeted')
  assert.equal(result.reason, 'targeted_literal_lookup')
  assert.equal(result.source_version, scriptDocumentVersion(source))
  assert.equal(result.analysis_source_version, scriptSourceVersion(source))
  assert.equal(result.coverage.complete_source, false)
  assert.deepEqual(result.coverage.ranges.flatMap(range => range.section_ids), [4, 5, 6, 15, 16, 17])
  const pack = packFor(result.prompt)
  assert.deepEqual(pack.literal_matches[0].raw_match_section_ids, [5, 16])
  assert.equal(pack.global_background.interpretation_only, true)
  assert.equal(pack.index.purpose, 'location_clues_only')
  assert.deepEqual(pack.index.selected_sections.map((section: { id: number }) => section.id), [4, 5, 6, 15, 16, 17])
  for (const range of pack.source_ranges) assert.equal(range.content, source.content.slice(range.offset, range.offset + range.length))
  assert.match(result.prompt, /不能代替原文证据或证明两个名称属于同一人/)
  assert.match(result.prompt, /搜索零命中仅说明本次查询未找到/)
})

test('missing or invalid semantic scopes retain full source instead of interpreting request vocabulary', () => {
  const source = sourceFixture()
  for (const text of ['赵师傅在哪？', '第6集发生了什么？', '请问这个呢？', 'targeted模式查找原文']) {
    const result = buildScriptChatSourceContext(source, options(source, { semantic_scope: undefined, messages: [{ role: 'user', text }] }))
    assert.equal(result.mode, 'full'); assert.equal(result.reason, 'semantic_scope_required')
  }
  for (const invalid of [{ source_version: 'stale' }, { section_ids: [999] }, { section_ids: [5, 5] }, { mode: 'full' as const }]) {
    assert.equal(buildScriptChatSourceContext(source, options(source, { semantic_scope: scope(source, invalid) })).mode, 'full')
  }
})

test('model section selection expands neighbors and complete continuation chains without parsing episode words', () => {
  const source = sourceFixture(), sections = source.analysis!.sections
  sections[5]!.continues_previous = true; sections[4]!.continues_previous = true
  sections[6]!.continues_previous = true; sections[7]!.continues_previous = true
  refreshQuality(source)
  const result = buildScriptChatSourceContext(source, options(source, { semantic_scope: scope(source, { section_ids: [5], literal_queries: [] }) }))
  assert.equal(result.mode, 'targeted'); assert.equal(result.reason, 'targeted_model_scope')
  assert.deepEqual(result.coverage.ranges[0]!.section_ids, [3, 4, 5, 6, 7])
})

test('literal subjects crossing a section boundary retain full source', () => {
  const source = sourceFixture(), sections = source.analysis!.sections, original = sections[16]!
  const splitOffset = source.content.indexOf('赵师傅', original.offset) + 1
  sections.splice(16, 1, { ...original, length: splitOffset - original.offset },
    { ...original, offset: splitOffset, length: original.offset + original.length - splitOffset, continues_previous: true })
  refreshQuality(source)
  const result = buildScriptChatSourceContext(source, options(source))
  assert.equal(result.mode, 'full'); assert.equal(result.reason, 'cross_section_literal_match')
})

test('explicit operations and invalid analysis cannot narrow source even with a proposed local scope', () => {
  const source = sourceFixture()
  for (const override of [{ workflow: { stage: 'characters' } }, { documentAction: { operation: 'revise' } }, { pendingDraft: { id: 'draft' } },
    { questionResponse: { status: 'answered' } }, { resourceActions: [{ operation: 'generate' }] }, { scenes: [{ id: 'scene' }] },
    { toolsAvailable: false }, { enabled: false }, { sourceVersion: 'stale' }]) {
    assert.equal(buildScriptChatSourceContext(source, options(source, override)).mode, 'full')
  }
  for (const change of [(value: ScriptSourceDocument) => { value.analysis!.status = 'running' },
    (value: ScriptSourceDocument) => { value.analysis!.quality!.status = 'issues' },
    (value: ScriptSourceDocument) => { value.analysis!.sections[5]!.offset++ },
    (value: ScriptSourceDocument) => { value.analysis!.story!.summary = '未复核变化' }]) {
    const changed = sourceFixture(); change(changed)
    assert.equal(buildScriptChatSourceContext(changed, options(changed)).mode, 'full')
  }
})

test('empty, missing literal subjects and excessive selected ranges fall back to full original', () => {
  const source = sourceFixture()
  for (const choice of [{ section_ids: [], literal_queries: [] }, { literal_queries: ['不存在的称呼'] },
    { section_ids: source.analysis!.sections.map((_, id) => id), literal_queries: [] }]) {
    assert.equal(buildScriptChatSourceContext(source, options(source, { semantic_scope: scope(source, choice) })).mode, 'full')
  }
})

test('bounded overview declares omitted rows while selected original passages remain exact', () => {
  const source = sourceFixture()
  source.analysis!.sections = source.analysis!.sections.flatMap(section => Array.from({ length: 4 }, (_, index) => {
    const offset = section.offset + Math.floor(section.length * index / 4), end = section.offset + Math.floor(section.length * (index + 1) / 4)
    return { ...section, offset, length: end - offset, title: `${section.title}小节${index}`, characters: [], events: [] }
  }))
  refreshQuality(source)
  const result = buildScriptChatSourceContext(source, options(source)), pack = packFor(result.prompt)
  assert.equal(result.mode, 'targeted'); assert.equal(pack.index.complete_directory, false)
  assert.equal(pack.index.total_sections, 96)
  for (const match of pack.literal_matches[0].raw_match_section_ids) assert.ok(result.coverage.ranges.some(range => range.section_ids.includes(match)))
})

test('planner asks the model to understand conversation and follows a validated semantic scope', async () => {
  const source = sourceFixture(); let requests = 0
  const result = await planScriptChatSourceContext(source, options(source, { messages: [
    { role: 'user', text: '先别分析全剧，帮我找找那个指路师傅实际说过的话。' },
    { role: 'assistant', text: '你说的称呼是赵师傅。' },
    { role: 'user', text: '对，就核实这些话的出现位置。' },
  ] }), async (prompt, contract) => {
    requests++; assert.equal(contract?.name, 'script_chat_source_scope')
    assert.match(prompt, /对，就核实这些话/); assert.match(prompt, /不要通过关键词名单分类/)
    return JSON.stringify(scope(source))
  })
  assert.equal(requests, 1); assert.equal(result.mode, 'targeted')
  assert.deepEqual(result.coverage.ranges.flatMap(range => range.section_ids), [4, 5, 6, 15, 16, 17])
  const full = await planScriptChatSourceContext(source, options(source), async () => JSON.stringify(scope(source, { mode: 'full', section_ids: [], literal_queries: [], reason: '该问题的身份关系需要全剧原文。' })))
  assert.equal(full.mode, 'full'); assert.equal(full.reason, 'model_full_source')
})

test('planner skips explicit operations and falls back on invalid or failed model decisions', async () => {
  const source = sourceFixture(); let requests = 0
  const generate = async () => { requests++; throw new Error('model unavailable') }
  assert.equal((await planScriptChatSourceContext(source, options(source, { workflow: { stage: 'outline' } }), generate)).mode, 'full')
  assert.equal(requests, 0)
  const failed = await planScriptChatSourceContext(source, options(source), generate)
  assert.equal(failed.mode, 'full'); assert.equal(failed.reason, 'semantic_scope_failed')
  const invalid = await planScriptChatSourceContext(source, options(source), async () => JSON.stringify(scope(source, { section_ids: [999] })))
  assert.equal(invalid.mode, 'full'); assert.equal(invalid.reason, 'semantic_scope_failed')
})

test('planner does not swallow cancellation or accept a source version changed during planning', async () => {
  const source = sourceFixture(), controller = new AbortController()
  await assert.rejects(planScriptChatSourceContext(source, options(source, { signal: controller.signal }), async () => {
    controller.abort(); throw controller.signal.reason
  }), /abort/i)
  const original = scope(source)
  const stale = await planScriptChatSourceContext(source, options(source), async () => {
    source.content += '\n新内容'; return JSON.stringify(original)
  })
  assert.equal(stale.mode, 'full'); assert.equal(stale.reason, 'source_version_mismatch')
})
