import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { outputContract } from '../src/modules/generation/model-output.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { hasRetainedGenerationWork, workflowDocumentContext } from '../src/modules/script/script-workflow-context.js'
import { workflowEnvelope, workflowRequest, workflowStageEnvelope } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'props' })
const prompt = '保留完整剧情。原文中的 type、status 和 artifact_type 是对白，不得改写。'
const result = { artifacts: scriptStageArtifacts.props.map(artifact_type => ({ artifact_type, title: artifact_type, content: `${artifact_type} 的完整设计正文。` })), scenes: [] }
const invalid = { artifacts: result.artifacts.map(({ artifact_type, ...artifact }, index) => index
  ? { ...artifact, type: artifact_type, status: 'ready' }
  : { ...artifact, artifact_type, status: 'ready' }), scenes: [] }

test('saved document context uses the output document shape and preserves exact legacy serialization for recovery', () => {
  const artifact = { artifact_type: 'props' as const, episode_number: 0, title: '旧稿标题', content: prompt, status: 'ready' as const }
  const current = workflowDocumentContext([artifact])
  assert.deepEqual(current.artifacts, [{ artifact_type: 'props', title: artifact.title, content: prompt }])
  assert.deepEqual(current.saved_document_metadata, [{ artifact_index: 0, artifact_type: 'props', episode_number: 0, status: 'ready' }])
  assert.equal(JSON.stringify(workflowDocumentContext([artifact], true)), JSON.stringify({ artifacts: [{
    type: artifact.artifact_type, episode_number: artifact.episode_number, title: artifact.title, content: prompt, status: artifact.status,
  }] }))
  assert.equal(artifact.content, prompt)
})

test('the native stage schema offers only the selected stage types and rejects extra fields and project scenes', () => {
  for (const stage of Object.keys(scriptStageArtifacts) as Array<keyof typeof scriptStageArtifacts>) {
    const contract = outputContract('workflow_draft', workflowStageEnvelope(stage))
    const properties = contract.schema.properties as Record<string, any>
    const artifact = properties.artifacts.items
    assert.deepEqual(artifact.properties.artifact_type.enum, scriptStageArtifacts[stage])
    assert.equal(artifact.additionalProperties, false)
    assert.deepEqual(Object.keys(artifact.properties), ['artifact_type', 'title', 'content'])
    if (stage !== 'episode') assert.equal((properties.scenes.anyOf?.[0] || properties.scenes).maxItems, 0)
  }
  assert.equal(workflowStageEnvelope('props').safeParse(invalid).success, false)
  assert.equal(workflowStageEnvelope('props').safeParse({ artifacts: [{ ...result.artifacts[0], artifact_type: 'characters' }], scenes: [] }).success, false)
  assert.equal(workflowEnvelope.safeParse({ artifacts: [{ ...result.artifacts[0], status: 'ready' }], scenes: [] }).success, false)
})

test('the reported props field mismatch is corrected once against the stage schema without changing source text', async () => {
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    assert.ok(text.includes(prompt))
    if (++calls === 1) {
      assert.equal(contract?.name, 'workflow_draft')
      return JSON.stringify(invalid)
    }
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assert.match(text, /仅修正文档字段格式/)
    assert.match(text, /artifact_type是必填文档类型，不得用type代替/)
    assert.match(text, /artifact:1/)
    assert.match(text, /status/)
    return JSON.stringify({ repairs: result.artifacts.map(({ content: _content, ...artifact }, index) => ({ candidate_id: `artifact:${index}`, ...artifact, removed_fields: index ? ['type', 'status'] : ['status'] })) })
  })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts, result.artifacts)
})

test('an empty legacy failed attempt reuses the bounded task while invalid output never becomes retained prose', async () => {
  const steps = createGenerationSteps()
  const identity = { strategy: 'stage-semantic-stream-v1', request, prompt }
  steps.retain('draft:stream:state', '旧版空检查点', identity, {
    version: 1, round: 2, initialEnded: false, artifacts: [], scenes: [], target: null, mode: 'document', blocks: [], noProgress: 0,
  }, value => value)
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++; return JSON.stringify(invalid)
  }, { steps }), (error: any) => error.statusCode === 422 && error.raw_output === JSON.stringify(invalid))
  assert.equal(calls, 2)
  const state = steps.checkpoint.steps['draft:stream:state']!
  assert.equal(state.input_hash, createHash('sha256').update(JSON.stringify(identity)).digest('hex'))
  assert.deepEqual((state.value as any).artifacts, [])
  assert.deepEqual((state.value as any).blocks, [])
  assert.equal((state.value as any).pendingArtifacts.length, 4)
  assert.equal(hasRetainedGenerationWork(steps.checkpoint), true, 'unadopted original prose must survive a prompt compatibility upgrade')
  assert.equal(hasRetainedGenerationWork({ steps: { ...steps.checkpoint.steps, draft: { input_hash: 'old', value: result, duration_ms: 0 } } }), true)
  assert.equal(hasRetainedGenerationWork({ steps: { 'draft:stream:state': { ...state, value: { artifacts: [], scenes: [], blocks: [{ content: prompt }] } } } }), true)
})
