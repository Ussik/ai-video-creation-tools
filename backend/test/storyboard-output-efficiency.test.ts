import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, nativeOutputContractPrompt } from '../src/modules/generation/model-output.js'
import { withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import { safeModelResult } from '../src/infrastructure/observability/model-results.js'

const schema = z.object({ shots: z.array(z.object({ image_prompt: z.string(), video_prompt: z.string() }).strict()) }).strict()
test('local contract correction sends the full candidate without unrelated original context', async () => {
  const marker = 'UNRELATED_PROJECT_SOURCE_'
  const candidate = { shots: [{ image_prompt: '首帧'.repeat(8000) }] }
  const prompts: string[] = [], events: any[] = []
  await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => events.push(event) }, () =>
    generateStructuredOutput('storyboard_shot_batch', schema, async (prompt, contract) => {
      prompts.push(nativeOutputContractPrompt(prompt, contract))
      return JSON.stringify(prompts.length === 1 ? candidate : { shots: [{ ...candidate.shots[0], video_prompt: '动作' }] })
    }, marker.repeat(4000), { correctionContext: 'response_only' }))
  assert.equal(prompts.length, 2)
  assert.ok(!prompts[1]!.includes(marker))
  assert.ok(prompts[1]!.includes(candidate.shots[0]!.image_prompt), 'never truncate the candidate for local correction')
  assert.ok(Buffer.byteLength(prompts[1]!) < Buffer.byteLength(prompts[0]!))
  assert.ok(events.some(event => event.field_paths?.includes('$.shots[0].video_prompt')))
  assert.ok(events.some(event => event.schema_issue_codes?.includes('invalid_type')))
  assert.equal(events.at(-1).first_pass_status, 'invalid_contract')
  assert.equal(events.at(-1).status, 'valid')
})
test('diagnostic paths preserve root syntax without exporting unknown user object keys', async () => {
  const events: any[] = []
  const closed = z.object({ slots: z.record(z.string(), z.object({ value: z.number() })) }).strict()
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => events.push(event) }, () =>
    generateStructuredOutput('storyboard_shot_batch', closed, async () => JSON.stringify({ slots: { private_story_title: { value: 'bad' } } }), '', { maxAttempts: 1 })))
  assert.ok(!JSON.stringify(events).includes('private_story_title'))
  assert.deepEqual(safeModelResult({ phase: 'structure', status: 'invalid_contract', field_paths: ['$.shots[0].video_prompt', 'raw secret'] })?.field_paths, ['$.shots[0].video_prompt'])
})


test('malformed local response is corrected as syntax without the project prompt or truncated response', async () => {
  const marker = 'NO_REPLAY_PROJECT', original = '{"shots":[{"image_prompt":' + JSON.stringify('原文'.repeat(9000)) + ',"video_prompt":"动作"}'
  let calls = 0
  const value = await generateStructuredOutput('storyboard_shot_batch', schema, async prompt => {
    calls++
    if (calls === 1) return original
    assert.match(prompt, /一次 JSON 语法修正/)
    assert.ok(!prompt.includes(marker))
    assert.ok(prompt.includes('原文'.repeat(9000)))
    return original + ']}'
  }, marker, { correctionContext: 'response_only' })
  assert.equal(calls, 2); assert.equal(value.shots[0]!.video_prompt, '动作')
})
