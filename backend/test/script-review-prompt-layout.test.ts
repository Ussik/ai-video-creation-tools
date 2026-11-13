import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { reviewScriptDraftCompleteness } from '../src/modules/script/script-draft-completeness.js'
import { reassessDraftReviewEvidence } from '../src/modules/script/script-draft-evidence-reassessment.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const candidateMarker = '待核对草稿原文（资料）：'
const candidateEnd = '\n【本轮候选正文结束】'
const reassessmentMarker = '【证据结论复核资料】\n'
const reassessmentEnd = '\n【本轮复核资料结束】'
const backgroundMarker = '既有事实与创作要求（资料）：'
const originalReviewMarker = '【完整原始审读任务与资料】\n'

function jsonBetween<T>(prompt: string, start: string, end: string): T {
  const from = prompt.indexOf(start), to = prompt.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, 'the current review data has an explicit, closed boundary')
  return JSON.parse(prompt.slice(from + start.length, to)) as T
}

test('review presents complete current candidates before long historical background without requiring saved candidate copies', async () => {
  const manuscript = 'MANUSCRIPT_START：完整原稿开场。\n' + '全文事实及人物因果均保留。'.repeat(6000) + '\nMANUSCRIPT_END：原稿结局。'
  const saved = 'SAVED_HISTORY_START：旧道具仍为木钥匙。\n' + '旧版背景资料。'.repeat(2000) + '\nSAVED_HISTORY_END。'
  const context = { uploaded_script: { content: manuscript },
    saved_documents: [{ id: 'historical-outline', artifact_type: 'outline', title: '旧版故事大纲', content: saved }],
    creator_messages: [{ role: 'user', text: '按已确认方案整理本轮道具设计，铜钥匙与原稿结局保持一致。' }] }
  const draft: WorkflowDraft = { stage: 'props', scope: 'project', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.props.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `CANDIDATE_${index}_START：铜钥匙是本轮完整道具正文。\n材质为青铜，交还主角后封存。\nCANDIDATE_${index}_END。` })) }
  const before = structuredClone({ draft, context })
  let calls = 0
  await reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_draft_completeness')
    const submitted = jsonBetween<Array<{ key: string; artifact_type: string; title: string; content: string }>>(prompt, candidateMarker, candidateEnd)
    assert.deepEqual(submitted, draft.artifacts.map(artifact => ({ key: artifact.artifact_type, ...artifact })))
    assert.ok(prompt.indexOf(candidateEnd) < prompt.indexOf('MANUSCRIPT_START'), 'the entire current candidate packet precedes the long original manuscript')
    assert.ok(prompt.indexOf(candidateEnd) < prompt.indexOf('SAVED_HISTORY_START'), 'historical saved documents cannot obscure the current candidate packet')
    assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf(backgroundMarker) + backgroundMarker.length)), context,
      'the full original manuscript, saved text and creator requirement remain available for comparison')
    assert.match(prompt, /saved_documents[^\n]*(?:历史|已保存)/)
    assert.match(prompt, /(?:不|无)[^\n]*(?:saved_documents|已保存文档)[^\n]*(?:查找|存在)|(?:saved_documents|已保存文档)[^\n]*(?:不|无)[^\n]*(?:候选|查找)/)
    return JSON.stringify({ facts: [], checked_artifacts: [...scriptStageArtifacts.props], findings: [] })
  }, { context, review_scope: 'whole' })
  assert.equal(calls, 1)
  assert.deepEqual({ draft, context }, before, 'prompt layout does not alter either source or candidate data')
})

test('reassessment presents every issue and complete numbered candidate before the intact long original review', async () => {
  const original = 'ORIGINAL_REVIEW_START：完整验收合同及创作者要求。\n' + '完整原稿和既有文档均不得删除。'.repeat(6000) + '\nORIGINAL_REVIEW_END：保留原稿结局。'
  const sources = [{ key: 'props', title: '本轮道具清单', content: 'PROP_BODY_START：铜钥匙长十厘米。\n主人公交还铜钥匙后封存。\nPROP_BODY_END。' },
    { key: 'prop_visuals', title: '本轮道具外观', content: 'VISUAL_BODY_START：青铜材质，有红色印纹。\n末尾印纹保持完整。\nVISUAL_BODY_END。' }]
  const report = { checked_artifacts: ['props', 'prop_visuals'], facts: [], findings: [{ topic: '铜钥匙候选正文缺失',
    source_key: 'props', kind: 'missing_core_setting', severity: 'blocking', quote: '未提交候选正文。',
    explanation: '在历史保存文档中没有找到当前道具清单。', suggestion: '提交已经存在的本轮完整候选正文。' }] }
  const before = structuredClone({ report, sources })
  let calls = 0
  const result = await reassessDraftReviewEvidence(original, report, sources, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_draft_evidence_reassessment')
    const current = jsonBetween<{ issues: Array<Record<string, unknown>>;
      sources: Array<{ key: string; title: string; units: Array<{ id: number; text: string }> }> }>(prompt, reassessmentMarker, reassessmentEnd)
    assert.deepEqual(current.issues, report.findings.map((item, index) => ({ ...item, id: `findings:${index}` })),
      'the reviewer receives the exact old conclusion and all of its semantic fields')
    assert.deepEqual(current.sources.map(source => ({ key: source.key, title: source.title, content: source.units.map(unit => unit.text).join('') })), sources,
      'numbered candidate units retain every original character and both source identities')
    for (const source of current.sources) assert.equal(new Set(source.units.map(unit => unit.id)).size, source.units.length)
    assert.ok(prompt.indexOf(reassessmentEnd) < prompt.indexOf('ORIGINAL_REVIEW_START'), 'all current issues and numbered sources precede the long old task')
    assert.ok(prompt.includes(originalReviewMarker + original), 'the complete original review remains intact for independent judgment')
    return JSON.stringify({ reassessments: [{ id: 'findings:0', verdict: 'withdrawn', reason: '本轮候选清单正文完整，未保存到历史文档不构成缺失。',
      source_key: null, first_unit: null, last_unit: null }] })
  }, { id: 'test-prompt-layout' })
  assert.equal(calls, 1)
  assert.equal(result.unresolved, false)
  assert.deepEqual(result.result.findings, [])
  assert.deepEqual({ report, sources }, before)
})
