import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-long-pipeline-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db } = await import('../src/infrastructure/database/db.js')
const { selectSourceMaterial, sourceEvidenceBatches } = await import('../src/modules/script/script-source-material.js')
const { generateLongStageDraft } = await import('../src/modules/script/script-stage-generation.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
import type { GenerationCheckpoint, GenerationStepEvent } from '../src/modules/script/script-generation-steps.js'
const { repairLongScriptDraft } = await import('../src/modules/script/script-long-repair.js')
const { workflowRequest, workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const content = '开场林舟得到钥匙。\n' + '主线发展。'.repeat(6000) + '\n终场林舟交还钥匙。'
const source: ScriptSourceDocument = { project_id: 'test', filename: 'story.txt', content, updated_at: 'now', analysis: { id: 'map', source_version: 'version', model_id: 'text',
  status: 'ready', phase: 'ready', completed_chunks: 2, total_chunks: 2, error: null, updated_at: 'now', sections: [{ offset: 0, length: content.length, unit_id: 0, title: '林舟完整主线', episode_number: null, summary: '得到钥匙并最终交还。', characters: [], events: [] }],
  story: { summary: '9集：得到钥匙并最终交还。', characters: [], timeline: [], threads: [], ending: { summary: '交还钥匙', section_ids: [0] }, uncertainties: [] } } }
function selection(prompt: string) {
  const marker = '可读取片段：'
  const fragments = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
  return { offsets: [fragments[0].offset, fragments.at(-1).offset] }
}
type RepairPassage = { kind: 'candidate' | 'source'; source_key: string; units: Array<{ id: string; text: string }> }
function repairPassages(prompt: string): RepairPassage[] {
  const marker = '可修订原文：'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}
function numberedEdit(passages: RepairPassage[], kind: RepairPassage['kind'], key: string, find: string, replace: string) {
  const passage = passages.find(item => item.kind === kind && item.source_key === key && item.units.map(unit => unit.text).join('').includes(find))!
  assert.ok(passage, `missing supplied evidence: ${key} ${find}`)
  const text = passage.units.map(unit => unit.text).join(''), start = text.indexOf(find), end = start + find.length
  let offset = 0
  const covered = passage.units.flatMap(unit => { const at = offset; offset += unit.text.length; return at < end && offset > start ? [{ ...unit, offset: at }] : [] })
  const first = covered[0]!, last = covered.at(-1)!
  return { start_id: first.id, end_id: last.id, replace: text.slice(first.offset, start) + replace + text.slice(end, last.offset + last.text.length), reason: '补齐并同步已授权的缺口' }
}
test('accepted source is returned in full without locator requests or directory dependence', async () => {
  let calls = 0
  const material = await selectSourceMaterial(source, '结局与开场', async () => { calls++; throw new Error('unexpected locator') })
  assert.deepEqual(material, [{ offset: 0, content }])
  assert.equal(calls, 0)
  assert.deepEqual(sourceEvidenceBatches(source), [material])
})

test('long outline generates every stage document and all nine episodes in one full-source request', async () => {
  const { scriptStageArtifacts } = await import('@video-studio/shared/script/script-stage-content')
  let calls = 0
  const draft = await generateLongStageDraft(workflowRequest.parse({ stage: 'outline' }), 'INPUT_STYLE: 水墨画风。保留原稿9集。', source, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'workflow_draft')
    assert.match(prompt, /INPUT_STYLE: 水墨/)
    assert.ok(prompt.includes(JSON.stringify(content)))
    return JSON.stringify({ artifacts: scriptStageArtifacts.outline.map(type => ({ artifact_type: type, title: type,
      content: type === 'episode_outline' ? Array.from({ length: 9 }, (_, i) => `第${i + 1}集：守护并归还钥匙。`).join('\n') : '完整、具体且一致的剧情设定。' })), scenes: [] })
  })
  assert.equal(calls, 1)
  assert.equal(draft.artifacts.length, 9)
  assert.match(draft.artifacts.find(item => item.artifact_type === 'episode_outline')!.content, /第9集/)
})

test('full-source authoring keeps enabled rules, exact creator constraints and every original character', async () => {
  const { completeSourceEvidence } = await import('../src/modules/script/script-source-material.js')
  let calls = 0
  const draft = await generateLongStageDraft(workflowRequest.parse({ stage: 'characters' }), 'IDENTITY_WITH_DIRECTORY', source, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'workflow_draft')
    assert.match(prompt, /ALL_ENABLED_SKILL_RULES/); assert.match(prompt, /CREATOR_DECISION：保留角色身份/)
    assert.ok(prompt.includes(JSON.stringify(content)))
    assert.ok(!prompt.includes('IDENTITY_WITH_DIRECTORY'))
    return JSON.stringify({ artifacts: ['characters', 'relationships'].map(type => ({ artifact_type: type, title: type, content: '人物身份、动机与关系已明确。' })), scenes: [] })
  }, { authoringPrompt: 'ALL_ENABLED_SKILL_RULES\nCREATOR_DECISION：保留角色身份' })
  assert.equal(calls, 1); assert.equal(draft.artifacts.length, 2)
  assert.equal(completeSourceEvidence(source).map(item => item.content).join(''), content)
})

test('full-stage checkpoints reuse only validated drafts from matching source and creator requirements', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const runner = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const generate = async () => { calls++; return JSON.stringify({ artifacts: ['characters', 'relationships'].map(type => ({ artifact_type: type, title: type, content: '完整设定。' })), scenes: [] }) }
  const request = workflowRequest.parse({ stage: 'characters' })
  await generateLongStageDraft(request, '水墨', source, generate, { steps: runner() })
  await generateLongStageDraft(request, '水墨', source, generate, { steps: runner() })
  assert.equal(calls, 1)
  checkpoint.steps['draft:whole'].value = { artifacts: [], scenes: [] }
  await generateLongStageDraft(request, '水墨', source, generate, { steps: runner() })
  assert.equal(calls, 2, 'invalid cached output is regenerated')
  await generateLongStageDraft(request, '写实', source, generate, { steps: runner() })
  assert.equal(calls, 3)
  await generateLongStageDraft(request, '写实', { ...source, content: content + '新的结尾事实。' }, generate, { steps: runner() })
  assert.equal(calls, 4)
})

test('bounded repairs synchronize related candidates and original source, preserving unrelated text', async () => {
  const draft = workflowGenerationDraftSchema.parse({ stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: '人物', content: '林舟动机：待补齐。\n其余人物保持原样。' },
    { artifact_type: 'relationships', title: '关系', content: '伙伴不知道林舟目的。\n其他关系保持原样。' }], scenes: [] })
  const pending = { id: 'pending', version: 'v', draft, findings: [{ source_key: 'characters', kind: 'unresolved_setting' as const, quote: '林舟动机：待补齐。', explanation: '动机未明确', suggestion: '确定归还钥匙的动机并同步关系' }], request: {}, source_version: 'source', updated_at: 'now' }
  const result = await repairLongScriptDraft(pending, source, [{ decision: '为履行伙伴约定归还钥匙' }], '保留既有事实。', async (prompt, contract) => {
    if (prompt.includes('检查当前任务的原文证据是否充分')) return JSON.stringify({ sufficient: true, missing: [], offsets: [] })
    if (contract?.name === 'script_repair_selection') return '{"passages":[{"source_key":"relationships","offset":0}]}'
    if (contract?.name === 'script_source_selection') return JSON.stringify(selection(prompt))
    assert.match(prompt, /伙伴不知道林舟目的/)
    const passages = repairPassages(prompt)
    assert.equal(JSON.stringify(contract!.schema).includes('"find"'), false, 'model selects IDs instead of retyping original text')
    return JSON.stringify({ summary: '同步动机和关系', status: 'repaired', edits: [
      numberedEdit(passages, 'candidate', 'characters', '林舟动机：待补齐。', '林舟动机：履行伙伴约定归还钥匙。'),
      numberedEdit(passages, 'candidate', 'relationships', '伙伴不知道林舟目的。', '伙伴知道林舟为履行约定归还钥匙。'),
      numberedEdit(passages, 'source', 'script-source', '终场林舟交还钥匙。', '终场林舟履行与伙伴的约定，交还钥匙。'),
    ] })
  }, new AbortController().signal)
  assert.equal(result.draft.artifacts[0].content, '林舟动机：履行伙伴约定归还钥匙。\n其余人物保持原样。')
  assert.equal(result.draft.artifacts[1].content, '伙伴知道林舟为履行约定归还钥匙。\n其他关系保持原样。')
  assert.equal(result.source_update!.content, source.content.replace('终场林舟交还钥匙。', '终场林舟履行与伙伴的约定，交还钥匙。'))
  assert.equal(pending.draft.artifacts[0].content, draft.artifacts[0].content, 'repair remains a proposal')
})

test('medium-source repairs read the complete original and grouped cross-document occurrences without a source sufficiency detour', async () => {
  const text = '原稿保留父亲身份。\n' + '调查推进，尚未见父。'.repeat(1500) + '\n终局父亲平安归来。'
  assert.ok(text.length > 12000 && text.length < 24000)
  const medium = { ...source, content: text, analysis: undefined }
  const draft = workflowGenerationDraftSchema.parse({ stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: '人物', content: '第26集首次见父。\n保留人物身份。' },
    { artifact_type: 'relationships', title: '关系', content: '第25集已见到父亲。\n保留其他关系。' },
  ], scenes: [] })
  const pending = { id: 'medium', version: 'v1', source_version: 's', request: {}, draft, findings: [{
    source_key: 'characters', kind: 'contradiction' as const, topic: '首次见父集位', quote: '第26集首次见父。',
    explanation: '两份文档对见父时间冲突。', suggestion: '统一为第26集。',
    related_findings: [{ source_key: 'relationships', quote: '第25集已见到父亲。', explanation: '同一揭示提前一集。', suggestion: '第25集只取得线索。' }],
  }] }
  const result = await repairLongScriptDraft(pending, medium, [{ decision: '首次见父统一为第26集。' }], '保留原稿身份和结局', async (prompt, contract) => {
    assert.ok(!contract!.name.startsWith('script_source_'), 'full original needs neither locator nor sufficiency calls')
    if (contract!.name === 'script_repair_selection') return '{"passages":[]}'
    const passages = repairPassages(prompt)
    const original = passages.filter(passage => passage.kind === 'source').flatMap(passage => passage.units).map(unit => unit.text).join('')
    assert.equal(original, text, 'all original facts remain available, including an ending outside the issue window')
    return JSON.stringify({ summary: '统一第26集首次见父，第25集只取得线索。', status: 'repaired', edits: [
      numberedEdit(passages, 'candidate', 'relationships', '第25集已见到父亲。', '第25集只取得线索，第26集首次见父。'),
    ] })
  }, new AbortController().signal)
  assert.match(result.draft.artifacts[1].content, /第26集首次见父/)
  assert.match(result.draft.artifacts[1].content, /保留其他关系/)
  assert.equal(result.source_update, undefined, 'a correct original stays untouched')
})

test('overlapping and duplicate findings read staged repairs and keep source evidence aligned after length changes', async () => {
  const draft = workflowGenerationDraftSchema.parse({ stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: '人物', content: '林舟动机：待补齐。\n其余人物保持原样。' },
    { artifact_type: 'relationships', title: '关系', content: '伙伴关系保持原样。' }], scenes: [] })
  const finding = { source_key: 'characters', kind: 'unresolved_setting' as const, quote: '林舟动机：待补齐。', explanation: '归还钥匙的动机不明', suggestion: '补齐动机并同步因果' }
  const pending = { id: 'pending', version: 'v', draft, findings: [finding, { ...finding, explanation: '承诺的对象不明' }, { ...finding, explanation: '重复的归还动机缺口' }], request: {}, source_version: 'source' }
  const before = structuredClone(pending)
  let repairs = 0
  const result = await repairLongScriptDraft(pending, source, pending.findings.map(item => ({ ...item, decision: '交给AI具体决定，不再次询问' })), '保留既有事实。', async (prompt, contract) => {
    if (prompt.includes('检查当前任务的原文证据是否充分')) return JSON.stringify({ sufficient: true, missing: [], offsets: [] })
    if (contract?.name === 'script_repair_selection') return '{"passages":[]}'
    if (contract?.name === 'script_source_selection') return JSON.stringify(selection(prompt))
    const passages = repairPassages(prompt); repairs++
    const current = passages.filter(item => item.kind === 'candidate').flatMap(item => item.units.map(unit => unit.text)).join('')
    const effective = passages.filter(item => item.kind === 'source').flatMap(item => item.units.map(unit => unit.text)).join('')
    if (repairs === 1) return JSON.stringify({ summary: '动机为履行承诺，补齐开场约定', status: 'repaired', edits: [
      numberedEdit(passages, 'candidate', 'characters', '林舟动机：待补齐。', '林舟动机：履行承诺归还钥匙。'),
      numberedEdit(passages, 'source', 'script-source', '开场林舟得到钥匙。', '开场林舟得到钥匙，并承诺归还，不改变获取钥匙的主线。'),
    ] })
    assert.match(current, /履行.*承诺/); assert.doesNotMatch(current, /待补齐/)
    assert.match(effective, /并承诺归还，不改变获取钥匙的主线/)
    if (repairs === 2) return JSON.stringify({ summary: '明确向伙伴承诺，结尾履约', status: 'repaired', edits: [
      numberedEdit(passages, 'candidate', 'characters', '林舟动机：履行承诺归还钥匙。', '林舟动机：履行对伙伴的承诺归还钥匙。'),
      numberedEdit(passages, 'source', 'script-source', '终场林舟交还钥匙。', '终场林舟履行对伙伴的承诺，交还钥匙。'),
    ] })
    assert.match(current, /对伙伴的承诺/); assert.match(effective, /终场林舟履行对伙伴的承诺/)
    return JSON.stringify({ summary: '此前已明确对伙伴履约，并同步开场与结尾，不再重复改写', status: 'already_resolved', edits: [] })
  }, new AbortController().signal)
  assert.equal(repairs, 3)
  assert.equal(result.draft.artifacts[0].content, '林舟动机：履行对伙伴的承诺归还钥匙。\n其余人物保持原样。')
  assert.equal(result.source_update!.content, source.content.replace('开场林舟得到钥匙。', '开场林舟得到钥匙，并承诺归还，不改变获取钥匙的主线。').replace('终场林舟交还钥匙。', '终场林舟履行对伙伴的承诺，交还钥匙。'))
  assert.equal(result.source_update!.original_content, source.content)
  assert.equal(result.source_update!.replacements.length, 2)
  assert.deepEqual(pending, before, 'staged repair never mutates retained candidates or uploaded text')
})

test('invalid repair IDs and no-op first repairs fail without changing the retained draft', async () => {
  const draft = workflowGenerationDraftSchema.parse({ stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: '人物', content: '动机待补齐。' },
    { artifact_type: 'relationships', title: '关系', content: '伙伴关系保持原样。' }], scenes: [] })
  const pending = { id: 'pending', version: 'v', draft, findings: [{ source_key: 'characters', kind: 'unresolved_setting' as const, quote: '动机待补齐。', explanation: '动机未确定', suggestion: '给出具体动机' }], request: {}, source_version: 'source' }
  for (const invalid of ['id', 'no-op']) {
    let repairs = 0
    await assert.rejects(repairLongScriptDraft(pending, source, [{ decision: 'AI决定' }], '保留既有事实', async (prompt, contract) => {
    if (prompt.includes('检查当前任务的原文证据是否充分')) return JSON.stringify({ sufficient: true, missing: [], offsets: [] })
      if (contract?.name === 'script_repair_selection') return '{"passages":[]}'
      if (contract?.name === 'script_source_selection') return JSON.stringify(selection(prompt))
      repairs++
      return JSON.stringify(invalid === 'id' ? { summary: '伪造位置', status: 'repaired', edits: [{ start_id: 'foreign', end_id: 'foreign', replace: '伪造', reason: '伪造' }] }
        : { summary: '声称已解决', status: 'already_resolved', edits: [] })
    }, new AbortController().signal), /script_draft_repair 契约/)
    assert.equal(repairs, 2, 'only one bounded format correction')
    assert.equal(pending.draft.artifacts[0].content, '动机待补齐。')
    assert.equal('source_update' in pending, false)
  }
})

test('large saved settings are not replaced with model-generated summaries', async () => {
  const { prepareConfirmedScriptContext } = await import('../src/modules/script/script-confirmed-context.js')
  const documents = [{ id: 'saved', artifact_type: 'world', title: '规则', content: '前段设定。'.repeat(4000) + 'FINAL_RULE: 每次使用钥匙失去一天记忆。' }]
  let calls = 0
  assert.equal(await prepareConfirmedScriptContext(documents, async () => { calls++; throw new Error('unexpected summary') }), undefined)
  assert.equal(calls, 0)
  assert.match(documents[0].content, /FINAL_RULE/)
})

test('a failed later finding resumes earlier validated edits without re-reading or re-generating them', async () => {
  const draft = workflowGenerationDraftSchema.parse({ stage: 'characters', artifacts: [
    { artifact_type: 'characters', title: '人物', content: '林舟动机待补齐。\n保留旁支。' },
    { artifact_type: 'relationships', title: '关系', content: '伙伴承诺待补齐。' }], scenes: [] })
  const findings = [
    { source_key: 'characters', kind: 'unresolved_setting' as const, quote: '林舟动机待补齐。', explanation: '动机缺失', suggestion: '补齐归还动机' },
    { source_key: 'relationships', kind: 'unresolved_setting' as const, quote: '伙伴承诺待补齐。', explanation: '承诺缺失', suggestion: '补齐伙伴承诺' },
  ]
  const pending = { id: 'repair-session', version: 'v1', draft, findings, request: {}, source_version: 'source' }
  const answers = [{ topic: 'one' }, { topic: 'two' }]
  let saved: GenerationCheckpoint = { steps: {} }, failLater = true, firstCalls = 0
  const runner = () => createGenerationSteps({ checkpoint: saved, save: state => { saved = structuredClone(state) } })
  const generate = async (prompt: string, contract?: { name: string }) => {
    if (contract?.name === 'script_source_coverage') return JSON.stringify({ sufficient: true, missing: [], offsets: [] })
    const later = prompt.includes('"topic":"two"')
    if (contract?.name === 'script_repair_selection') {
      if (later && failLater) throw new Error('second finding interrupted')
      if (!later) firstCalls++
      return '{"passages":[]}'
    }
    if (contract?.name === 'script_source_selection') return JSON.stringify(selection(prompt))
    const passages = repairPassages(prompt)
    return JSON.stringify({ summary: later ? '补齐伙伴承诺' : '补齐动机并同步有效稿', status: 'repaired', edits: later ? [
      numberedEdit(passages, 'candidate', 'relationships', '伙伴承诺待补齐。', '伙伴答应护送林舟归还钥匙。'),
    ] : [
      numberedEdit(passages, 'candidate', 'characters', '林舟动机待补齐。', '林舟为履行承诺归还钥匙。'),
      numberedEdit(passages, 'source', 'script-source', '终场林舟交还钥匙。', '终场林舟履行承诺交还钥匙。'),
    ] })
  }
  await assert.rejects(repairLongScriptDraft(pending, source, answers, '保留原稿', generate, new AbortController().signal, runner()), /second finding interrupted/)
  assert.ok(saved.steps['repair:0']); assert.equal(saved.steps['repair:1'], undefined)
  failLater = false
  const repaired = await repairLongScriptDraft(pending, source, answers, '保留原稿', generate, new AbortController().signal, runner())
  assert.equal(firstCalls, 1)
  assert.match(repaired.draft.artifacts[0].content, /保留旁支/)
  assert.match(repaired.draft.artifacts[1].content, /伙伴答应护送/)
  assert.match(repaired.source_update!.content, /履行承诺交还钥匙/)
  assert.equal(pending.draft.artifacts[0].content, draft.artifacts[0].content)
})
