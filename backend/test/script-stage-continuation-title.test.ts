import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'props' })
const prompt = '全剧道具设计：沿用故事总纲，写明每件道具的外观与辨识，保留原剧情与已完成内容。'
const initial = scriptStageArtifacts.props.filter(type => type !== 'prop_visuals').map(type => ({
  artifact_type: type, title: type, content: `已完成的${type}正文，不得重新生成。`,
}))
const first = { id: 'visual:巡祀真官印', title: '巡祀真官印的外观与辨识', content: '## 巡祀真官印\n方形铜印，印面篆纹缺一角；受法时铜绿发亮。', scenes: [] }
const second = { id: 'visual:代神册', title: '代神册的外观与辨识', content: '## 代神册\n黑色薄册，封面三道金线，翻页时可见暗红姓名。', scenes: [] }
const truncatedInitial = '{"artifacts":[' + initial.map(item => JSON.stringify(item)).join(',') + ',{"artifact_type":"prop_visuals","title":"道具外观","content":"未完成'

function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return {
    runner: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    get: () => checkpoint,
  }
}

test('prop visual entries with different item titles continue into the same target document', async () => {
  let calls = 0
  const steps = createGenerationSteps()
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncatedInitial, 'length')
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.match(text, /当前目标：prop_visuals/)
    const raw = JSON.stringify({ blocks: [first, second], complete: true })
    onPartial?.(raw)
    return raw
  }, { steps })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), initial)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), {
    artifact_type: 'prop_visuals', title: first.title, content: first.content + '\n\n' + second.content,
  })
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('the same prop visual id and body with a changed title is deduplicated across continuation rounds', async () => {
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncatedInitial, 'length')
    assert.equal(contract?.name, 'script_stage_blocks')
    if (calls === 2) return JSON.stringify({ blocks: [first], complete: false })
    assert.ok(text.includes(first.content.replace(/\n/g, '\\n')))
    return JSON.stringify({ blocks: [{ ...first, title: '真官印辨识说明' }, second], complete: true })
  })
  assert.equal(calls, 3)
  const visual = draft.artifacts.find(item => item.artifact_type === 'prop_visuals')!
  assert.equal(visual.title, first.title)
  assert.equal(visual.content, first.content + '\n\n' + second.content)
})

test('title normalization does not permit rewriting a retained prop visual id or losing its body', async () => {
  const steps = createGenerationSteps()
  let calls = 0
  const rewritten = { ...first, title: '真官印辨识说明', content: '## 巡祀真官印\n改成无缺角的白玉圆印。' }
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncatedInitial, 'length')
    onPartial?.(JSON.stringify({ blocks: [first], complete: false }))
    return JSON.stringify({ blocks: [rewritten, second], complete: true })
  }, { steps }), (error: unknown) => (error as { code?: string }).code === 'stage_continuation_conflict')
  assert.equal(calls, 3, 'one correction is allowed before the unchanged conflict stops')
  const retained = steps.checkpoint.steps['draft:stream:state']!.value as {
    artifacts: unknown[]; blocks: Array<typeof first>; blockConflicts: Array<{ rejected_preview: string; occurrences: number }>
  }
  assert.deepEqual(retained.artifacts, initial)
  assert.deepEqual(retained.blocks, [first, { ...second, title: first.title }], 'legal later units remain available for continuation')
  assert.ok(!JSON.stringify(retained.blocks).includes('白玉圆印'), 'the rejected rewrite never enters accepted prose')
  assert.ok(retained.blockConflicts[0]!.rejected_preview.includes('白玉圆印'), 'the rejected rewrite is retained only as a diagnostic')
  assert.equal(retained.blockConflicts[0]!.occurrences, 2, 'the same conflict was returned in two provider responses')
})

test('a disconnect after receiving a prop entry resumes the remaining entries without regenerating saved prose', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncatedInitial, 'length')
    onPartial?.('{"blocks":[' + JSON.stringify(first) + ',{"id":"unfinished')
    throw new TextProviderError('connection reset after complete entry', true, 'ECONNRESET')
  }, { steps: store.runner() }), (error: unknown) => (error as { code?: string }).code === 'stage_stream_interrupted')
  assert.equal(calls, 2)
  const retained = store.get().steps['draft:stream:state']!.value as { blocks: Array<typeof first> }
  assert.deepEqual(retained.blocks, [first])

  let resumedCalls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    resumedCalls++
    assert.equal(contract?.name, 'script_stage_blocks', 'resume must not request the complete stage again')
    assert.ok(text.includes(JSON.stringify(initial)))
    assert.ok(text.includes(JSON.stringify(first)))
    return JSON.stringify({ blocks: [second], complete: true })
  }, { steps: store.runner() })
  assert.equal(resumedCalls, 1)
  const visual = draft.artifacts.find(item => item.artifact_type === 'prop_visuals')!
  assert.equal(visual.title, first.title)
  assert.equal(visual.content, first.content + '\n\n' + second.content)
  assert.deepEqual(store.get().steps, {})
})

test('legacy v1 checkpoints keep their original first title while accepting differently titled remaining prop entries', async () => {
  const store = workspace()
  const legacyFirst = { ...first, title: '旧版已保留的全剧道具外观档案' }
  store.runner().retain('draft:stream:state', '旧版本已完成单元', {
    strategy: 'stage-semantic-stream-v1', request, prompt,
  }, {
    version: 1, round: 3, initialEnded: true, artifacts: initial, scenes: [],
    target: 'prop_visuals', mode: 'document', blocks: [legacyFirst], noProgress: 0,
  }, value => value)
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    calls++
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.ok(text.includes(JSON.stringify(legacyFirst)))
    return JSON.stringify({ blocks: [second], complete: true })
  }, { steps: store.runner() })
  assert.equal(calls, 1)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), {
    artifact_type: 'prop_visuals', title: legacyFirst.title, content: legacyFirst.content + '\n\n' + second.content,
  })
  assert.deepEqual(store.get().steps, {})
})

test('scene continuation accepts individual scene titles and preserves the already complete episode script', async () => {
  const episode = workflowRequest.parse({ stage: 'episode', episode_number: 2 })
  const script = { artifact_type: 'episode_script', title: '第2集：真官印', content: '场一发现缺角。场二验明真伪。场三归还官印。' }
  const scene = (heading: string, action: string) => ({ heading, location: '院门', time_of_day: '日', characters: '陆照', action, dialogue: '认印，也认人。', narration: '', duration: 10 })
  const scenes = [scene('场一：发现缺角', '发现铜印缺角。'), scene('场二：验明真伪', '对照印痕，确认真伪。'), scene('场三：归还官印', '将铜印归还。')]
  let calls = 0
  const draft = await generateStageDraftWithContinuation(episode, prompt, async (_text, contract, onPartial) => {
    calls++
    if (calls === 1) {
      const raw = '{"artifacts":[' + JSON.stringify(script) + '],"scenes":[' + JSON.stringify(scenes[0]) + ',{"heading":"未完成'
      onPartial?.(raw)
      throw new TextOutputLimitError(raw, 'length')
    }
    assert.equal(contract?.name, 'script_stage_blocks')
    const item = scenes[calls - 1]!
    return JSON.stringify({ blocks: [{ id: `scene:${calls}`, title: item.heading, content: '', scenes: [item] }], complete: calls === 3 })
  })
  assert.equal(calls, 3)
  assert.deepEqual(draft.artifacts, [script])
  assert.deepEqual(draft.scenes, scenes)
})
