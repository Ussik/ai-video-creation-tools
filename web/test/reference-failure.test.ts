import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { referenceDisplayName, referenceFailureView, type ReferenceFailure } from '../src/features/storyboard/reference-failure'

const failure: ReferenceFailure = { unit_key: 'PROP-FRIED-NOODLE', name: '炒面', variant: '默认', code: 'visual_profile_pending', message: 'private',
  retryable: false, recovery_type: 'none', checkpoint_source: 'none', is_new_model_call: false, attempt: 0 }

test('reference names hide redundant defaults and failure summaries stay short without guessing a cause', () => {
  assert.equal(referenceDisplayName({ name: '炒面', variant: '默认' }), '炒面')
  assert.equal(referenceDisplayName({ name: '炒面', variant: '默认' }, [{ name: '炒面', variant: '夜晚' }]), '炒面 · 默认')
  assert.equal(referenceDisplayName({ name: '炒面', variant: '夜晚' }), '炒面 · 夜晚')
  assert.equal(referenceFailureView({ ...failure, code: 'unrecognized_provider_code', message: 'anything' }).summary, '生成结果不符合要求')
})

test('prospective recovery maps statuses and costs independently of previous provider calls', () => {
  const pending = referenceFailureView(failure)
  assert.equal(pending.status, '待处理')
  assert.match(pending.modelCall, /可能.*新的模型调用/)
  const local = referenceFailureView({ ...failure, recovery: { action: 'continue', model_call: 'none' }, is_new_model_call: true })
  assert.equal(local.status, '可本地恢复')
  assert.match(local.modelCall, /不发起新的模型调用/)
  const retry = referenceFailureView({ ...failure, code: 'visual_profile_locked_field_changed', recovery: { action: 'retry', model_call: 'required', token: 'a'.repeat(64) } })
  assert.equal(retry.status, '需要重试')
  assert.equal(retry.canContinue, false)
  assert.ok(retry.retry)
  assert.match(retry.modelCall, /产生费用/)
  const unknown = referenceFailureView({ ...failure, code: 'structured_initial_delivery_pending', recovery: { action: 'continue', model_call: 'none' } })
  assert.equal(unknown.status, '结果待确认')
  assert.equal(unknown.canContinue, false)
  assert.equal(unknown.retry, undefined)
  const wordsAreNotCodes = referenceFailureView({ ...failure, message: 'request validation on completed response' })
  assert.equal(wordsAreNotCodes.status, '待处理', 'classify explicit codes, not words in diagnostic prose')
})

test('reference lists and production footers keep bounded scrolling and deliberate responsive stacking', async () => {
  const list = await readFile(new URL('../src/features/storyboard/reference-failure.css', import.meta.url), 'utf8')
  const production = await readFile(new URL('../src/features/storyboard/storyboard-production.css', import.meta.url), 'utf8')
  const planner = await readFile(new URL('../src/features/storyboard/storyboard-planner.css', import.meta.url), 'utf8')
  assert.match(list, /max-height:\s*min\(300px,\s*34dvh\)/)
  assert.match(list, /overflow-y:\s*auto/)
  assert.match(list, /overscroll-behavior:\s*contain/)
  assert.match(production, /storyboard-production-actions\s*\{[^}]*flex:\s*none/)
  assert.match(production, /max-width:\s*600px/)
  assert.match(production, /storyboard-production-content\s*\{[^}]*min-height:\s*0/)
  assert.match(planner, /storyboard-planner-reference-actions\s*\{[^}]*flex-wrap:\s*nowrap/)
})


test('coverage distinguishes a proven local migration from a real model limit', () => {
  const local = referenceFailureView({ ...failure, stage: 'coverage', attempt: 1, model_request_count: 1, local_validation_count: 4,
    recovery: { action: 'continue', model_call: 'none' } })
  assert.equal(local.status, '可本地恢复'); assert.match(local.modelCall, /不发起新的模型调用/)
  const limited = referenceFailureView({ ...failure, stage: 'coverage', attempt: 4, model_request_count: 4, local_validation_count: 8,
    recovery: { action: 'none', model_call: 'none', reason: '本镜头已发生 4/4 次实际模型请求，达到上限' } })
  assert.equal(limited.status, '达到上限'); assert.equal(limited.retry, undefined)
})
