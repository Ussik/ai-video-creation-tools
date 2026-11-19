import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
const schema = z.object({ motion_prompt: z.string().min(1), audio_plan: z.object({ speech: z.array(z.string()) }).strict() }).strict()
const answer = { motion_prompt: '转身后停步', audio_plan: { speech: ['保留原对白。'] } }
test('opt-in root projection accepts complete fenced output and retains original/audit with zero correction', async () => {
  let count = 0; const checkpoint: StructuredOutputCheckpoint = {}, raw = '```json\n' + JSON.stringify({ ...answer, title: '标题' }) + '\n```'
  const value = await generateStructuredOutput('handoff_fixture', schema, async () => { count++; return raw }, 'task', { projectExtraFields: ['title'], checkpoint, persistCheckpoint() {} })
  assert.deepEqual(value, answer); assert.equal(count, 1)
  assert.equal(checkpoint.original_raw, raw); assert.ok(checkpoint.structural_repair?.candidate_hash)
  assert.ok(checkpoint.structural_repair?.changes.some(change => change.field_path.includes('title')))
  const replay = await generateStructuredOutput('handoff_fixture', schema, async () => assert.fail('no paid replay'), 'task', { projectExtraFields: ['title'], checkpoint })
  assert.deepEqual(replay, answer)
})
test('projection never accepts missing targets, competing motion or nested extra fields', async () => {
  for (const raw of [ { audio_plan: answer.audio_plan, title: 'extra' }, { ...answer, video_prompt: '冲突动作' }, { ...answer, audio_plan: { ...answer.audio_plan, unknown: true }, title: 'extra' } ]) {
    await assert.rejects(generateStructuredOutput('handoff_fixture', schema, async () => JSON.stringify(raw), 'task', { projectExtraFields: ['title', 'video_prompt'], maxAttempts: 1 }), /契约/)
  }
})
test('format correction excludes giant original task with durable checkpoints and semantic correction carries only explicit relevant evidence', async () => {
  for (const semantic of [false, true]) {
    let count = 0; const checkpoint: StructuredOutputCheckpoint = {}, prompts: string[] = []
    const value = await generateStructuredOutput('handoff_fixture', schema, async prompt => { prompts.push(prompt); return JSON.stringify(++count === 1 ? semantic ? { ...answer, motion_prompt: '错误' } : { ...answer, unknown: true } : answer) },
      'UNRELATED_LARGE_SOURCE'.repeat(10000), { checkpoint, persistCheckpoint() {}, correctionContext: 'response_only', minimalCorrectionContext: true,
        businessCorrectionContext: () => JSON.stringify({ relevant: '原作要求转身后停步' }), validate: value => { if (value.motion_prompt === '错误') throw Object.assign(new Error('动作不符'), { statusCode: 422 }) } })
    assert.deepEqual(value, answer); assert.equal(count, 2)
    assert.ok(!prompts[1]!.includes('UNRELATED_LARGE_SOURCE')); assert.ok(prompts[1]!.includes('保留原对白'))
    if (semantic) assert.ok(prompts[1]!.includes('原作要求转身后停步'))
    assert.ok(prompts[1]!.length < prompts[0]!.length / 10)
  }
})

test('a projection audit storage failure stops before another correction or model request', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}; let count = 0
  await assert.rejects(generateStructuredOutput('handoff_fixture', schema, async () => { count++; return JSON.stringify({ ...answer, title: 'metadata' }) }, 'task',
    { checkpoint, projectExtraFields: ['title'], persistCheckpoint() { if (checkpoint.structural_repair) throw new Error('isolated storage fault') } }), error => {
      assert.equal((error as any).statusCode, 500); return true
    })
  assert.equal(count, 1)
})
