import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { initialScriptTaskContract } from '@video-studio/shared/script/script-task-contract'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { executeScriptWorkPlan, retainedLegacyStageWork, scopedScriptSteps, scriptWorkPlan, type ScriptWorkTask, type ScriptWorkTiming } from '../src/modules/script/script-task-execution.js'
import { workflowRequest, workflowGenerationDraftSchema, type WorkflowDraft } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'outline', intent: 'stage_design' })
const artifact = (type: StageArtifactType, revision = '初稿') => ({ artifact_type: type, title: `${type}标题`, content: `${type}的完整正文，${revision}。` })
const result = (task: ScriptWorkTask, revision?: string) => JSON.stringify({ artifacts: task.artifact_types.map(type => artifact(type, revision)), scenes: [] })
const prompt = (task: ScriptWorkTask, dependencies: WorkflowDraft[]) => JSON.stringify({ task: task.id, dependencies })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return {
    runner: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    snapshot: () => structuredClone(checkpoint),
  }
}

test('upload-to-outline delivers one useful manuscript outline without generating the full design package', async () => {
  const sourceRequest = workflowRequest.parse(initialScriptTaskContract({ stage: 'outline' as const, intent: 'source_outline', artifact_types: ['outline'] }, true))
  const plan = scriptWorkPlan(sourceRequest)
  assert.equal(sourceRequest.intent, 'source_outline')
  assert.equal(plan.length, 1)
  assert.deepEqual(plan[0]!.artifact_types, ['outline'])
  assert.deepEqual(plan[0]!.depends_on, [])
  assert.match(plan[0]!.acceptance.join('\n'), /原稿未说明/)
  let calls = 0
  const draft = await executeScriptWorkPlan({ request: sourceRequest, steps: createGenerationSteps(), prompt,
    generate: task => async () => { calls++; return result(task) } })
  assert.equal(calls, 1)
  assert.deepEqual(draft.artifacts.map(item => item.artifact_type), ['outline'])
  assert.equal(draft.intent, 'source_outline')
})

test('task progress reports original generation time when a checkpoint is replayed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const selected = workflowRequest.parse({ ...request, artifact_types: ['outline'] }), state = workspace()
  const timings: ScriptWorkTiming[] = []
  let calls = 0
  const run = () => executeScriptWorkPlan({ request: selected, steps: state.runner(), prompt,
    generate: task => async () => { calls++; t.mock.timers.tick(12_345); return result(task) },
    onTask: (_task, status, _draft, _error, timing) => { if (status === 'succeeded') timings.push(timing!) },
  })
  await run()
  t.mock.timers.tick(60_000)
  await run()
  assert.equal(calls, 1)
  assert.deepEqual(timings, [{ reused: false, duration_ms: 12_345 }, { reused: true, duration_ms: 12_345 }])
})

test('preserved and migrated documents are reused without inventing authoring time on repeated resumes', async () => {
  const selected = workflowRequest.parse({ ...request, artifact_types: ['outline'] })
  for (const source of ['preserved', 'migrated']) {
    const state = workspace(), timings: ScriptWorkTiming[] = []
    const run = () => executeScriptWorkPlan({ request: selected, steps: state.runner(), prompt,
      ...(source === 'preserved' ? { preserved: [artifact('outline')] } : { legacyWork: { artifacts: [artifact('outline')], continuations: {} } }),
      generate: () => async () => { throw new Error('completed work must not be regenerated') },
      onTask: (_task, status, _draft, _error, timing) => { if (status === 'succeeded') timings.push(timing!) },
    })
    await run(); await run()
    assert.equal(timings.length, 2)
    assert.ok(timings.every(timing => timing.reused === true && timing.duration_ms === undefined), source)
  }
})

test('full design follows narrative dependencies while independent world and narrative tasks run together', { timeout: 5000 }, async () => {
  const narrativeStarted = deferred(), worldStarted = deferred(), release = deferred()
  const succeeded = new Set<string>()
  const dependencyInputs = new Map<string, string[]>()
  const plan = scriptWorkPlan(request)
  const running = executeScriptWorkPlan({ request, steps: createGenerationSteps(),
    prompt: (task, dependencies) => {
      assert.ok(task.depends_on.every(id => succeeded.has(id)), `${task.id} must wait for every declared dependency`)
      dependencyInputs.set(task.id, dependencies.flatMap(draft => draft.artifacts.map(item => item.artifact_type)))
      return prompt(task, dependencies)
    },
    generate: task => async () => {
      if (task.id === 'outline:synopsis') { narrativeStarted.resolve(); await release.promise }
      if (task.id === 'outline:world') { worldStarted.resolve(); await release.promise }
      return result(task)
    },
    onTask: (task, status) => { if (status === 'succeeded') succeeded.add(task.id) },
  })
  await Promise.all([narrativeStarted.promise, worldStarted.promise])
  assert.deepEqual([...succeeded], ['outline:outline'], 'both independent tasks start before either one completes')
  release.resolve()
  const draft = await running
  assert.deepEqual(plan.map(task => task.id), scriptStageArtifacts.outline.map(type => `outline:${type}`))
  assert.ok(plan.every(task => task.artifact_types.length === 1))
  assert.deepEqual(dependencyInputs.get('outline:hooks'), ['outline', 'synopsis', 'world', 'structure', 'constraints'])
  assert.deepEqual(dependencyInputs.get('outline:episode_outline'), ['outline', 'synopsis', 'world', 'structure', 'constraints', 'hooks', 'foreshadowing', 'reversals'])
  assert.deepEqual(draft.artifacts.map(item => item.artifact_type), [...scriptStageArtifacts.outline])
})

test('a failed branch retains its successful sibling and resume calls only unfinished model work', { timeout: 5000 }, async () => {
  const state = workspace(), narrativeGate = deferred(), worldFailed = deferred()
  const calls = new Map<string, number>()
  let failWorld = true
  const generate = (task: ScriptWorkTask) => async () => {
    calls.set(task.id, (calls.get(task.id) || 0) + 1)
    if (task.id === 'outline:synopsis' && failWorld) await narrativeGate.promise
    if (task.id === 'outline:world' && failWorld) { worldFailed.resolve(); throw new Error('世界设定请求中断') }
    return result(task)
  }
  const interrupted = executeScriptWorkPlan({ request, steps: state.runner(), prompt, generate })
  await worldFailed.promise
  narrativeGate.resolve()
  await assert.rejects(interrupted, /世界设定请求中断/)
  const saved = state.snapshot()
  assert.ok(saved.steps['work:document:outline:outline/draft'])
  assert.ok(saved.steps['work:document:outline:synopsis/draft'], 'the sibling that finishes after another branch fails still persists')
  assert.equal(saved.steps['work:document:outline:world/draft'], undefined)
  assert.equal(calls.has('outline:hooks'), false, 'dependent work cannot run before its missing parent')
  failWorld = false
  const recovered = await executeScriptWorkPlan({ request, steps: state.runner(), prompt, generate })
  assert.equal(calls.get('outline:outline'), 1)
  assert.equal(calls.get('outline:synopsis'), 1)
  assert.equal(calls.get('outline:world'), 2)
  assert.equal(calls.get('outline:hooks'), 1)
  assert.equal(calls.get('outline:episode_outline'), 1)
  assert.equal(recovered.artifacts.length, 9)
})

test('changed dependency output invalidates affected descendants even with otherwise identical task prompts', async () => {
  const state = workspace(), calls = new Map<string, number>()
  let revision = '第一版'
  const options = () => ({ request, steps: state.runner(),
    // Dependency hashing belongs to the scheduler, not incidental prompt prose.
    prompt: (task: ScriptWorkTask) => `${task.id}${task.id === 'outline:synopsis' ? revision : ''}`,
    generate: (task: ScriptWorkTask) => async () => {
      calls.set(task.id, (calls.get(task.id) || 0) + 1)
      return result(task, revision)
    },
  })
  await executeScriptWorkPlan(options())
  revision = '已明确新转折'
  await executeScriptWorkPlan(options())
  assert.equal(calls.get('outline:outline'), 1, 'the upstream story is unchanged')
  assert.equal(calls.get('outline:world'), 1, 'the independent world branch is unchanged')
  assert.equal(calls.get('outline:synopsis'), 2)
  assert.equal(calls.get('outline:hooks'), 2, 'payoffs must use the revised narrative')
  assert.equal(calls.get('outline:episode_outline'), 2, 'episodes must use the revised narrative and payoffs')
})

test('changed dependencies also invalidate unfinished continuation prose from the earlier dependency version', async () => {
  const state = workspace()
  let revision = '旧转折'
  const payoffsContracts: string[] = []
  const options = () => ({ request, steps: state.runner(),
    prompt: (task: ScriptWorkTask) => `${task.id}${task.id === 'outline:synopsis' ? revision : ''}`,
    generate: (task: ScriptWorkTask) => async (_text: string, contract?: { name: string }, onPartial?: (raw: string) => void) => {
      if (task.id === 'outline:hooks') {
        payoffsContracts.push(contract!.name)
        if (revision === '旧转折') {
          onPartial?.('{"artifacts":[' + JSON.stringify(artifact('hooks', revision)) + ']')
          throw new Error('旧转折下的伏笔请求中断')
        }
        assert.equal(contract!.name, 'workflow_draft', 'old partial units must be discarded when their narrative dependency changes')
      }
      return result(task, revision)
    },
  })
  await assert.rejects(executeScriptWorkPlan(options()), /旧转折下的伏笔请求中断/)
  assert.ok(state.snapshot().steps['work:document:outline:hooks/draft:stream:state'])
  revision = '新转折'
  const draft = await executeScriptWorkPlan(options())
  assert.deepEqual(payoffsContracts, ['workflow_draft', 'workflow_draft'])
  assert.match(draft.artifacts.find(item => item.artifact_type === 'hooks')!.content, /新转折/)
  assert.doesNotMatch(draft.artifacts.find(item => item.artifact_type === 'hooks')!.content, /旧转折/)
})

test('scoped continuation and evidence checkpoints cannot read, overwrite or forget another task state', async () => {
  const parent = createGenerationSteps()
  const narrative = scopedScriptSteps(parent, 'work:document:outline:synopsis')
  const world = scopedScriptSteps(parent, 'work:document:outline:world')
  const parse = (value: unknown) => { assert.ok(value && typeof value === 'object'); return value as { text: string } }
  narrative.retain('draft:stream:state', '保留叙事', { prompt: 'same' }, { text: '叙事已完成段落' }, parse)
  world.retain('draft:stream:state', '保留世界', { prompt: 'same' }, { text: '世界已完成段落' }, parse)
  assert.deepEqual(Object.keys(narrative.checkpoint.steps), ['draft:stream:state'])
  assert.deepEqual(narrative.checkpoint.steps['draft:stream:state']!.value, { text: '叙事已完成段落' })
  assert.deepEqual(world.checkpoint.steps['draft:stream:state']!.value, { text: '世界已完成段落' })
  let calls = 0
  await narrative.run('evidence', '核对叙事', {}, async () => ++calls, value => Number(value))
  await world.run('evidence', '核对世界', {}, async () => ++calls, value => Number(value))
  assert.equal(calls, 2, 'identical local step IDs and inputs still belong to different tasks')
  narrative.forget('draft:stream:state')
  assert.equal(narrative.checkpoint.steps['draft:stream:state'], undefined)
  assert.deepEqual(world.checkpoint.steps['draft:stream:state']!.value, { text: '世界已完成段落' })
  const restored = scopedScriptSteps(createGenerationSteps({ checkpoint: parent.checkpoint }), 'work:document:outline:world')
  assert.deepEqual(restored.checkpoint.steps['draft:stream:state']!.value, { text: '世界已完成段落' })
})

test('parallel truncated task streams resume their own retained documents without cross-task contamination', async () => {
  const state = workspace(), initialCalls = new Map<string, number>(), continuationTargets: string[] = []
  let interrupted = true
  const generate = (task: ScriptWorkTask) => async (text: string, contract?: { name: string }, onPartial?: (raw: string) => void) => {
    if (task.id === 'outline:synopsis' || task.id === 'outline:world') {
      if (interrupted) {
        if (contract?.name === 'workflow_draft') {
          initialCalls.set(task.id, (initialCalls.get(task.id) || 0) + 1)
          throw new TextOutputLimitError('{"artifacts":[', 'length')
        }
        const target = task.artifact_types[0]!
        onPartial?.('{"blocks":[' + JSON.stringify({ id: `${target}:first`, title: `${target}标题`, content: `${target}已保留的第一段。`, scenes: [] }) + ',{"id":"未写完","content":"半截')
        throw new Error(`请求中断：${task.id}`)
      }
      assert.equal(contract?.name, 'script_stage_blocks', 'resume must continue retained semantic units without recreating their document')
      const target = task.artifact_types[0]!
      continuationTargets.push(target)
      assert.ok(text.includes(`${target}已保留的第一段。`))
      const otherRetained = task.id === 'outline:synopsis' ? 'world' : 'synopsis'
      assert.ok(!text.includes(`${otherRetained}已保留的第一段。`), 'a task cannot inherit another task streaming state')
      return JSON.stringify({ blocks: [{ id: `${target}:done`, title: `${target}标题`, content: `${target}的接续正文。`, scenes: [] }], complete: true })
    }
    return result(task)
  }
  await assert.rejects(executeScriptWorkPlan({ request, steps: state.runner(), prompt, generate }), /请求中断/)
  const saved = state.snapshot()
  assert.ok(saved.steps['work:document:outline:synopsis/draft:stream:state'])
  assert.ok(saved.steps['work:document:outline:world/draft:stream:state'])
  interrupted = false
  const resumed = await executeScriptWorkPlan({ request, steps: state.runner(), prompt, generate })
  assert.deepEqual(continuationTargets.sort(), ['synopsis', 'world'])
  assert.equal(initialCalls.get('outline:synopsis'), 1)
  assert.equal(initialCalls.get('outline:world'), 1)
  assert.equal(resumed.artifacts.find(item => item.artifact_type === 'synopsis')!.content, 'synopsis已保留的第一段。\n\nsynopsis的接续正文。')
  assert.equal(resumed.artifacts.find(item => item.artifact_type === 'world')!.content, 'world已保留的第一段。\n\nworld的接续正文。')
})

test('onTask exposes each complete result before a later failure and those previews survive restart', async () => {
  const state = workspace(), previews = new Map<string, WorkflowDraft>(), events: string[] = []
  await assert.rejects(executeScriptWorkPlan({ request, steps: state.runner(), prompt,
    generate: task => async () => {
      if (task.id === 'outline:episode_outline') {
        assert.equal(previews.size, 8, 'all preceding work is already available while the final task is running')
        throw new Error('分集请求失败')
      }
      return result(task)
    },
    onTask: (task, status, draft) => {
      events.push(`${task.id}:${status}`)
      if (status === 'succeeded') { assert.ok(draft); previews.set(task.id, structuredClone(draft)) }
    },
  }), /分集请求失败/)
  assert.equal(previews.size, 8)
  assert.equal([...previews.values()].flatMap(draft => draft.artifacts).length, 8)
  assert.equal(events.at(-1), 'outline:episode_outline:failed')
  assert.equal(Object.keys(state.snapshot().steps).filter(key => key.endsWith('/draft')).length, 8)
  const restoredPreviews: string[] = []
  let modelCalls = 0
  await executeScriptWorkPlan({ request, steps: state.runner(), prompt,
    generate: task => async () => { modelCalls++; return result(task) },
    onTask: (task, status, draft) => { if (status === 'succeeded' && draft) restoredPreviews.push(task.id) },
  })
  assert.equal(modelCalls, 1)
  assert.equal(restoredPreviews.length, 9, 'cached results are republished for a reconnected preview')
})

test('supplementing a design preserves existing titles and prose while generating only missing deliverables', async () => {
  const preserved = [
    { artifact_type: 'outline' as const, title: '创作者确认的故事  ', content: '\n林舟拿到钥匙。\n\n终局按约归还，身份与结局均不改。\n  ' },
    { artifact_type: 'synopsis' as const, title: '已保存的故事简述\t', content: '  林舟先拿到钥匙，再调查旧约，最后交还钥匙。\n' },
  ]
  const generated: StageArtifactType[] = [], dependencyArtifacts: WorkflowDraft['artifacts'] = [], previews: WorkflowDraft[] = []
  const supplemented = await executeScriptWorkPlan({ request: workflowRequest.parse({ ...request, operation: 'supplement' }),
    steps: createGenerationSteps(), preserved,
    prompt: (task, dependencies) => { dependencyArtifacts.push(...dependencies.flatMap(draft => draft.artifacts)); return prompt(task, dependencies) },
    generate: task => async () => {
      generated.push(...task.artifact_types)
      assert.ok(!task.artifact_types.includes('outline'), 'the accepted story cannot be regenerated during supplement')
      assert.ok(!task.artifact_types.includes('synopsis'), 'a partly complete group generates only its missing document')
      return result(task)
    },
    onTask: (_task, status, draft) => { if (status === 'succeeded' && draft) previews.push(draft) },
  })
  assert.equal(generated.length, 7)
  assert.deepEqual(supplemented.artifacts.slice(0, 2), preserved)
  assert.ok(dependencyArtifacts.some(item => JSON.stringify(item) === JSON.stringify(preserved[0])))
  assert.ok(dependencyArtifacts.some(item => JSON.stringify(item) === JSON.stringify(preserved[1])), 'later tasks must read the retained synopsis')
  assert.ok(previews.some(draft => draft.artifacts.some(item => item.content === preserved[0]!.content)), 'retained work remains available in live previews')
})

test('supplement recovery retains exact accepted bytes in cached partial groups and their later dependencies', async () => {
  const state = workspace()
  const preserved = [
    { artifact_type: 'outline' as const, title: '原有主线  ', content: '\n林舟返乡，调查旧约，归还钥匙。\n  ' },
    { artifact_type: 'synopsis' as const, title: '原有故事简述\t', content: '  林舟先返乡，再调查，最后归还钥匙。\n' },
  ]
  const calls = new Map<string, number>(), dependencyInputs: WorkflowDraft['artifacts'] = []
  let failWorld = true
  const run = () => executeScriptWorkPlan({ request: workflowRequest.parse({ ...request, operation: 'supplement' }),
    steps: state.runner(), preserved,
    prompt: (task, dependencies) => { dependencyInputs.push(...dependencies.flatMap(draft => draft.artifacts)); return prompt(task, dependencies) },
    generate: task => async () => {
      calls.set(task.id, (calls.get(task.id) || 0) + 1)
      if (task.id === 'outline:world' && failWorld) throw new Error('世界设定暂不可用')
      return result(task)
    },
  })
  await assert.rejects(run(), /世界设定暂不可用/)
  failWorld = false
  const resumed = await run()
  assert.deepEqual(resumed.artifacts.slice(0, 2), preserved)
  assert.equal(calls.has('outline:outline'), false, 'the accepted story is injected rather than regenerated')
  assert.equal(calls.has('outline:synopsis'), false, 'the accepted synopsis is always injected rather than regenerated')
  assert.equal(calls.get('outline:world'), 2)
  for (const original of preserved) assert.ok(dependencyInputs.some(item => JSON.stringify(item) === JSON.stringify(original)))
})

test('a fully saved design needs no model calls and republishes every retained deliverable for preview', async () => {
  const preserved = scriptStageArtifacts.outline.map(type => ({ ...artifact(type, '作者已确认'),
    title: artifact(type).title + '  ', content: '\n' + artifact(type).content + '\n  ' }))
  const previews: WorkflowDraft['artifacts'] = []
  let calls = 0
  const draft = await executeScriptWorkPlan({ request: workflowRequest.parse({ ...request, operation: 'supplement' }),
    steps: createGenerationSteps(), preserved, prompt,
    generate: () => async () => { calls++; throw new Error('existing work must be preserved') },
    onTask: (_task, status, value) => { if (status === 'succeeded' && value) previews.push(...value.artifacts) },
  })
  assert.equal(calls, 0)
  assert.deepEqual(draft.artifacts, preserved)
  assert.deepEqual([...new Set(previews.map(item => item.artifact_type))].sort(), [...scriptStageArtifacts.outline].sort())
})
