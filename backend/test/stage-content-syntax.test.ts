import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'
import { recoverStageContentSyntax } from '../src/modules/generation/stage-content-syntax.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'

const raw = '```json\n{"artifacts":[{"artifact_type":"outline","title":"标题","content":"他说"不要改写，正文"。\\n然后回答"保留！""}],"scenes":[]}'
test('single-line stage content recovers without a model correction and persists an inverse-verifiable audit', async () => {
  const recovered = recoverStageContentSyntax(raw)!
  assert.ok(recovered)
  assert.equal((recovered.value as any).artifacts[0].content, '他说"不要改写，正文"。\n然后回答"保留！"')
  let inverse = recovered.repairedRaw
  for (let i = recovered.audit.escape_offsets.length - 1; i >= 0; i--) {
    const at = recovered.audit.escape_offsets[i]! + i
    assert.equal(inverse.slice(at, at + 2), '\\"')
    inverse = inverse.slice(0, at) + inverse.slice(at + 1)
  }
  assert.equal(inverse, raw)
  const schema = z.object({ artifacts: z.array(z.object({ artifact_type: z.literal('outline'), title: z.string(), content: z.string() }).strict()), scenes: z.array(z.never()) }).strict()
  let calls = 0
  const steps = createGenerationSteps()
  const result = await steps.run('draft', '正文', {}, () => generateStructuredOutput('workflow_draft', schema, async () => { calls++; return raw }, 'task', {
    recoverUniqueSyntax: true, recoverContentSyntax: true,
  }), value => schema.parse(value))
  assert.deepEqual(result, recovered.value)
  assert.equal(calls, 1)
  const entry = Object.entries(steps.checkpoint.steps).find(([key]) => key.startsWith('response:'))![1].value as any
  assert.equal(entry.original_raw, raw)
  assert.deepEqual(entry.syntax_repair, recovered.audit)
})

test('content syntax recovery rejects non-content edits, duplicate keys, missing delimiters and ambiguous embedded properties', () => {
  for (const raw of [
    '{"content":"他说"你好"。"',
    '{"title":"他说"你好"。","content":"完整"}',
    '{"content":"他说"你好"。","content":"第二个"}',
    '{"content":"他说"你好"。" "scenes":[]}',
    '{"content":"正文"伪字段":1"}',
    '{"content":"完整"}',
  ]) assert.equal(recoverStageContentSyntax(raw), undefined, raw)
})


test('stage entry accepts the restored content with one initial response and no prose rewrite', async () => {
  let calls = 0
  const request = workflowRequest.parse({ stage: 'outline', intent: 'stage_design', artifact_types: ['outline'] })
  const draft = await generateStageDraftWithContinuation(request, '编写概要', async () => { calls++; return raw }, { steps: createGenerationSteps() })
  assert.equal(calls, 1)
  assert.equal(draft.artifacts[0]!.content, (recoverStageContentSyntax(raw)!.value as any).artifacts[0].content)
})
