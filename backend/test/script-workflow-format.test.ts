import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { outputContract } from '../src/modules/generation/model-output.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { hasRetainedGenerationWork, workflowDocumentContext } from '../src/modules/script/script-workflow-context.js'
import { workflowEnvelope, workflowInstructions, workflowRequest, workflowStageDraftInput, workflowStageEnvelope } from '../src/modules/script/script-workflow.js'

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

test('failed response diagnostics do not freeze an empty generation workspace as accepted prose', () => {
  const step = { input_hash: 'diagnostic-input', value: { raw_output: '{"heading":"前台","duration":45}', raw_length: 32, truncated: false } }
  for (const id of ['draft:stream:diagnostic', 'work:episode_script/draft:stream:diagnostic']) {
    assert.equal(hasRetainedGenerationWork({ steps: { [id]: step } }), false)
    assert.equal(hasRetainedGenerationWork({ steps: { [id]: step,
      draft: { input_hash: 'draft-input', value: result },
    } }), true)
  }
  const diagnostic = { 'work:episode:episode/draft:stream:diagnostic': step }
  const state = { input_hash: 'state-input', value: { artifacts: [], scenes: [], blocks: [] } }
  assert.equal(hasRetainedGenerationWork({ steps: { ...diagnostic, 'work:episode:episode/draft:stream:state': state } }), false)
  assert.equal(hasRetainedGenerationWork({ steps: { ...diagnostic, 'work:episode:episode/draft:stream:state': {
    ...state, value: { ...state.value, scenes: [{ heading: '前台', duration: 45 }] },
  } } }), true)
  for (const key of ['pendingSceneRepair', 'pendingBlockResponse']) {
    assert.equal(hasRetainedGenerationWork({ steps: { 'work:episode:episode/draft:stream:state': {
      ...state, value: { ...state.value, [key]: { original: '待核对完整正文' } },
    } } }), true, 'pending original content must survive prompt compatibility upgrades')
  }
})

test('the native stage schema offers only the selected stage types and rejects extra fields and project scenes', () => {
  for (const stage of Object.keys(scriptStageArtifacts) as Array<keyof typeof scriptStageArtifacts>) {
    const contract = outputContract('workflow_draft', workflowStageEnvelope(stage))
    const properties = contract.schema.properties as Record<string, any>
    const artifact = properties.artifacts.items
    assert.deepEqual(artifact.properties.artifact_type.enum, scriptStageArtifacts[stage])
    assert.equal(artifact.additionalProperties, false)
    assert.deepEqual(Object.keys(artifact.properties), ['artifact_type', 'title', 'content'])
    const scenes = properties.scenes.anyOf?.[0] || properties.scenes
    if (stage !== 'episode') {
      assert.equal(scenes.maxItems, 0)
      assert.deepEqual(scenes.items.properties, {}, 'project-stage contracts must not invite scene content')
      for (const protocol of ['json', 'tools'] as const) {
        const instructions = workflowInstructions(workflowRequest.parse({ stage }), protocol)
        assert.match(instructions, /"scenes":\[\]/)
        assert.ok(!instructions.includes('"heading"'), 'project-stage examples must not demonstrate full scenes')
      }
    } else {
      assert.equal(scenes.minItems, 1)
      assert.equal(properties.scenes.anyOf, undefined, 'episode scenes must be required rather than nullable or defaulted')
      assert.ok(scenes.items.properties.heading)
      assert.match(workflowInstructions(workflowRequest.parse({ stage })), /"heading"/)
    }
  }
  assert.equal(workflowStageEnvelope('props').safeParse(invalid).success, false)
  assert.equal(workflowStageEnvelope('props').safeParse({ artifacts: [{ ...result.artifacts[0], artifact_type: 'characters' }], scenes: [] }).success, false)
  assert.equal(workflowEnvelope.safeParse({ artifacts: [{ ...result.artifacts[0], status: 'ready' }], scenes: [] }).success, false)
})

test('JSON and function-call episode contracts both require nonempty scene deliverables', () => {
  const artifacts = [{ artifact_type: 'episode_script', title: '第1集', content: '林舟拿到钥匙，承诺归还。' }]
  const request = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  for (const [schema, base] of [[workflowStageEnvelope('episode'), { artifacts }],
    [workflowStageDraftInput('episode'), { ...request, artifacts }]] as const) {
    const contract = outputContract('episode_draft', schema)
    const properties = contract.schema.properties as Record<string, any>
    assert.equal(properties.scenes.minItems, 1)
    assert.equal(properties.scenes.anyOf, undefined)
    assert.ok((contract.schema.required as string[]).includes('scenes'))
    for (const fields of [{}, { scenes: [] }, { scenes: null }]) {
      assert.equal(schema.safeParse({ ...base, ...fields }).success, false)
    }
  }
  assert.ok(workflowStageEnvelope('episode').safeParse({ artifacts, scenes: [{ heading: '场一', duration: 10 }] }).success)
  assert.ok(workflowStageDraftInput('episode').safeParse({ ...request, artifacts, scenes: [{ heading: '场一', duration: 10 }] }).success)
})

test('episode contracts estimate complete scene seconds independently from generated shot duration', () => {
  const request = workflowRequest.parse({ stage: 'episode', episode_number: 1, target_duration: 180 })
  const artifacts = [{ artifact_type: 'episode_script', title: '第1集', content: '林晚在车站与同伴长谈，说明事故经过。' }]
  for (const [schema, base] of [[workflowStageEnvelope('episode'), { artifacts }],
    [workflowStageDraftInput('episode'), { ...request, artifacts }]] as const) {
    const contract = outputContract('episode_draft', schema)
    const duration = (contract.schema.properties as Record<string, any>).scenes.items.properties.duration
    assert.equal(duration.minimum, 1)
    assert.equal(duration.maximum, 600)
    assert.match(duration.description, /单位为秒/)
    assert.match(duration.description, /完整对白、旁白、动作与必要停顿/)
    assert.ok(schema.safeParse({ ...base, scenes: [{ heading: '车站', duration: 90 }] }).success)
    assert.equal(schema.safeParse({ ...base, scenes: [{ heading: '车站', duration: 601 }] }).success, false)
  }
  for (const protocol of ['json', 'tools'] as const) {
    const instructions = workflowInstructions(request, protocol)
    assert.match(instructions, /每场1至600秒/)
    assert.match(instructions, /不是单个视频镜头的时长/)
    assert.match(instructions, /不按固定字速计算/)
    assert.match(instructions, /不删改对白或遗漏动作来凑秒数/)
  }
})

test('character subtasks and single-document redesign instructions stay inside their selected document', () => {
  const biographies = workflowInstructions(workflowRequest.parse({ stage: 'characters', artifact_types: ['characters'] }))
  assert.match(biographies, /人物小传逐人列出/)
  assert.doesNotMatch(biographies, /人物关系列出对应双方|分别输出 characters/)
  const relationships = workflowInstructions(workflowRequest.parse({ stage: 'characters', artifact_types: ['relationships'] }))
  assert.match(relationships, /人物关系列出对应双方/)
  assert.doesNotMatch(relationships, /人物小传逐人列出|分别输出 characters/)
  const redesign = workflowInstructions(workflowRequest.parse({ stage: 'outline', operation: 'regenerate', artifact_types: ['world'] }))
  assert.match(redesign, /所选栏目重新设计/)
  assert.doesNotMatch(redesign, /整阶段重新设计|提交全部栏目/)
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
