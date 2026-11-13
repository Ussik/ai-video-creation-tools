import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallbackManager } from '@langchain/core/callbacks/manager'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'
import { StateGraph } from '@langchain/langgraph'
import type { StoryboardPlanningResult, StoryboardPlanningStage } from '@video-studio/shared/storyboard/storyboard-planning-types'
import type { StoryboardPlanningControl } from '../src/modules/storyboard/storyboard-planning-tasks.js'
import { runStoryboardPlanningWorkflow } from '../src/modules/storyboard/storyboard-planning-workflow.js'

type Preparation = { rules: string }
type Candidate = { text: string }
type Report = { errors: boolean }
const projection = (candidate: Candidate, repaired: boolean, status: 'passed' | 'needs_work' | 'pending_review' | 'inconclusive'): StoryboardPlanningResult => ({
  signature: 'a'.repeat(64), scenes: [{ scene_id: 'scene', scene_heading: candidate.text, scene_duration: 12, shots: [] }],
  used_skills: [], source_documents: [], directing_review: { status, repaired, issues: [] },
})
function fixture(steps: Record<string, unknown> = {}) {
  const controller = new AbortController(), calls: string[] = [], stages: StoryboardPlanningStage[] = [], retained: string[] = []
  const candidates: StoryboardPlanningResult[] = []
  const control: StoryboardPlanningControl = { signal: controller.signal, steps,
    stage(stage) { controller.signal.throwIfAborted(); stages.push(stage) },
    retain(key, value, candidate) { controller.signal.throwIfAborted(); steps[key] = structuredClone(value); retained.push(key)
      if (candidate) candidates.push(structuredClone(candidate)) },
  }
  const options = {
    prepare: async (): Promise<Preparation> => { calls.push('prepare'); return { rules: 'accepted rules' } },
    restorePreparation: (value: unknown): Preparation => { calls.push('restorePreparation'); assert.equal((value as Preparation).rules, 'accepted rules'); return value as Preparation },
    generate: async (_prepared: Preparation): Promise<Candidate> => { calls.push('generate'); return { text: 'original candidate' } },
    restoreCandidate: (value: unknown): Candidate => { calls.push('restoreCandidate'); assert.equal(typeof (value as Candidate).text, 'string'); return value as Candidate },
    serializeCandidate: (candidate: Candidate) => structuredClone(candidate),
    review: async (_candidate: Candidate): Promise<Report> => { calls.push('review'); return { errors: false } },
    restoreReport: (value: unknown, _candidate: Candidate): Report => { calls.push('restoreReport'); assert.equal(typeof (value as Report).errors, 'boolean'); return value as Report },
    hasErrors: (report: Report) => report.errors,
    repair: async (_prepared: Preparation, _candidate: Candidate, _report: Report): Promise<Candidate> => { calls.push('repair'); return { text: 'repaired candidate' } },
    projection: (_prepared: Preparation, candidate: Candidate, repaired: boolean) => projection(candidate, repaired, 'pending_review'),
    inconclusive: (_prepared: Preparation, candidate: Candidate, repaired: boolean, _error: unknown, _report?: Report) => projection(candidate, repaired, 'inconclusive'),
    finish: (_prepared: Preparation, candidate: Candidate, report: Report, repaired: boolean) => {
      calls.push('finish'); return projection(candidate, repaired, report.errors ? 'needs_work' : 'passed')
    },
  }
  return { controller, calls, stages, retained, candidates, control, options }
}

test('a real StateGraph compiles the six bounded planning nodes and runs the successful route', async t => {
  const compile = StateGraph.prototype.compile
  let compiled = 0
  t.mock.method(StateGraph.prototype, 'compile', function (this: StateGraph<any>, ...args: Parameters<typeof compile>) {
    compiled++
    const graph = Reflect.apply(compile, this, args)
    assert.deepEqual(Object.keys(graph.getGraph().nodes).filter(name => !name.startsWith('__')).sort(),
      ['finish', 'generate', 'prepare', 'recheck', 'repair', 'review'])
    assert.equal(graph.checkpointer, undefined, 'the existing durable task remains the only checkpoint owner')
    const invoke = graph.invoke.bind(graph)
    t.mock.method(graph, 'invoke', (input, config) => {
      assert.equal(config.recursionLimit, 8)
      assert.ok(config.callbacks instanceof CallbackManager)
      return invoke(input, config).then(result => {
        assert.deepEqual(Object.keys(result).sort(), ['completed', 'needsRepair', 'repaired'])
        assert.ok(Object.values(result).every(value => typeof value === 'boolean'))
        return result
      })
    })
    return graph
  })
  const f = fixture(), result = await runStoryboardPlanningWorkflow(f.control, f.options)
  assert.equal(compiled, 1)
  assert.deepEqual(f.calls, ['prepare', 'generate', 'review', 'finish'])
  assert.deepEqual(f.stages, ['preparing', 'generating', 'reviewing'])
  assert.deepEqual(f.retained, ['preparation', 'candidate', 'report'])
  assert.equal(result.directing_review!.status, 'passed'); assert.equal(result.directing_review!.repaired, false)
})

test('serialized checkpoints restore each accepted stage without repeating paid generation or review', async () => {
  const first = fixture()
  let reviews = 0
  first.options.review = async () => { first.calls.push('review'); reviews++; return { errors: true } }
  const initial = await runStoryboardPlanningWorkflow(first.control, first.options)
  assert.equal(initial.directing_review!.status, 'needs_work')
  assert.equal(reviews, 2)
  const resumed = fixture(JSON.parse(JSON.stringify(first.control.steps)))
  const result = await runStoryboardPlanningWorkflow(resumed.control, resumed.options)
  assert.deepEqual(resumed.calls, ['restorePreparation', 'restoreCandidate', 'restoreReport', 'restoreCandidate', 'restoreReport', 'finish'])
  assert.deepEqual(resumed.stages, []); assert.deepEqual(resumed.retained, [])
  assert.equal(result.scenes[0]!.scene_heading, 'repaired candidate')
  assert.equal(result.directing_review!.status, 'needs_work'); assert.equal(result.directing_review!.repaired, true)
})

test('a review failure returns an inconclusive retained candidate without invoking repair or save approval', async () => {
  const f = fixture()
  f.options.review = async () => { f.calls.push('review'); throw new Error('review stream disconnected') }
  const result = await runStoryboardPlanningWorkflow(f.control, f.options)
  assert.deepEqual(f.calls, ['prepare', 'generate', 'review'])
  assert.deepEqual(f.retained, ['preparation', 'candidate'])
  assert.equal(f.candidates[0]!.directing_review!.status, 'pending_review')
  assert.equal(result.directing_review!.status, 'inconclusive')
  assert.equal(result.scenes[0]!.scene_heading, 'original candidate')
})

test('the error route repairs once and rechecks once even when the revised report still has errors', async () => {
  const f = fixture()
  f.options.review = async () => { f.calls.push('review'); return { errors: true } }
  const result = await runStoryboardPlanningWorkflow(f.control, f.options)
  assert.deepEqual(f.calls, ['prepare', 'generate', 'review', 'repair', 'review', 'finish'])
  assert.deepEqual(f.stages, ['preparing', 'generating', 'reviewing', 'repairing', 'rechecking'])
  assert.deepEqual(f.retained, ['preparation', 'candidate', 'report', 'revised_candidate', 'revised_report'])
  assert.equal(result.directing_review!.status, 'needs_work'); assert.equal(result.directing_review!.repaired, true)
})

test('recheck failure keeps the revised candidate and cannot approve it for saving', async () => {
  const f = fixture()
  let reviews = 0
  f.options.review = async () => { f.calls.push('review'); if (++reviews === 2) throw new Error('recheck unavailable'); return { errors: true } }
  const result = await runStoryboardPlanningWorkflow(f.control, f.options)
  assert.equal(result.directing_review!.status, 'inconclusive'); assert.equal(result.directing_review!.repaired, true)
  assert.equal(result.scenes[0]!.scene_heading, 'repaired candidate')
  assert.equal(f.calls.filter(call => call === 'repair').length, 1)
  assert.equal(f.calls.includes('finish'), false)
  assert.equal('revised_report' in f.control.steps, false)
})

test('a failed repair keeps the original candidate and original report without another paid attempt', async () => {
  const f = fixture()
  f.options.review = async () => { f.calls.push('review'); return { errors: true } }
  f.options.repair = async () => { f.calls.push('repair'); throw new Error('repair unavailable') }
  const result = await runStoryboardPlanningWorkflow(f.control, f.options)
  assert.deepEqual(f.calls, ['prepare', 'generate', 'review', 'repair'])
  assert.equal(result.scenes[0]!.scene_heading, 'original candidate')
  assert.equal(result.directing_review!.status, 'inconclusive'); assert.equal(result.directing_review!.repaired, false)
  assert.equal('candidate' in f.control.steps, true); assert.equal('report' in f.control.steps, true)
  assert.equal('revised_candidate' in f.control.steps, false)
})

test('a transient generation fault is dispatched once without a graph retry policy', async () => {
  const f = fixture()
  f.options.generate = async () => { f.calls.push('generate'); throw Object.assign(new Error('upstream unavailable'), { status: 503 }) }
  await assert.rejects(runStoryboardPlanningWorkflow(f.control, f.options), /upstream unavailable/)
  assert.deepEqual(f.calls, ['prepare', 'generate'])
  assert.equal('candidate' in f.control.steps, false)
})

test('task and text budget failures escape review, repair and recheck without becoming an inconclusive success', async t => {
  for (const phase of ['review', 'repair', 'recheck'] as const) for (const code of ['storyboard_planning_budget_exceeded', 'text_request_budget_exceeded']) {
    await t.test(`${phase}: ${code}`, async () => {
      const f = fixture(), budget = Object.assign(new Error('planning budget reached'), { code, reason: 'requests' })
      let reviews = 0
      f.options.review = async () => {
        f.calls.push('review'); reviews++
        if (phase === 'review' || phase === 'recheck' && reviews === 2) throw budget
        return { errors: true }
      }
      f.options.repair = async () => { f.calls.push('repair'); if (phase === 'repair') throw budget; return { text: 'repaired candidate' } }
      await assert.rejects(runStoryboardPlanningWorkflow(f.control, f.options), error => (error as { code?: string }).code === code)
      assert.equal(f.calls.includes('finish'), false)
      assert.equal('candidate' in f.control.steps, true)
      assert.equal('revised_report' in f.control.steps, false)
      assert.equal(f.calls.filter(call => call === 'repair').length, phase === 'review' ? 0 : 1)
    })
  }
})

test('cancellation at a paid node does not retry, retain its output or enter later nodes', async () => {
  const f = fixture(), reason = new Error('creator cancelled')
  f.options.generate = async () => { f.calls.push('generate'); f.controller.abort(reason); return { text: 'discarded' } }
  await assert.rejects(runStoryboardPlanningWorkflow(f.control, f.options), /creator cancelled/)
  assert.deepEqual(f.calls, ['prepare', 'generate'])
  assert.deepEqual(f.retained, ['preparation'])
  assert.equal('candidate' in f.control.steps, false)
})

test('a pre-cancelled graph does not restore checkpoints or call any node', async () => {
  const f = fixture({ preparation: { rules: 'accepted rules' } })
  f.controller.abort(new Error('already cancelled'))
  await assert.rejects(runStoryboardPlanningWorkflow(f.control, f.options), /already cancelled/)
  assert.deepEqual(f.calls, [])
})

test('identity conflicts and invalid restored checkpoints fail without becoming an inconclusive success', async () => {
  const f = fixture(), conflict = Object.assign(new Error('model configuration changed'), { statusCode: 409 })
  f.options.review = async () => { f.calls.push('review'); throw conflict }
  await assert.rejects(runStoryboardPlanningWorkflow(f.control, f.options), /model configuration changed/)
  const stale = fixture({ preparation: { rules: 'changed rules' } })
  await assert.rejects(runStoryboardPlanningWorkflow(stale.control, stale.options))
  assert.deepEqual(stale.calls, ['restorePreparation'])
})

test('environment tracing flags and an inherited runnable cannot export the graph or its candidate', async t => {
  const environment = { LANGCHAIN_TRACING: 'true', LANGCHAIN_TRACING_V2: 'true', LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'fixture-key-never-send', LANGSMITH_ENDPOINT: 'https://fixture.invalid' }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  } })
  let requests = 0, callbacks = 0, traces = 0
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async () => { traces++ })
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => { traces++ })
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected tracing export') })
  const f = fixture(), prepare = f.options.prepare
  f.options.prepare = async () => {
    assert.equal(AsyncLocalStorageProviderSingleton.getInstance().getStore(), undefined)
    return prepare()
  }
  const inherited = { tracingEnabled: true, extra: { [Symbol.for('lc:child_config')]: {
    callbacks: [new LangChainTracer(), { name: 'untrusted-ancestor', handleChainStart: () => { callbacks++ } }],
  } } }
  const result = await AsyncLocalStorageProviderSingleton.getInstance().run(inherited, () =>
    runStoryboardPlanningWorkflow(f.control, f.options))
  assert.equal(result.directing_review!.status, 'passed')
  assert.equal(requests, 0); assert.equal(callbacks, 0); assert.equal(traces, 0)
})
