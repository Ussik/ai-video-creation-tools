import { CallbackManager } from '@langchain/core/callbacks/manager'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'

/** Core 1.3.4 clears a disabled tracing context while advancing graph streams.
 * Supply a local tracer explicitly so environment flags cannot install a cloud
 * exporter. This instance never posts runs or creates a tracing parent; copies
 * must remain local too. Existing Langfuse observation owns all telemetry. */
class LocalModelGraphTracer extends LangChainTracer {
  override async onRunCreate() {}
  override async onRunUpdate() {}
  override getRunTreeWithTracingConfig(_id: string) { return undefined }
  override updateFromRunTree() {}
  override copyWithTracingConfig() { return this }
}

/** Run the actual graph with its native cancellation/recursion guard, while
 * isolating all inherited LangSmith callbacks and metadata per invocation. */
export async function runIsolatedModelGraph<Input, Output>(graph: { invoke(input: Input, config: any): Promise<Output> }, input: Input,
  options: { signal: AbortSignal; recursionLimit: number }): Promise<Output> {
  options.signal.throwIfAborted()
  const callbacks = new CallbackManager()
  callbacks.addHandler(new LocalModelGraphTracer(), true)
  const result = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => graph.invoke(input, { ...options, callbacks }))
  options.signal.throwIfAborted()
  return result
}
