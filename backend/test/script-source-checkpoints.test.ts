import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { prepareSourceWork, sourceAnalysisResume, sourceAnalysisRecoveryCheckpoint } from '../src/modules/script/script-source-checkpoints.js'
import { sourceCheckpointResponseFact } from '@video-studio/shared/script/script-source-request-recovery'
import { sourceStoryProgress } from '../src/modules/script/script-source-story-progress.js'
import { sourceAnalysisProgressFingerprint } from '../src/modules/script/script-source-recovery.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { resolveSourceSections, scriptSourcePassages, sourceAnalysisPipelineVersion, sourceMapSchema,
  sourceWorkPlan, validateSourceCoverage, workPassages, type SourceWork } from '../src/modules/script/script-source-map.js'

// Pure checkpoint fixtures: no database initialization, provider or project writes.
const content = Array.from({ length: 24 }, (_, index) => `第${index + 1}集 河岸重逢\n${'林舟沿河寻找伙伴，伙伴点亮灯火等待他回家。'.repeat(100)}\n`).join('')
const passages = scriptSourcePassages(content), plan = sourceWorkPlan(passages)

function rawMap(work: SourceWork) {
  const units = workPassages(passages, work).flatMap(passage => passage.units)
  return sourceMapSchema.parse({ sections: [{ start_unit: units[0]!.id, title: '河岸重逢', episode_number: null,
    summary: '林舟寻找伙伴，伙伴等待他归来。', characters: [], events: [{ summary: '伙伴等待林舟回家。', evidence: { unit_id: units.filter(unit => unit.text.trim()).at(-1)!.id } }] }] })
}

const fullSections = plan.flatMap(work => resolveSourceSections(rawMap(work), workPassages(passages, work)).sections)
function state(overrides: Partial<ScriptSourceAnalysis> = {}): ScriptSourceAnalysis {
  return { id: 'durable-analysis', source_version: 'unchanged-upload-identity', model_id: 'text', status: 'failed',
    phase: 'reading', completed_chunks: 0, total_chunks: plan.length, sections: [], error: '连接中断', updated_at: '2026-10-18T00:00:00.000Z',
    pipeline_version: sourceAnalysisPipelineVersion, work: structuredClone(plan), ...overrides }
}

function fullStory(): ScriptSourceStory {
  return { summary: '林舟返乡寻找伙伴，伙伴一直等他回家。', characters: [],
    timeline: fullSections.map((section, id) => ({ summary: section.events[0]!.summary, section_ids: [id] })),
    threads: [], ending: { summary: '伙伴在河岸重逢。', section_ids: [fullSections.length - 1] }, uncertainties: [] }
}

test('a pending directory with an invalid boundary stays private and repairable without losing validated earlier pages', () => {
  assert.ok(plan.length > 2, 'the long manuscript exercises partial page recovery')
  const first = plan[0]!, work = structuredClone(plan)
  work[1]!.result = { sections: [{ ...rawMap(work[1]!).sections[0]!, start_unit: Number.MAX_SAFE_INTEGER }] }
  const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), work })
  const before = structuredClone(saved.sections), candidate = structuredClone(saved.work![1]!.result)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.sections, before)
  assert.equal(saved.completed_chunks, 1)
  assert.equal(saved.completed_characters, first.offset + first.length)
  assert.deepEqual(saved.work![1]!.result, candidate, 'invalid coordinates do not discard already generated semantic content')
  assert.deepEqual(saved.work!.map(({ offset, length, depth }) => ({ offset, length, depth })), plan)
  assert.equal(saved.phase, 'reading')
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /已保存 1\/\d+ 页目录/)
  validateSourceCoverage(content.slice(0, first.length), saved.sections)
})

test('invalid story provenance rebuilds the story while preserving the complete evidence-checked directory', () => {
  const invalidStory = fullStory(); invalidStory.ending.section_ids = [fullSections.length]
  const saved = state({ completed_chunks: plan.length, sections: structuredClone(fullSections), phase: 'synthesis', story: invalidStory,
    story_work: { input_hash: 'obsolete-story', tasks: [{ key: 'overview', result: { old: true } }] },
    story_candidate: { input_hash: 'obsolete-candidate', result: { covered_section_ids: [0], story: invalidStory } },
    story_response_run_ids: ['obsolete-run'],
    quality: { status: 'passed', input_hash: 'obsolete-review', findings: [] } })
  const before = structuredClone(saved.sections)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.sections, before)
  assert.equal(saved.source_version, 'unchanged-upload-identity')
  assert.equal(saved.completed_chunks, plan.length)
  assert.equal(saved.completed_characters, content.length)
  assert.equal(saved.story, undefined)
  assert.equal(saved.story_work, undefined)
  assert.equal(saved.story_candidate, undefined)
  assert.equal(saved.story_response_run_ids, undefined)
  assert.equal(saved.quality, undefined)
  assert.equal(saved.phase, 'synthesis')
  assert.match(sourceAnalysisResume(saved).message, /已保存完整目录/)
  validateSourceCoverage(content, saved.sections)
})

test('a valid version 5 whole-source raw map awaiting evidence repair migrates without rebuilding its directory', () => {
  const whole = { offset: 0, length: content.length, depth: 0 }, result = rawMap(whole)
  result.sections[0]!.events[0]!.evidence.unit_id = Number.MAX_SAFE_INTEGER
  assert.equal(resolveSourceSections(result, passages).problems.length, 1, 'only an evidence location still needs repair')
  const saved = state({ pipeline_version: 5, completed_chunks: 0, total_chunks: 1, work: [{ ...whole, result }] })
  const before = structuredClone(saved.work)

  prepareSourceWork(content, saved)

  assert.equal(saved.pipeline_version, sourceAnalysisPipelineVersion)
  assert.deepEqual(saved.work, before)
  assert.equal(saved.total_chunks, 1, 'the saved full-source output remains one repairable work item')
  assert.equal(saved.completed_chunks, 0)
  assert.deepEqual(saved.sections, [])
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /当前页待校验或修复的完整候选/)
  prepareSourceWork(content, saved)
  assert.deepEqual(saved.work, before, 'a second preparation after migration must retain the same raw output')
})

test('version 5 ready migration preserves source identity, sections, story and the passed review hash', () => {
  const saved = state({ pipeline_version: 5, status: 'ready', phase: 'ready', completed_chunks: 1, total_chunks: 1,
    sections: structuredClone(fullSections), story: fullStory(), completed_characters: content.length, work: undefined, error: null })
  saved.quality = { status: 'passed', input_hash: sourceQualityInputHash(saved), findings: [] }
  const before = structuredClone({ id: saved.id, source_version: saved.source_version, sections: saved.sections, story: saved.story, quality: saved.quality })

  prepareSourceWork(content, saved)

  assert.deepEqual({ id: saved.id, source_version: saved.source_version, sections: saved.sections, story: saved.story, quality: saved.quality }, before)
  assert.equal(sourceQualityInputHash(saved), before.quality.input_hash)
  assert.equal(saved.status, 'ready')
  assert.equal(saved.phase, 'ready')
  assert.equal(saved.pipeline_version, sourceAnalysisPipelineVersion)
  assert.equal(saved.total_chunks, plan.length)
  assert.equal(saved.completed_chunks, plan.length)
})

test('resume retains complete analyses for targeted quality repair and preserves legacy corrective pages', () => {
  const findings: NonNullable<ScriptSourceAnalysis['quality']> = { status: 'issues', input_hash: 'reviewed-old-map-and-story',
    findings: [{ kind: 'omission', explanation: '遗漏终场伙伴身份。', unit_ids: [0] }] }
  const old = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory(), quality: findings })
  assert.equal(sourceAnalysisResume(old).available, true)
  assert.match(sourceAnalysisResume(old).message, /目录和全剧信息已保存/)
  assert.match(sourceAnalysisResume(old).message, /处理未完成的核对意见/)

  const correcting = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), quality: structuredClone(findings),
    quality_rebuild_for: findings.input_hash })
  prepareSourceWork(content, correcting)
  assert.equal(sourceAnalysisResume(correcting).available, true)
  assert.match(sourceAnalysisResume(correcting).message, /已保存 1\/\d+ 页目录/)
  assert.deepEqual(correcting.quality, findings, 'original findings remain available to guide the corrected output')
  assert.equal(correcting.quality_rebuild_for, findings.input_hash)

  correcting.quality = { ...findings, input_hash: 'new-review-found-different-issues' }
  assert.equal(sourceAnalysisResume(correcting).available, true, 'a later finding cannot discard the valid saved prefix of an old corrective run')
  assert.match(sourceAnalysisResume(correcting).message, /已保存 1\/\d+ 页目录/)
})

test('story recovery uses the same saved and unknown response facts and never lets a complete initial hide an unknown correction', () => {
  const cp = { input_hash: 'initial', raw: 'complete initial answer', initial_started: { input_hash: 'initial' } }
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections),
    story_work: { input_hash: 'story', tasks: [{ key: 'overview' },
      { key: 'characters', output_candidate: { context_hash: 'old-context-is-not-delivery-proof', checkpoint: cp } }] } })
  const before = structuredClone(saved)
  assert.equal(sourceStoryProgress(saved)!.pending[1]!.status, 'saved_response')
  assert.equal(sourceAnalysisResume(saved).action, 'revalidate')
  assert.equal(sourceAnalysisRecoveryCheckpoint(saved).checkpoint, cp, 'a preceding empty task cannot hide saved bytes')
  assert.deepEqual(sourceCheckpointResponseFact(cp), { saved: true, initial_unknown: false, correction_unknown: false, response: 'saved_response' })
  assert.deepEqual(saved, before)
  Object.assign(cp, { correction_started: { input_hash: 'correction' } })
  assert.equal(sourceCheckpointResponseFact(cp).initial_unknown, false)
  assert.equal(sourceCheckpointResponseFact(cp).correction_unknown, true)
  assert.equal(sourceStoryProgress(saved)!.pending[1]!.status, 'unknown_response')
  assert.equal(sourceAnalysisResume(saved).action, 'reconcile_request')
  assert.equal(sourceAnalysisRecoveryCheckpoint(saved).phase, 'correction')
})

test('resume reports durable per-finding handling and a review-only continuation after all findings are handled', () => {
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory(),
    quality: { status: 'issues', input_hash: 'initial-review', findings: [
      { kind: 'omission', explanation: '遗漏伙伴身份。', unit_ids: [0] },
      { kind: 'causality', explanation: '遗漏终场重逢因果。', unit_ids: [1] },
    ] } })
  saved.quality_repair = { review_hash: saved.quality!.input_hash,
    findings_hash: createHash('sha256').update(JSON.stringify(saved.quality!.findings)).digest('hex'),
    current_hash: sourceQualityInputHash(saved), completed_findings: 1 }
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /已处理 1\/2 项意见/)
  assert.doesNotMatch(sourceAnalysisResume(saved).message, /已修补|审核通过|核对已通过/)
  saved.quality_repair!.completed_findings = 2
  assert.match(sourceAnalysisResume(saved).message, /问题处理记录已保存/)
  assert.match(sourceAnalysisResume(saved).message, /全文独立质量核对/)
  saved.quality_repair.current_hash = 'damaged-analysis-fingerprint'
  assert.doesNotMatch(sourceAnalysisResume(saved).message, /已处理 1\/2|问题处理记录已保存/)
  assert.match(sourceAnalysisResume(saved).message, /处理未完成的核对意见/)
})

test('a valid partial revision checkpoint preserves candidate provenance while retaining a continuous saved prefix', () => {
  const revisionReuse: NonNullable<ScriptSourceAnalysis['revision_reuse']> = {
    input_hash: 'revision-plan', base_source_version: 'old-source', source_version: 'unchanged-upload-identity',
    status: 'pending', planned_pages: [0, plan.length - 1], reused_pages: [0], reused_section_ids: [0], reused_characters: plan[0]!.length,
  }
  const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), revision_reuse: revisionReuse })
  const provenance = structuredClone(saved.revision_reuse)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.revision_reuse, provenance)
  assert.equal(saved.completed_chunks, 1)
  validateSourceCoverage(content.slice(0, plan[0]!.length), saved.sections)
  assert.equal(saved.story, undefined)
  assert.equal(saved.quality, undefined)
})

test('invalid revision checkpoints discard reuse provenance before rebuilding the entire directory', () => {
  for (const issue of ['coordinates', 'work_plan', 'pipeline'] as const) {
    const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), story: fullStory(),
      story_work: { input_hash: 'old-story', tasks: [{ key: 'overview', result: { old: true } }] },
      story_candidate: { input_hash: 'old-candidate', result: { covered_section_ids: [0], story: fullStory() } },
      story_response_run_ids: ['old-run'],
      quality: { input_hash: 'old-quality', status: 'passed', findings: [] },
      revision_reuse: { input_hash: 'revision-plan', base_source_version: 'old-source', source_version: 'unchanged-upload-identity',
        status: 'pending', planned_pages: [0], reused_pages: [0], reused_section_ids: [0], reused_characters: plan[0]!.length } })
    if (issue === 'coordinates') saved.sections[0]!.offset = 1
    if (issue === 'work_plan') saved.work![0]!.length--
    if (issue === 'pipeline') saved.pipeline_version = 1

    prepareSourceWork(content, saved)

    assert.equal(saved.revision_reuse!.status, 'discarded', issue)
    assert.deepEqual(saved.sections, [], issue)
    assert.equal(saved.completed_chunks, 0)
    assert.equal(saved.completed_characters, 0)
    assert.equal(saved.story, undefined)
    assert.equal(saved.story_work, undefined)
    assert.equal(saved.story_candidate, undefined)
    assert.equal(saved.story_response_run_ids, undefined)
    assert.equal(saved.quality, undefined)
    assert.deepEqual(saved.work, plan)
  }
})


test('a complete directory retains the unpublished synthesis candidate and repair barrier across preparation', () => {
  const candidate: NonNullable<ScriptSourceAnalysis['story_candidate']> = {
    input_hash: 'same-source-directory-and-configuration',
    result: { covered_section_ids: fullSections.map((_, id) => id), story: fullStory() },
    output_checkpoint: { input_hash: 'same-request', raw: 'the complete upstream response' },
    character_repair: { candidate_hash: 'candidate', diagnosis_hash: 'missing-character', status: 'failed', diagnostics: '连接中断' },
  }
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections),
    story_candidate: structuredClone(candidate), story_response_run_ids: ['previous-compatible-execution'] })
  const before = structuredClone(saved.sections)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.sections, before)
  assert.deepEqual(saved.story_candidate, candidate, 'preparing a resume must not regenerate or discard the saved interpretation')
  assert.deepEqual(saved.story_response_run_ids, ['previous-compatible-execution'])
  assert.equal(saved.story, undefined, 'an incomplete interpretation remains private until its repair is validated')
  assert.equal(saved.phase, 'synthesis')
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /完整目录和全剧整合候选已保存/)
  assert.match(sourceAnalysisResume(saved).message, /修补未完成的人物信息.*独立核对/)

  saved.story_candidate = { input_hash: candidate.input_hash, output_checkpoint: candidate.output_checkpoint }
  assert.match(sourceAnalysisResume(saved).message, /全剧整合候选已保存/, 'a durable raw response also advertises reuse before schema recovery finishes')
})


test('uncertain upstream dispatch never advertises usable continuation from completed directory alone', () => {
  const state = { id: 'blocked', source_version: 'v', model_id: 'm', status: 'failed' as const,
    completed_chunks: 1, total_chunks: 1, sections: [], phase: 'synthesis' as const, error: 'unknown', updated_at: '' }
  const resume = sourceAnalysisResume(state, true)
  assert.equal(resume.available, false); assert.equal(resume.blocked, true)
  assert.match(resume.message, /已完成的分析已保留.*检查已保存回答与请求状态/)
})

test('quality-repair resume separates unstarted, complete saved and unknown answers without changing checkpoints', () => {
  const make = () => {
    const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory() })
    saved.quality = { status: 'issues', input_hash: sourceQualityInputHash(saved), findings: [{ kind: 'omission', explanation: '核实伙伴身份。', unit_ids: [0] }] }
    saved.quality_repair = { review_hash: saved.quality.input_hash,
      findings_hash: createHash('sha256').update(JSON.stringify(saved.quality.findings)).digest('hex'),
      current_hash: sourceQualityInputHash(saved), completed_findings: 0 }
    return saved
  }
  for (const [checkpoint, action, response, modelRequired] of [
    [{}, 'continue', 'not_started', true],
    [{ input_hash: 'input', raw: '' }, 'revalidate', 'saved_response', false],
    [{ input_hash: 'input', raw: '完整回答', initial_started: { input_hash: 'input' } }, 'revalidate', 'saved_response', false],
    [{ input_hash: 'input', raw: '原回答', correction: { input_hash: 'correction', raw: '已使用的完整纠正' }, correction_started: { input_hash: 'correction' } }, 'revalidate', 'saved_response', false],
    [{ input_hash: 'input', initial_started: { input_hash: 'input' } }, 'reconcile_request', 'unknown_response', false],
    [{ input_hash: 'input', raw: '原回答', correction_started: { input_hash: 'correction' } }, 'reconcile_request', 'unknown_response', false],
  ] as const) {
    const saved = { ...make(), quality_repair_output: { binding: 'current', checkpoint } }
    const before = structuredClone(saved), resume = sourceAnalysisResume(saved)
    assert.equal(resume.action, action)
    assert.deepEqual(resume.next, { phase: 'quality_repair', response, model_required: modelRequired })
    assert.equal(resume.blocked === true, action === 'reconcile_request')
    assert.deepEqual(saved, before, 'a public resume description must not grant a request or modify business state')
  }
  const saved: ScriptSourceAnalysis = { ...make(), quality_repair_output: { binding: 'current', checkpoint: { raw: '当前完整回答' } } }
  assert.equal(sourceAnalysisResume(saved, true).action, 'revalidate', 'read-only local validation remains possible while an unrelated old request stays protected')
  saved.quality_repair_output!.checkpoint = { raw: '当前完整回答', correction_started: { input_hash: 'unknown' } }
  assert.equal(sourceAnalysisResume(saved, true).action, 'reconcile_request', 'a missing correction answer cannot be replaced by a new automatic request')
})

test('completed quality repairs expose the next independent review instead of reusing stale repair or review answers', () => {
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory() })
  saved.quality = { status: 'issues', input_hash: 'before-patched-analysis', findings: [{ kind: 'omission', explanation: '已核实伙伴身份。', unit_ids: [0] }] }
  saved.quality_repair = { review_hash: saved.quality.input_hash,
    findings_hash: createHash('sha256').update(JSON.stringify(saved.quality.findings)).digest('hex'), current_hash: sourceQualityInputHash(saved), completed_findings: 1 }
  saved.quality_repair_output = { binding: 'completed-finding', checkpoint: { raw: '已采纳修补原回答' } }
  saved.quality_work = { input_hash: 'obsolete-review', checkpoint: { steps: {} }, output_checkpoint: { raw: '旧核对回答' } }
  assert.deepEqual(sourceAnalysisResume(saved).next, { phase: 'quality_review', response: 'not_started', model_required: true })
  assert.equal(sourceAnalysisResume(saved).action, 'continue')
  saved.quality_work.input_hash = sourceQualityInputHash(saved)
  assert.deepEqual(sourceAnalysisResume(saved).next, { phase: 'quality_review', response: 'saved_response', model_required: false })
  assert.equal(sourceAnalysisResume(saved).action, 'revalidate')
  saved.quality_work.output_checkpoint = { initial_started: { input_hash: 'current-review' } }
  assert.deepEqual(sourceAnalysisResume(saved).next, { phase: 'quality_review', response: 'unknown_response', model_required: false })
  assert.equal(sourceAnalysisResume(saved).action, 'reconcile_request')
})

function withdrawalRecheckState(): ScriptSourceAnalysis {
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory() })
  const currentHash = sourceQualityInputHash(saved)
  saved.quality = { status: 'issues', input_hash: 'before-patched-analysis',
    findings: [{ kind: 'omission', explanation: '核实伙伴身份是否已经保留。', unit_ids: [0] }] }
  const finding = saved.quality.findings[0]!, reason = '当前全剧概要已保留原文中的伙伴身份。', unit_ids = [0]
  const findingsHash = createHash('sha256').update(JSON.stringify(saved.quality.findings)).digest('hex')
  const reviewInputHash = createHash('sha256').update(JSON.stringify([currentHash,
    [{ finding, disposition: 'withdrawn', reason, unit_ids }]])).digest('hex')
  saved.quality_repair = { review_hash: saved.quality.input_hash, findings_hash: findingsHash, current_hash: currentHash,
    completed_findings: 1, withdrawals: [{ finding_index: 0,
      finding_hash: createHash('sha256').update(JSON.stringify(finding)).digest('hex'), analysis_hash: currentHash, reason, unit_ids }] }
  saved.ordinary_story_dispatch = { run_id: saved.id, binding: 'exact-current-source-and-configuration',
    protected_task_keys: [], authorized_at: saved.updated_at, quality_input_hash: reviewInputHash,
    quality_workflow: { phase: 'review', review_hash: saved.quality.input_hash, findings_hash: findingsHash,
      finding_index: 1, current_hash: currentHash, checkpoint_hash: '', protected_repair_bindings: [],
      review_input_hash: reviewInputHash, protected_review: true } }
  saved.quality_work = { input_hash: reviewInputHash, checkpoint: { steps: {} }, output_checkpoint: {} }
  return saved
}

function retainedRecheckState(): ScriptSourceAnalysis {
  const saved = withdrawalRecheckState(), digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const currentHash = sourceQualityInputHash(saved), unit = passages.flatMap(passage => passage.units).find(unit => unit.id === 0)!
  saved.quality_repair!.decisions = [{ finding_index: 0, finding_hash: digest(saved.quality!.findings[0]),
    before_hash: currentHash, after_hash: currentHash, decision: 'retain_analysis', reason: '当前全剧概要已有原文支持的伙伴身份。',
    analysis_refs: [{ path: 'story.summary', value_hash: digest(saved.story!.summary) }],
    source_refs: [{ unit_id: unit.id, text_hash: digest(unit.text) }] }]
  delete saved.quality_repair!.withdrawals
  const reviewInputHash = digest([currentHash, 'source-quality-decisions-v1', saved.quality_repair!.decisions])
  saved.ordinary_story_dispatch!.quality_input_hash = reviewInputHash
  saved.ordinary_story_dispatch!.quality_workflow!.review_input_hash = reviewInputHash
  saved.quality_work!.input_hash = reviewInputHash
  return saved
}

test('historical withdrawal checkpoints remain saved and cannot advertise model continuation or validate as a new retain decision', () => {
  for (const checkpoint of [
    { input_hash: 'exact-review-request', raw: '完整撤销后复核回答' },
    { input_hash: 'exact-review-request', initial_started: { input_hash: 'exact-review-request' } },
    { input_hash: 'exact-review-request', raw: '原始复核回答', correction_started: { input_hash: 'unknown-correction' } },
  ]) {
    const saved = withdrawalRecheckState()
    saved.quality_work!.output_checkpoint = checkpoint
    const before = structuredClone(saved), resume = sourceAnalysisResume(saved)
    assert.equal(resume.action, 'blocked')
    assert.equal(resume.available, false)
    assert.notEqual(resume.next?.model_required, true, 'old withdrawn is not an authorization for a paid new decision')
    assert.match(resume.message, /withdrawn|旧决定|旧处理记录/)
    assert.deepEqual(saved, before, 'legacy evidence, saved bytes, exact dispatch and allowances remain untouched')
  }
})

test('a bound full-rebuild decision blocks continuation while preserving complete and unknown request checkpoints', () => {
  for (const checkpoint of [
    { input_hash: 'exact-rebuild-request', raw: '完整重建决定原始回答' },
    { input_hash: 'exact-rebuild-request', initial_started: { input_hash: 'exact-rebuild-request' } },
    { input_hash: 'exact-rebuild-request', raw: '完整重建决定原始回答', correction_started: { input_hash: 'unknown-correction' } },
  ]) {
    const saved = retainedRecheckState()
    saved.quality_repair!.completed_findings = 0
    saved.quality_repair!.decisions![0]!.decision = 'requires_full_rebuild'
    saved.quality_repair!.decisions![0]!.reason = '问题涉及目录边界，不能安全局部处理。'
    saved.quality_repair_output = { binding: 'exact-bound-rebuild-decision', checkpoint }
    const before = structuredClone(saved), resume = sourceAnalysisResume(saved)
    assert.equal(resume.action, 'blocked')
    assert.equal(resume.available, false)
    assert.notEqual(resume.next?.model_required, true)
    assert.match(resume.message, /重建决定已保存/)
    assert.deepEqual(saved, before, 'a display-only stop cannot erase raw output or unknown initial/correction protection')
    const stale = structuredClone(saved)
    stale.quality_repair!.current_hash = 'not-the-current-analysis'
    assert.notEqual(sourceAnalysisResume(stale).action, 'blocked', 'an unbound terminal decision cannot stop unrelated current analysis')
  }
})

test('an explicit retained-analysis recheck recognizes its saved or unknown answer through the exact current workflow without changing grants', () => {
  for (const [checkpoint, action, response] of [
    [{ input_hash: 'exact-review-request', raw: '完整保留决定后复核回答' }, 'revalidate', 'saved_response'],
    [{ input_hash: 'exact-review-request', initial_started: { input_hash: 'exact-review-request' } }, 'reconcile_request', 'unknown_response'],
    [{ input_hash: 'exact-review-request', raw: '原始复核回答', correction_started: { input_hash: 'unknown-correction' } }, 'reconcile_request', 'unknown_response'],
  ] as const) {
    const saved = retainedRecheckState()
    assert.notEqual(saved.quality_work!.input_hash, sourceQualityInputHash(saved), 'explicit decisions change the actual review input')
    saved.quality_work!.output_checkpoint = checkpoint
    const before = structuredClone(saved), resume = sourceAnalysisResume(saved)
    assert.equal(resume.action, action)
    assert.deepEqual(resume.next, { phase: 'quality_review', response, model_required: false })
    assert.equal(resume.blocked === true, action === 'reconcile_request')
    assert.deepEqual(saved, before, 'recognizing a checkpoint must not refresh its dispatch or correction allowance')
    if (action === 'revalidate') assert.equal(sourceAnalysisResume(saved, true).action, 'revalidate', 'a protected unrelated request does not prohibit local validation')
  }
  const saved = retainedRecheckState()
  saved.quality_work!.input_hash = sourceQualityInputHash(saved)
  saved.quality_work!.output_checkpoint = { raw: '保留决定之前的旧基础核对回答' }
  assert.deepEqual(sourceAnalysisResume(saved).next, { phase: 'quality_review', response: 'not_started', model_required: true },
    'a current derived review binding takes priority over an obsolete base-hash answer')
})

test('stale retained-analysis workflows cannot label a derived review answer as saved or unknown current work', () => {
  const staleCases: [string, (saved: ScriptSourceAnalysis) => void][] = [
    ['run', saved => { saved.ordinary_story_dispatch!.run_id = 'previous-run' }],
    ['phase', saved => { saved.ordinary_story_dispatch!.quality_workflow!.phase = 'repair' }],
    ['review', saved => { saved.ordinary_story_dispatch!.quality_workflow!.review_hash = 'previous-review' }],
    ['findings', saved => { saved.ordinary_story_dispatch!.quality_workflow!.findings_hash = 'previous-findings' }],
    ['analysis', saved => { saved.ordinary_story_dispatch!.quality_workflow!.current_hash = 'previous-analysis' }],
    ['progress', saved => { saved.ordinary_story_dispatch!.quality_workflow!.finding_index = 0 }],
    ['review input', saved => { saved.ordinary_story_dispatch!.quality_workflow!.review_input_hash = 'previous-review-input' }],
    ['missing review input', saved => { delete saved.ordinary_story_dispatch!.quality_workflow!.review_input_hash }],
    ['source', saved => { saved.source_version = 'different-upload' }],
    ['story', saved => { saved.story!.summary += '新增事实。' }],
    ['incomplete repair', saved => { saved.quality_repair!.completed_findings = 0; saved.quality_repair!.decisions = [] }],
    ['rebuild', saved => { saved.quality_rebuild_for = saved.quality!.input_hash }],
  ]
  for (const [label, change] of staleCases) for (const checkpoint of [
    { raw: '不属于当前复核的完整回答' }, { initial_started: { input_hash: 'not-current-review' } },
  ]) {
    const saved = retainedRecheckState()
    saved.quality_work!.output_checkpoint = checkpoint
    change(saved)
    const before = structuredClone(saved), resume = sourceAnalysisResume(saved)
    assert.equal(resume.action, 'continue', label)
    assert.equal(resume.next?.response, 'not_started', label)
    assert.equal(resume.next?.model_required, true, label)
    assert.deepEqual(saved, before, label + ' must remain read-only')
  }
})


test('a private directory item prefix survives fixed-plan preparation and counts as actual recoverable progress', () => {
  const work: NonNullable<ScriptSourceAnalysis['work']> = structuredClone(plan), partial = rawMap(work[1]!).sections
  const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), work })
  const before = sourceAnalysisProgressFingerprint(saved)
  work[1]!.output_checkpoint = { pages: { steps: { 'source-map:pages': {
    input_hash: 'exact-current-input', value: { items: partial, complete: false, page_size: 8 },
  } } } }
  const prefix = structuredClone(saved.work![1]!.output_checkpoint)
  assert.notEqual(sourceAnalysisProgressFingerprint(saved), before, 'saved complete items are progress even before directory coverage increases')
  prepareSourceWork(content, saved)
  assert.deepEqual(saved.work![1]!.output_checkpoint, prefix)
  assert.equal(saved.completed_chunks, 1)
  assert.equal(saved.sections.length, 1, 'the private last section cannot be published without its remaining successors')
  assert.equal(saved.completed_characters, plan[0]!.length)
  assert.deepEqual(saved.work!.map(({ offset, length, depth }) => ({ offset, length, depth })), plan)
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /当前页 1 个完整条目/)
})


test('a source-bound overflow seed remains private across preparation and advertises continuation', () => {
  const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)) })
  saved.work![1]!.output_checkpoint = { seed: { input_hash: 'next-page-input', sections: rawMap(plan[1]!).sections } }
  const before = structuredClone(saved.work![1]!.output_checkpoint)
  prepareSourceWork(content, saved)
  assert.deepEqual(saved.work![1]!.output_checkpoint, before)
  assert.equal(saved.work![1]!.result, undefined)
  assert.equal(saved.completed_chunks, 1)
  assert.equal(saved.sections.length, 1)
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /当前页 1 个完整条目/)
})

test('story resume reports all durable subtasks, one local replay opportunity and an exhausted no-op action', async () => {
  const { sourceStoryProgress, sourceStoryReplayVersion } = await import('../src/modules/script/script-source-story-progress.js')
  const tasks: NonNullable<ScriptSourceAnalysis['story_work']>['tasks'] = Array.from({ length: 14 }, (_, i) => ({ key: `saved:${i}`, result: { complete: true } }))
  tasks.push({ key: 'uncertainties:0', failure: { message: 'old schema failure' }, output_candidate: { context_hash: 'same', checkpoint: { raw: 'saved original', correction_started: { input_hash: 'unknown' } } } },
    { key: 'uncertainties:2', failure: { message: 'old recovery conflict' }, output_candidate: { context_hash: 'same2', checkpoint: {} } })
  const saved = state({phase:'synthesis',story_work:{input_hash:'same',tasks}})
  const before = structuredClone(saved), progress = sourceStoryProgress(saved)!
  assert.equal(progress.completed,14); assert.equal(progress.total,16)
  assert.deepEqual(progress.pending.map(x=>x.key),['uncertainties:0','uncertainties:2'])
  assert.equal(sourceAnalysisResume(saved).action,'reconcile_request'); assert.match(sourceAnalysisResume(saved).message,/14\/16/)
  assert.deepEqual(saved,before,'GET helper is readonly')
  tasks[14]!.result = { uncertainties: [] }
  tasks[15]!.output_candidate!.replay_version = sourceStoryReplayVersion
  tasks[15]!.output_candidate!.checkpoint = { raw: 'invalid original', correction: { input_hash: 'exact', raw: 'invalid corrected' } }
  assert.equal(sourceAnalysisResume(saved).action,'blocked','an exhausted syntax failure cannot be fixed by authorizing another sibling request')
  delete tasks[14]!.result
  tasks[14]!.output_candidate!.replay_version = sourceStoryReplayVersion
  assert.equal(sourceAnalysisResume(saved).action,'reconcile_request','an unfinished unknown task needs its own request reconciliation')
  tasks[14]!.result = { uncertainties: [] }
  assert.deepEqual(sourceStoryProgress(saved)!.protected_keys,['uncertainties:0'])
  delete tasks[14]!.output_candidate
  assert.equal(sourceAnalysisResume(saved).action,'blocked'); assert.equal(sourceAnalysisResume(saved).available,false)
  assert.match(sourceAnalysisResume(saved).message,/15\/16.*uncertainties:2/)
})


test('dense policy is explicit and preserves legacy unstarted, complete and unknown request identities', () => {
  const text = Array.from({ length: 60 }, (_, i) => `第${i + 1}集 河岸\n${'林舟寻找伙伴。'.repeat(32)}\n`).join('')
  const oldPlan = sourceWorkPlan(scriptSourcePassages(text))
  const densePlan = sourceWorkPlan(scriptSourcePassages(text), true)
  assert.ok(densePlan.length > oldPlan.length)
  for (const checkpoint of [undefined, { input_hash: 'old', original_raw: 'saved original', correction: { input_hash: 'spent', raw: '{"approve":false}' } },
    { input_hash: 'old', initial_started: { input_hash: 'old', intent_id: 'unknown' } }]) {
    const saved = state({ work: structuredClone(oldPlan), completed_chunks: 0, total_chunks: oldPlan.length,
      ...(checkpoint ? { work: oldPlan.map((item, i) => i === 0 ? { ...item, output_checkpoint: structuredClone(checkpoint) } : { ...item }) } : {}) })
    const before = structuredClone(saved.work)
    prepareSourceWork(text, saved)
    assert.deepEqual(saved.work!.map(({ offset, length, depth }) => ({ offset, length, depth })), oldPlan, 'dense manuscripts do not implicitly change an existing plan')
    assert.deepEqual(saved.work, before, 'spent decisions and unknown dispatch markers are immutable')
    assert.equal(saved.map_output_policy, undefined)
  }
  const fresh = state({ map_output_policy: 'dense-v1', work: undefined, total_chunks: 0 })
  prepareSourceWork(text, fresh)
  assert.deepEqual(fresh.work, densePlan)
})
