import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { currentInitialSourceRepairRequest, currentDerivedSourceRepairCorrectionRequest, currentFrozenSourceCorrectionRead } from '../src/modules/script/source-repair-request-identity.js'
import { currentInitialSourceQualityRequest, currentDerivedSourceCorrectionRequest } from '../src/modules/script/source-story-dispatch-identity.js'
import { createSourceStoryDispatchGrant, sourceRepairDispatchAuthorized, sourceRepairCorrectionDispatchAuthorized, sourceQualityDispatchAuthorized, sourceQualityCorrectionDispatchAuthorized, bindSourceQualityFindingsDispatchGrant } from '../src/modules/script/script-source-ordinary-dispatch.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const signal = () => new AbortController().signal
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const retained = (state: ScriptSourceAnalysis) => JSON.stringify({ decision: 'retain_analysis', finding_hash: hash(JSON.stringify(state.quality!.findings[Math.min(state.quality_repair?.completed_findings || 0, state.quality!.findings.length - 1)])), reason: '当前分析已准确保留原文明示的事实，无需改动。', changes: [], analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: 0 }] })
function fixture(findings = 2) {
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: 'project', filename: 'source.txt', content: '林舟守约。\n沈月归还信物。', updated_at: 'source-stamp' }
  const state: ScriptSourceAnalysis = { id: 'ordinary-initial', source_version: 'source', model_id: 'model', configuration_hash: 'configuration',
    status: 'queued', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'stamp',
    sections: [{ offset: 0, length: document.content.length, title: '约定', episode_number: 1, summary: '林舟守约，沈月归还信物。', characters: [], events: [] }],
    story: { summary: '林舟守约，沈月归还信物。', characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: '信物归还。', section_ids: [0] } },
    story_response_run_ids: ['protected-old-scope'] }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: Array.from({ length: findings }, (_, index) => ({ kind: 'omission', explanation: `待核对意见${index}`, unit_ids: [0] })) }
  const context = { document, state, configuration_hash: 'configuration', local_active: true, current_run_unknown: false }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
  state.status = 'running'
  return { document, state, context }
}

test('an explicit quality workflow advances only validated findings and grants one exact independent post-repair review', async () => {
  const { document, state, context } = fixture(), original = structuredClone(state)
  let repairs = 0, reviews = 0
  await repairSourceQuality(document, state, async () => {
    const proof = currentInitialSourceRepairRequest()!
    assert.ok(proof); assert.equal(proof.binding.finding_index, repairs++)
    assert.equal(state.quality_repair_output!.checkpoint.initial_started!.input_hash, state.quality_repair_output!.checkpoint.input_hash)
    assert.equal(sourceRepairDispatchAuthorized(context, proof), true)
    const before = state.ordinary_story_dispatch!.quality_workflow!.finding_index
    state.quality_repair!.completed_findings++
    assert.equal(sourceRepairDispatchAuthorized(context, proof), false, 'an edited counter cannot move the grant')
    state.quality_repair!.completed_findings--
    assert.equal(state.ordinary_story_dispatch!.quality_workflow!.finding_index, before)
    assert.equal(sourceRepairDispatchAuthorized({ ...context, current_run_unknown: true }, proof), false)
    return retained(state)
  }, () => {}, signal())
  assert.equal(repairs, 2); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.phase, 'review')
  assert.equal(state.quality_repair_outputs!.length, 2)
  assert.ok(state.quality_repair_outputs!.every(item => item.checkpoint.raw && item.checkpoint.original_raw))
  assert.equal(state.quality_repair_output, undefined)
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
  assert.deepEqual(state.story_response_run_ids, original.story_response_run_ids)
  await reviewSourceQuality(document, state, async () => {
    reviews++
    const proof = currentInitialSourceQualityRequest()!
    assert.ok(proof)
    assert.notEqual(proof.candidate_hash, original.quality!.input_hash, 'withdrawal evidence changes the exact review identity')
    assert.equal(sourceQualityDispatchAuthorized(context, proof), true)
    assert.ok(state.quality_work!.output_checkpoint!.initial_started)
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }, () => {}, signal())
  assert.equal(reviews, 1); assert.equal(state.quality!.status, 'passed')
  assert.equal(state.quality_repair, undefined)
})

test('a saved repair initial can inherit only its frozen unused correction, never another initial', async () => {
  const { document, state, context } = fixture(1), initialRun = state.id
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async () => {
    calls++
    if (calls === 1) {
      assert.equal(sourceRepairDispatchAuthorized(context, currentInitialSourceRepairRequest()!), true)
      return 'not JSON'
    }
    const proof = currentDerivedSourceRepairCorrectionRequest()!
    assert.ok(proof); assert.equal(sourceRepairCorrectionDispatchAuthorized(context, proof, initialRun), true)
    throw Object.assign(new TextProviderError('known not sent', false), { delivery: 'not_sent' as const })
  }, () => {}, signal()), /known not sent/)
  assert.equal(calls, 2)
  const saved = structuredClone(state.quality_repair_output!), previous = state.ordinary_story_dispatch
  assert.equal(saved.checkpoint.correction_started, undefined); assert.ok(saved.checkpoint.correction_request)
  state.id = 'explicit-resume'; state.status = 'queued'
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous); state.status = 'running'
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.repair_correction!.initial_run_id, initialRun)
  await repairSourceQuality(document, state, async () => {
    calls++
    assert.equal(currentInitialSourceRepairRequest(), undefined)
    const proof = currentDerivedSourceRepairCorrectionRequest()!
    assert.ok(proof); assert.equal(sourceRepairCorrectionDispatchAuthorized(context, proof, initialRun), true)
    assert.equal(sourceRepairCorrectionDispatchAuthorized(context, proof, state.id), false)
    return retained(state)
  }, () => {}, signal())
  assert.equal(calls, 3); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.quality_repair_outputs![0]!.checkpoint.original_raw, saved.checkpoint.original_raw)
  assert.ok(state.quality_repair_outputs![0]!.checkpoint.correction)
})

test('an unknown repair initial survives explicit continuation and is never re-sent', async () => {
  const { document, state, context } = fixture(1)
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async () => { calls++; throw new Error('unknown disconnect') }, () => {}, signal()), /unknown disconnect/)
  const saved = structuredClone(state.quality_repair_output), previous = state.ordinary_story_dispatch
  assert.ok(saved!.checkpoint.initial_started)
  state.id = 'resume-unknown'; state.status = 'queued'
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous); state.status = 'running'
  await assert.rejects(repairSourceQuality(document, state, async () => { calls++; throw new Error('must not dispatch') }, () => {}, signal()), /上次初始请求已开始/)
  assert.equal(calls, 1); assert.deepEqual(state.quality_repair_output, saved)
})

test('exact completed repair lookup wins before provider dispatch and retains the response in its own journal', async () => {
  const { document, state } = fixture(1)
  let reads = 0, calls = 0
  const generator: StructuredGenerator = async () => { calls++; throw new Error('must not dispatch') }
  generator.readCompleted = async (_text, contract) => { reads++; assert.equal(contract!.name, 'script_source_quality_repair'); return retained(state) }
  await repairSourceQuality(document, state, generator, () => {}, signal())
  assert.equal(reads, 1); assert.equal(calls, 0); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.quality_repair_outputs![0]!.checkpoint.original_raw, retained(state))
})

test('a late exact ledger completion can satisfy an unknown repair marker locally without promoting or re-sending it', async () => {
  const { document, state, context } = fixture(1)
  let calls = 0, reads = 0
  await assert.rejects(repairSourceQuality(document, state, async () => { calls++; throw new Error('unknown initial') }, () => {}, signal()), /unknown initial/)
  assert.ok(state.quality_repair_output!.checkpoint.initial_started)
  const previous = state.ordinary_story_dispatch
  state.id = 'resume-late-completion'; state.status = 'queued'; state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous); state.status = 'running'
  const savedOnly: StructuredGenerator = async () => { calls++; throw new Error('must not dispatch') }
  savedOnly.readCompleted = async () => { reads++; return retained(state) }
  await repairSourceQuality(document, state, savedOnly, () => {}, signal())
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.quality_repair_outputs![0]!.checkpoint.initial_started, undefined)
  assert.equal(state.quality_repair_outputs![0]!.checkpoint.original_raw, retained(state))
})

test('new grants do not convert saved, unknown, spent or mismatched repair proposals into an initial allowance', async t => {
  for (const kind of ['raw', 'unknown', 'correction', 'mismatch'] as const) await t.test(kind, async () => {
    const { document, state, context } = fixture(1)
    let proof: NonNullable<ReturnType<typeof currentInitialSourceRepairRequest>> | undefined
    await assert.rejects(repairSourceQuality(document, state, async () => {
      proof = currentInitialSourceRepairRequest(); throw Object.assign(new Error('stop before send'), { delivery: 'not_sent' })
    }, () => {}, signal()), /stop before send/)
    const cp = state.quality_repair_output!.checkpoint
    if (kind === 'raw') cp.raw = cp.original_raw = retained(state)
    if (kind === 'unknown') cp.initial_started = { input_hash: cp.input_hash! }
    if (kind === 'correction') cp.correction = { input_hash: hash('used'), raw: retained(state) }
    if (kind === 'mismatch') state.quality_repair_output!.binding = 'another baseline'
    state.id = 'resume'; state.status = 'queued'; state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context); state.status = 'running'
    assert.equal(sourceRepairDispatchAuthorized(context, proof!), false)
  })
})

test('validated patches transfer to the next exact baseline and an unknown post-repair audit cannot be re-purchased', async () => {
  const { document, state, context } = fixture(2), oldHash = sourceQualityInputHash(state), oldProofs: Array<NonNullable<ReturnType<typeof currentInitialSourceRepairRequest>>> = []
  let repairs = 0, audits = 0
  await repairSourceQuality(document, state, async () => {
    const proof = currentInitialSourceRepairRequest()!
    assert.equal(sourceRepairDispatchAuthorized(context, proof), true)
    for (const old of oldProofs) assert.equal(sourceRepairDispatchAuthorized(context, old), false)
    oldProofs.push(structuredClone(proof)); repairs++
    return JSON.stringify({ status: 'patched', reason: '仅纠正本项意见涉及的原文字段。', changes: repairs === 1
      ? [{ target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: state.story!.summary, value: '林舟守约。沈月归还信物。' }]
      : [{ target: 'story.ending', section_id: null, operation: 'replace', index: null, expected: state.story!.ending, value: { summary: '沈月归还信物。', section_ids: [0] } }] })
  }, () => {}, signal())
  assert.equal(repairs, 2); assert.notEqual(sourceQualityInputHash(state), oldHash)
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.current_hash, sourceQualityInputHash(state))
  await assert.rejects(reviewSourceQuality(document, state, async () => {
    audits++
    assert.equal(sourceQualityDispatchAuthorized(context, currentInitialSourceQualityRequest()!), true)
    throw new Error('audit disconnected after acceptance')
  }, () => {}, signal()), /audit disconnected/)
  assert.ok(state.quality_work!.output_checkpoint!.initial_started)
  const saved = structuredClone(state.quality_work), previous = state.ordinary_story_dispatch
  state.id = 'explicit-audit-resume'; state.status = 'queued'; state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous); state.status = 'running'
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.protected_review, true)
  await assert.rejects(reviewSourceQuality(document, state, async () => { audits++; throw new Error('must not dispatch') }, () => {}, signal()), /上次初始请求已开始/)
  assert.equal(audits, 1); assert.deepEqual(state.quality_work, saved)
})

test('one granted first review may materialize its findings, while post-repair findings never receive an automatic new repair allowance', async () => {
  const { document, state, context } = fixture(1)
  delete state.quality; delete state.quality_repair; state.status = 'queued'
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context); state.status = 'running'
  const finding = { kind: 'omission', explanation: '待核对的真实意见', unit_ids: [0] }
  await assert.rejects(reviewSourceQuality(document, state, async () => {
    assert.equal(sourceQualityDispatchAuthorized(context, currentInitialSourceQualityRequest()!), true)
    return JSON.stringify({ checked_section_ids: [0], findings: [finding] })
  }, () => {}, signal()), /核对发现 1 项/)
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.phase, 'repair')
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.finding_index, 0)
  await repairSourceQuality(document, state, async () => {
    assert.equal(sourceRepairDispatchAuthorized(context, currentInitialSourceRepairRequest()!), true)
    return retained(state)
  }, () => {}, signal())
  const completedWorkflow = structuredClone(state.ordinary_story_dispatch!.quality_workflow)
  await assert.rejects(reviewSourceQuality(document, state, async () => JSON.stringify({ checked_section_ids: [0], findings: [finding] }), () => {}, signal()), /分析内容未变化/)
  assert.deepEqual(state.ordinary_story_dispatch!.quality_workflow, { ...completedWorkflow,
    review_input_hash: state.ordinary_story_dispatch!.quality_input_hash, protected_review: false })
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.phase, 'review', 'a new full review cannot mint an endless repair loop')
})

test('the exact unused post-repair review correction survives an explicit resume without reopening its initial audit', async () => {
  const { document, state, context } = fixture(1), initialRun = state.id
  await repairSourceQuality(document, state, async () => retained(state), () => {}, signal())
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, state, async () => {
    if (++calls === 1) return 'invalid JSON'
    const proof = currentDerivedSourceCorrectionRequest()!
    assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, initialRun), true)
    throw Object.assign(new TextProviderError('review correction not sent', false), { delivery: 'not_sent' as const })
  }, () => {}, signal()), /review correction not sent/)
  const previous = state.ordinary_story_dispatch
  state.id = 'audit-correction-resume'; state.status = 'queued'; state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous); state.status = 'running'
  assert.equal(state.ordinary_story_dispatch!.quality_workflow!.protected_review, true)
  assert.equal(state.ordinary_story_dispatch!.correction_tasks![0]!.initial_run_id, initialRun)
  await reviewSourceQuality(document, state, async () => {
    calls++
    assert.equal(currentInitialSourceQualityRequest(), undefined)
    assert.equal(sourceQualityCorrectionDispatchAuthorized(context, currentDerivedSourceCorrectionRequest()!, initialRun), true)
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }, () => {}, signal())
  assert.equal(calls, 3); assert.equal(state.quality!.status, 'passed')
})

test('quality audit initial and correction checkpoint loss both recover the exact completed frozen correction without another provider call', async () => {
  const { document, state, context } = fixture(1), initialRun = state.id
  await repairSourceQuality(document, state, async () => retained(state), () => {}, signal())
  let lostInitial: ScriptSourceAnalysis | undefined, lostCorrection: ScriptSourceAnalysis | undefined
  const invalid = 'complete invalid audit JSON', complete = JSON.stringify({ checked_section_ids: [0], findings: [] })
  await reviewSourceQuality(document, state, async () => {
    if (currentInitialSourceQualityRequest()) { lostInitial = structuredClone(state); return invalid }
    lostCorrection = structuredClone(state)
    assert.ok(currentDerivedSourceCorrectionRequest())
    return complete
  }, () => {}, signal())
  assert.ok(lostInitial!.quality_work!.output_checkpoint!.initial_started)
  assert.equal(lostInitial!.quality_work!.output_checkpoint!.raw, undefined)
  assert.ok(lostCorrection!.quality_work!.output_checkpoint!.correction_started)
  assert.equal(lostCorrection!.quality_work!.output_checkpoint!.correction, undefined)
  for (const lost of [lostInitial!, lostCorrection!]) {
    let calls = 0, frozenReads = 0
    lost.id = 'audit-checkpoint-recovery'; lost.status = 'queued'
    lost.ordinary_story_dispatch = createSourceStoryDispatchGrant({ ...context, state: lost }, lost.ordinary_story_dispatch)
    lost.status = 'running'
    assert.equal(lost.ordinary_story_dispatch!.quality_initial_run_id, initialRun)
    assert.equal(lost.ordinary_story_dispatch!.quality_workflow!.protected_review, true)
    const localOnly: StructuredGenerator = async () => { calls++; throw new Error('must not dispatch another audit') }
    localOnly.readCompleted = async () => {
      const proof = currentFrozenSourceCorrectionRead()
      if (!proof) return invalid
      frozenReads++
      assert.equal(proof.kind, 'quality'); assert.equal(proof.initial_run_id, initialRun)
      assert.equal(proof.initial_response_hash, hash(invalid))
      return complete
    }
    const checkpoints: ScriptSourceAnalysis[] = []
    await reviewSourceQuality(document, lost, localOnly, () => { checkpoints.push(structuredClone(lost)) }, signal())
    assert.equal(calls, 0); assert.equal(frozenReads, 1)
    assert.equal(lost.quality!.status, 'passed')
    assert.ok(checkpoints.some(snapshot => snapshot.quality_work?.output_checkpoint?.correction?.raw === complete &&
      snapshot.quality_work.output_checkpoint.correction_started), 'the spent correction marker remains alongside locally restored bytes')
  }
})

test('materializing a private creator-feedback review proof preserves the ordinary grant while actual feedback edits invalidate it', async () => {
  const { document, state, context } = fixture(1)
  state.review_feedback = { id: 'feedback', text: '请依据原文核对当前摘要。', source_version: state.source_version,
    source_updated_at: document.updated_at, model_id: state.model_id, configuration_hash: state.configuration_hash! }
  state.quality!.input_hash = sourceQualityInputHash(state)
  const review = state.quality!
  delete state.quality
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
  // This is code-owned derived output, just like saveSourceFeedbackReviewProof;
  // it is neither a new instruction nor part of its own input identity.
  Object.assign(state.review_feedback, { review_proof: { policy: 'source-feedback-review-v2', request_id: 'feedback', items_hash: 'derived',
    input_hash: review.input_hash, checks_hash: 'derived', checks: [] } })
  state.quality = review
  bindSourceQualityFindingsDispatchGrant(document, state, review.input_hash)
  await repairSourceQuality(document, state, async () => {
    const proof = currentInitialSourceRepairRequest()!
    assert.equal(sourceRepairDispatchAuthorized(context, proof), true)
    state.review_feedback!.text += '新的反馈内容'
    assert.equal(sourceRepairDispatchAuthorized(context, proof), false)
    state.review_feedback!.text = state.review_feedback!.text.replace('新的反馈内容', '')
    return retained(state)
  }, () => {}, signal())
  assert.equal(sourceQualityRepairProgress(state), 1)
})
