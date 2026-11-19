import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestVisualRetry, visualRetryToken } from '../src/modules/visuals/visual-profile-retry.js'

const stepId = 'unit:fixture:prop'
const firstToken = 'a'.repeat(64)
const response = { input_hash: 'b'.repeat(64), raw: '{"definition":"retained"}' }
function history() {
  const slot = 'response:retry:' + stepId + ':' + firstToken + ':binding'
  return { steps: { [slot]: { value: structuredClone(response) },
    ['retry-failed:' + stepId + ':' + firstToken]: { value: { code: 'model_field_contract', delivery: 'completed' } } } }
}
test('settled retry history is bound to every response and cannot advance past missing or reordered receipts', () => {
  const checkpoint = history(), first = latestVisualRetry(checkpoint, stepId)!
  assert.equal(first.recovery.action, 'retry')
  const secondSlot = 'response:retry:' + stepId + ':' + first.token + ':binding'
  checkpoint.steps[secondSlot] = { value: structuredClone(response) }
  assert.equal(latestVisualRetry(checkpoint, stepId)!.recovery.action, 'inspect', 'unmarked newer response cannot authorize dispatch')
  checkpoint.steps['retry-failed:' + stepId + ':' + first.token] = { value: { code: 'model_field_contract', delivery: 'completed' } }
  const next = latestVisualRetry(checkpoint, stepId)!
  assert.equal(next.attempt, 3); assert.equal(next.recovery.action, 'retry')
  assert.equal(next.token, visualRetryToken(stepId, secondSlot, response, 3))
  const reordered = { steps: Object.fromEntries(Object.entries(checkpoint.steps).reverse()) }
  assert.equal(latestVisualRetry(reordered, stepId), undefined)
  delete checkpoint.steps[Object.keys(checkpoint.steps)[0]!]
  assert.equal(latestVisualRetry(checkpoint, stepId), undefined)
})
test('unknown or ambiguous saved attempts cannot provide a next-token', () => {
  for (const value of [
    { ...response, correction_started: { input_hash: 'c'.repeat(64) } },
    { ...response, initial_started: { input_hash: 'c'.repeat(64) } },
  ]) {
    const checkpoint = history()
    checkpoint.steps[Object.keys(checkpoint.steps)[0]!] = { value } as any
    assert.equal(latestVisualRetry(checkpoint, stepId), undefined)
  }
  const checkpoint = history()
  checkpoint.steps['response:retry:' + stepId + ':' + firstToken + ':other-binding'] = { value: structuredClone(response) }
  assert.equal(latestVisualRetry(checkpoint, stepId), undefined)
})
