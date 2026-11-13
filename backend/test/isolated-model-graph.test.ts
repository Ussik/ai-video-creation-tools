import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'
import { runIsolatedModelGraph } from '../src/modules/generation/isolated-model-graph.js'
import { reportModelResult, withModelOperationStage, type ModelResultEvent } from '../src/modules/generation/model-result-observation.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'

test('non-storyboard graph preserves local stage results while inherited and environment tracers cannot export', async t => {
  const environment = { LANGCHAIN_TRACING: 'true', LANGCHAIN_TRACING_V2: 'true', LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'fixture-key-never-send', LANGSMITH_ENDPOINT: 'https://fixture.invalid' }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  } })
  let requests = 0, traces = 0, callbacks = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected tracing export') })
  t.mock.method(LangChainTracer.prototype, 'onRunCreate', async () => { traces++ })
  t.mock.method(LangChainTracer.prototype, 'onRunUpdate', async () => { traces++ })
  const outcomes: ModelResultEvent[] = []
  const graph = new StateGraph(Annotation.Root({})).addNode('source_review', async () => {
    assert.equal(AsyncLocalStorageProviderSingleton.getInstance().getStore(), undefined)
    reportModelResult({ phase: 'quality', status: 'passed', issue_count: 0 })
    return {}
  }).addEdge(START, 'source_review').addEdge('source_review', END).compile()
  const inherited = { tracingEnabled: true, extra: { [Symbol.for('lc:child_config')]: {
    callbacks: [new LangChainTracer(), { name: 'ancestor', handleChainStart() { callbacks++ } }],
  } } }
  await AsyncLocalStorageProviderSingleton.getInstance().run(inherited, () => withModelRequestContext({
    policy: modelTaskPolicies.generation, onResult: event => { outcomes.push(event) },
  }, () => withModelOperationStage('source_review', () => runIsolatedModelGraph(graph, {}, { signal: new AbortController().signal, recursionLimit: 3 }))))
  assert.deepEqual(outcomes.map(({ phase, stage, status }) => ({ phase, stage, status })), [{ phase: 'quality', stage: 'source_review', status: 'passed' }])
  assert.equal(requests, 0); assert.equal(traces, 0); assert.equal(callbacks, 0)
})
