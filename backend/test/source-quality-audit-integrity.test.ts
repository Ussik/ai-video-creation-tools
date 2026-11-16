import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const marker = '【原稿分析核对资料】\n'
for (const variant of ['valid', 'source_hash', 'missing_unit', 'finding_hash', 'duplicate', 'incomplete'] as const) test(`modern completed-review identity verifies exact decisions and source evidence: ${variant}`, async () => {
  const content = '第一集\n旅人归乡。', unit = scriptSourcePassages(content).flatMap(p => p.units).find(unit => unit.text.includes('旅人'))!
  const state = { id: 'audit-test', source_version: 'source', model_id: 'fixture', status: 'running', phase: 'synthesis', updated_at: '2026-11-15', error: null,
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length,
    sections: [{ offset: 0, length: content.length, title: '第一集', episode_number: 1, summary: '旅人归乡。', characters: [], events: [] }],
    story: { summary: '旅人归乡。', characters: [], timeline: [], threads: [], ending: { summary: '已归乡。', section_ids: [0] }, uncertainties: [] } } as ScriptSourceAnalysis
  const inputHash = sourceQualityInputHash(state), finding = { kind: 'omission' as const, explanation: '核实归乡状态。', unit_ids: [unit.id] }
  state.quality = { input_hash: inputHash, status: 'issues', findings: [finding] }
  state.quality_repair = { review_hash: inputHash, findings_hash: digest([finding]), current_hash: inputHash, completed_findings: 1,
    decisions: [{ finding_index: 0, finding_hash: digest(finding), before_hash: inputHash, after_hash: inputHash, decision: 'retain_analysis', reason: '原文明确记载旅人已经归乡。',
      analysis_refs: [{ path: 'story.summary', value_hash: digest(state.story!.summary) }], source_refs: [{ unit_id: unit.id, text_hash: digest(unit.text) }] }] }
  const decision = state.quality_repair.decisions![0]!
  if (variant === 'source_hash') decision.source_refs[0]!.text_hash = 'a'.repeat(64)
  if (variant === 'missing_unit') decision.source_refs[0]!.unit_id = 9999
  if (variant === 'finding_hash') decision.finding_hash = 'b'.repeat(64)
  if (variant === 'duplicate') state.quality_repair.decisions!.push(structuredClone(decision))
  if (variant === 'incomplete') state.quality_repair.completed_findings = 0
  let calls = 0
  await reviewSourceQuality({ filename: 'audit.txt', content }, state, async prompt => {
    calls++
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.equal(!!input.post_repair_audit_context, variant === 'valid')
    if (variant === 'valid') assert.equal(input.post_repair_audit_context.context_hash,
      digest([inputHash, 'source-quality-decisions-v1', state.quality_repair!.decisions]))
    assert.equal(input.previous_review_notes, undefined)
    assert.equal(input.quality_repair, undefined)
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }, () => {}, new AbortController().signal)
  assert.equal(calls, 1)
})
