import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { prepareSourceWork, sourceAnalysisResume } from '../src/modules/script/script-source-checkpoints.js'
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

test('an invalid pending directory page is discarded without losing the validated earlier pages', () => {
  assert.ok(plan.length > 2, 'the long manuscript exercises partial page recovery')
  const first = plan[0]!, work = structuredClone(plan)
  work[1]!.result = { sections: [{ ...rawMap(work[1]!).sections[0]!, start_unit: Number.MAX_SAFE_INTEGER }] }
  const saved = state({ completed_chunks: 1, sections: structuredClone(fullSections.slice(0, 1)), work })
  const before = structuredClone(saved.sections)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.sections, before)
  assert.equal(saved.completed_chunks, 1)
  assert.equal(saved.completed_characters, first.offset + first.length)
  assert.equal(saved.work![1]!.result, undefined)
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
    quality: { status: 'passed', input_hash: 'obsolete-review', findings: [] } })
  const before = structuredClone(saved.sections)

  prepareSourceWork(content, saved)

  assert.deepEqual(saved.sections, before)
  assert.equal(saved.source_version, 'unchanged-upload-identity')
  assert.equal(saved.completed_chunks, plan.length)
  assert.equal(saved.completed_characters, content.length)
  assert.equal(saved.story, undefined)
  assert.equal(saved.story_work, undefined)
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
  assert.match(sourceAnalysisResume(saved).message, /当前页待修复目录/)
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
  assert.match(sourceAnalysisResume(old).message, /修补未完成的问题/)

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

test('resume reports durable per-finding repairs and a review-only continuation after all findings are repaired', () => {
  const saved = state({ phase: 'synthesis', completed_chunks: plan.length, sections: structuredClone(fullSections), story: fullStory(),
    quality: { status: 'issues', input_hash: 'initial-review', findings: [
      { kind: 'omission', explanation: '遗漏伙伴身份。', unit_ids: [0] },
      { kind: 'causality', explanation: '遗漏终场重逢因果。', unit_ids: [1] },
    ] } })
  saved.quality_repair = { review_hash: saved.quality!.input_hash,
    findings_hash: createHash('sha256').update(JSON.stringify(saved.quality!.findings)).digest('hex'),
    current_hash: sourceQualityInputHash(saved), completed_findings: 1 }
  assert.equal(sourceAnalysisResume(saved).available, true)
  assert.match(sourceAnalysisResume(saved).message, /已修补 1\/2 项问题/)
  saved.quality_repair!.completed_findings = 2
  assert.match(sourceAnalysisResume(saved).message, /问题修补结果已保存/)
  assert.match(sourceAnalysisResume(saved).message, /全文独立质量核对/)
  saved.quality_repair.current_hash = 'damaged-analysis-fingerprint'
  assert.doesNotMatch(sourceAnalysisResume(saved).message, /已修补|问题修补结果已保存/)
  assert.match(sourceAnalysisResume(saved).message, /修补未完成的问题/)
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
    assert.equal(saved.quality, undefined)
    assert.deepEqual(saved.work, plan)
  }
})
