import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'

const document = { filename: 'source.txt', content: '林舟守约。沈月归还信物。' }
const signal = () => new AbortController().signal
const passed = JSON.stringify({ checked_section_ids: [0], findings: [] })
function fixture(bounded: boolean): ScriptSourceAnalysis {
  return { id: 'run', source_version: 'source', model_id: 'model', status: 'running', completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now',
    sections: [{ offset: 0, length: document.content.length, title: '约定', episode_number: 1, summary: document.content, characters: [], events: [] }],
    story: { summary: document.content, characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: '信物归还。', section_ids: [0] } },
    ordinary_story_dispatch: { run_id: 'run', binding: 'private-fixture', protected_task_keys: [], authorized_at: 'now', ...(bounded ? { bounded_quality: true } : {}) } }
}
function scopeError(error: unknown): boolean {
  const issue = error as Error & Record<string, unknown>
  assert.equal(issue.code, 'source_quality_scope_limit'); assert.equal(issue.statusCode, 409)
  assert.equal(issue.failure_stage, 'recovery'); assert.equal(issue.delivery, 'not_sent')
  assert.equal(issue.retryable, false); assert.equal(issue.sourceOutputRecoveryBlocked, true)
  return true
}

test('a bounded quality audit stops on output exhaustion without dispatching a page', async () => {
  const state = fixture(true), names: string[] = []
  await assert.rejects(reviewSourceQuality(document, state, async (_prompt, contract) => {
    names.push(contract!.name)
    throw new TextOutputLimitError('{"checked_section_ids":[0],"findings":[', 'length')
  }, () => {}, signal()), error => {
    scopeError(error); assert.ok((error as Error).cause instanceof TextOutputLimitError); return true
  })
  assert.deepEqual(names, ['script_source_quality'])
  assert.equal(state.quality, undefined)
  assert.equal(state.quality_work!.checkpoint.steps['source-quality:pages'], undefined)
})

test('without the bounded marker output exhaustion retains the existing pagination behavior', async () => {
  const state = fixture(false), names: string[] = []
  await reviewSourceQuality(document, state, async (_prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('', 'length')
    assert.equal(contract!.name, 'script_source_quality_page')
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true })
  }, () => {}, signal())
  assert.deepEqual(names, ['script_source_quality', 'script_source_quality_page'])
  assert.equal(state.quality!.status, 'passed')
})

test('a bounded audit rejects existing current or stale page checkpoints before any generation or mutation', async t => {
  for (const current of [true, false]) await t.test(current ? 'current' : 'stale', async () => {
    const state = fixture(true)
    state.quality_work = { input_hash: current ? sourceQualityInputHash(state) : 'old-review', checkpoint: {
      steps: { 'source-quality:pages': { input_hash: 'saved-page-input', value: { items: [], complete: false, page_size: 8 } } } } }
    const original = structuredClone(state)
    let calls = 0, saves = 0
    await assert.rejects(reviewSourceQuality(document, state, async () => { calls++; throw new Error('must not dispatch') }, () => { saves++ }, signal()), scopeError)
    assert.equal(calls, 0); assert.equal(saves, 0); assert.deepEqual(state, original)
  })
})

test('without the bounded marker an existing page checkpoint can continue on its original page route', async () => {
  const state = fixture(false), names: string[] = []
  state.quality_work = { input_hash: sourceQualityInputHash(state), checkpoint: {
    steps: { 'source-quality:pages': { input_hash: 'previous-pagination-contract', value: { items: [], complete: false, page_size: 8 } } } } }
  await reviewSourceQuality(document, state, async (_prompt, contract) => {
    names.push(contract!.name)
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true })
  }, () => {}, signal())
  assert.deepEqual(names, ['script_source_quality_page']); assert.equal(state.quality!.status, 'passed')
})

test('bounded new findings are saved verbatim before a scope stop and never materialize another repair grant', async () => {
  const state = fixture(true), findings = [{ kind: 'omission', explanation: '需要另外核实的新问题。', unit_ids: [0] }]
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, state, async () => { calls++; return JSON.stringify({ checked_section_ids: [0], findings }) }, () => {}, signal()), error => {
    scopeError(error); assert.equal((error as { sourceQualityIssues?: boolean }).sourceQualityIssues, true); return true
  })
  assert.equal(calls, 1); assert.equal(state.quality!.status, 'issues')
  assert.deepEqual(state.quality!.findings, findings); assert.equal(state.quality!.input_hash, sourceQualityInputHash(state))
  assert.equal(state.ordinary_story_dispatch!.quality_workflow, undefined)
})

test('without the bounded marker new findings retain their existing recoverable issue result', async () => {
  const state = fixture(false), findings = [{ kind: 'omission', explanation: '需按原文继续核实的问题。', unit_ids: [0] }]
  await assert.rejects(reviewSourceQuality(document, state, async () => JSON.stringify({ checked_section_ids: [0], findings }), () => {}, signal()), error => {
    assert.equal((error as { sourceQualityIssues?: boolean }).sourceQualityIssues, true)
    assert.equal((error as { statusCode: number }).statusCode, 422)
    assert.equal((error as { sourceOutputRecoveryBlocked?: boolean }).sourceOutputRecoveryBlocked, undefined)
    return true
  })
  assert.deepEqual(state.quality!.findings, findings)
})

test('a bounded audit still permits its one format correction and succeeds without pagination', async () => {
  const state = fixture(true), names: string[] = [], stages: Array<string | undefined> = []
  await reviewSourceQuality(document, state, async (_prompt, contract, context) => {
    names.push(contract!.name); stages.push(context?.operationStage)
    return names.length === 1 ? 'invalid JSON' : passed
  }, () => {}, signal())
  assert.deepEqual(names, ['script_source_quality', 'script_source_quality'])
  assert.equal(stages[1], 'format_correction'); assert.equal(state.quality!.status, 'passed')
})

test('a bounded audit never refreshes the used correction when both responses remain invalid', async () => {
  const state = fixture(true), names: string[] = []
  const generate = async (_prompt: string, contract?: { name: string }) => { names.push(contract!.name); return 'invalid JSON' }
  await assert.rejects(reviewSourceQuality(document, state, generate, () => {}, signal()))
  assert.equal(names.length, 2); assert.ok(state.quality_work!.output_checkpoint!.correction)
  await assert.rejects(reviewSourceQuality(document, state, generate, () => {}, signal()))
  assert.equal(names.length, 2, 'the saved invalid initial and correction are revalidated locally')
  assert.ok(names.every(name => name === 'script_source_quality'))
})
