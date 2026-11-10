import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

test('explicit long-output work begins with complete semantic blocks while a small request stays atomic', async () => {
  const request = workflowRequest.parse({ stage: 'outline', intent: 'source_outline', artifact_types: ['outline'] })
  const atomic: string[] = [], units: string[] = []
  const short = await generateStageDraftWithContinuation(request, '短原稿', async (_prompt, contract) => {
    atomic.push(contract!.name); return JSON.stringify({ artifacts: [{ artifact_type: 'outline', title: '大纲', content: '完整因果和结局。' }], scenes: [] })
  })
  const split = await generateStageDraftWithContinuation(request, '长创作任务', async (_prompt, contract) => {
    units.push(contract!.name); return JSON.stringify({ blocks: [{ id: 'outline:ending', title: '大纲', content: '完整因果和结局。', scenes: [] }], complete: true })
  }, { preferSemanticUnits: true })
  assert.deepEqual(atomic, ['workflow_draft']); assert.deepEqual(units, ['script_stage_blocks'])
  assert.deepEqual(split, short)
})


test('long episode context selects semantic scenes on the first call without a whole-output failure', async () => {
  const request = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  const calls: string[] = []
  const scene = { heading: '终场', location: '院子', time_of_day: '日', characters: '林舟', action: '归还钥匙', dialogue: '物归原主。', narration: '', duration: 10 }
  const result = await generateStageDraftWithContinuation(request, '完整原稿与约束。'.repeat(2500), async (_prompt, contract) => {
    calls.push(contract!.name)
    return JSON.stringify({ blocks: [{ id: 'scene:1', title: '第1集', content: '林舟归还钥匙，众人回家。', scenes: [scene] }], complete: true })
  })
  assert.deepEqual(calls, ['script_stage_blocks'])
  assert.equal(result.scenes.length, 1)
  assert.equal(result.artifacts[0]!.content, '林舟归还钥匙，众人回家。')
})
