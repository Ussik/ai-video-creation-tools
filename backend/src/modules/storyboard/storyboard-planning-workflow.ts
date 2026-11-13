import { CallbackManager } from '@langchain/core/callbacks/manager'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { StoryboardPlanningResult } from '@video-studio/shared/storyboard/storyboard-planning-types'
import { isStoryboardPlanningBudgetError } from './storyboard-planning-budget.js'
import type { StoryboardPlanningControl } from './storyboard-planning-tasks.js'

const PlanningGraphState = Annotation.Root({
  needsRepair: Annotation<boolean>({ reducer: (_current, next) => next, default: () => false }),
  repaired: Annotation<boolean>({ reducer: (_current, next) => next, default: () => false }),
  completed: Annotation<boolean>({ reducer: (_current, next) => next, default: () => false }),
})

/** Core 1.3.4 clears a disabled tracing context while advancing graph streams.
 * Supply a local tracer explicitly so environment flags cannot install a cloud
 * exporter. This instance never posts runs or creates a tracing parent; copies
 * must remain local too. Existing Langfuse observation owns all telemetry. */
class LocalPlanningGraphTracer extends LangChainTracer {
  override async onRunCreate() {}
  override async onRunUpdate() {}
  override getRunTreeWithTracingConfig(_id: string) { return undefined }
  override updateFromRunTree() {}
  override copyWithTracingConfig() { return this }
}

/** Each accepted stage is durable before the next paid request. Recovery
 * revalidates the existing task checkpoints. The graph only routes stages;
 * it owns neither a second checkpoint store nor model retries. */
export async function runStoryboardPlanningWorkflow<Preparation, Candidate, Report>(control: StoryboardPlanningControl, options: {
  prepare(): Promise<Preparation>; restorePreparation(value: unknown): Preparation
  generate(preparation: Preparation): Promise<Candidate>; restoreCandidate(value: unknown): Candidate
  serializeCandidate?(candidate: Candidate): unknown
  review(candidate: Candidate): Promise<Report>; restoreReport(value: unknown, candidate: Candidate): Report
  inconclusive?(preparation: Preparation, candidate: Candidate, repaired: boolean, error: unknown, report?: Report): StoryboardPlanningResult
  hasErrors(report: Report): boolean
  repair(preparation: Preparation, candidate: Candidate, report: Report): Promise<Candidate>
  projection(preparation: Preparation, candidate: Candidate, repaired: boolean): StoryboardPlanningResult
  finish(preparation: Preparation, candidate: Candidate, report: Report, repaired: boolean): StoryboardPlanningResult
}) {
  const { steps } = control
  const assertActive = () => control.signal.throwIfAborted()
  let preparation: Preparation, candidate: Candidate, report: Report, result: StoryboardPlanningResult | undefined
  const recoverReview = (error: unknown, repaired: boolean, previousReport?: Report) => {
    if (control.signal.aborted || isStoryboardPlanningBudgetError(error) || (error as { statusCode?: number })?.statusCode === 409 || !options.inconclusive) throw error
    result = options.inconclusive(preparation, candidate, repaired, error, previousReport)
    return { completed: true }
  }
  const graph = new StateGraph(PlanningGraphState)
    .addNode('prepare', async () => {
      assertActive()
      if ('preparation' in steps) preparation = options.restorePreparation(steps.preparation)
      else {
        control.stage('preparing'); preparation = await options.prepare(); assertActive()
        control.retain('preparation', preparation)
      }
      return {}
    })
    .addNode('generate', async () => {
      assertActive()
      if ('candidate' in steps) candidate = options.restoreCandidate(steps.candidate)
      else {
        control.stage('generating'); candidate = await options.generate(preparation); assertActive()
        control.retain('candidate', options.serializeCandidate?.(candidate) ?? candidate, options.projection(preparation, candidate, false))
      }
      return {}
    })
    .addNode('review', async () => {
      assertActive()
      if ('report' in steps) report = options.restoreReport(steps.report, candidate)
      else {
        control.stage('reviewing')
        try { report = await options.review(candidate); assertActive(); control.retain('report', report) }
        catch (error) { return recoverReview(error, false) }
      }
      return { needsRepair: options.hasErrors(report) }
    })
    .addNode('repair', async () => {
      assertActive()
      if ('revised_candidate' in steps) candidate = options.restoreCandidate(steps.revised_candidate)
      else {
        control.stage('repairing')
        try {
          candidate = await options.repair(preparation, candidate, report); assertActive()
          control.retain('revised_candidate', options.serializeCandidate?.(candidate) ?? candidate, options.projection(preparation, candidate, true))
        } catch (error) { return recoverReview(error, false, report) }
      }
      return { repaired: true }
    })
    .addNode('recheck', async () => {
      assertActive()
      if ('revised_report' in steps) report = options.restoreReport(steps.revised_report, candidate)
      else {
        control.stage('rechecking')
        try { report = await options.review(candidate); assertActive(); control.retain('revised_report', report) }
        catch (error) { return recoverReview(error, true, report) }
      }
      return {}
    })
    .addNode('finish', state => {
      assertActive()
      if (!state.completed) result = options.finish(preparation, candidate, report, state.repaired)
      return { completed: true }
    })
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'generate')
    .addEdge('generate', 'review')
    .addConditionalEdges('review', state => !state.completed && state.needsRepair ? 'repair' : 'finish', ['repair', 'finish'])
    .addConditionalEdges('repair', state => state.completed ? 'finish' : 'recheck', ['finish', 'recheck'])
    .addEdge('recheck', 'finish')
    .addEdge('finish', END)
    .compile()
  assertActive()
  const callbacks = new CallbackManager()
  callbacks.addHandler(new LocalPlanningGraphTracer(), true)
  // Clear inherited runnable metadata and handlers for this invocation only.
  // Business checkpoints and results stay outside the graph's boolean state.
  await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
    graph.invoke({}, { signal: control.signal, recursionLimit: 8, callbacks }))
  assertActive()
  if (!result) throw new Error('分镜规划流程未返回结果')
  return result
}
