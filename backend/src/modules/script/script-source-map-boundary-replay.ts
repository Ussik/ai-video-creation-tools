import type { z } from 'zod'
import { CompletedOutputReplayMiss, generateStructuredOutput, type StructuredGenerator } from '../generation/model-output.js'

/** Probe a code-owned historical request without dispatch or identity changes.
 * Once any reply exists, a later missing/invalid correction is a retained
 * failure, never permission to fall through to a fresh paid request. */
export async function replayCompletedBoundaryPatch<T>(prompt: string, schema: z.ZodType<T>, generate: StructuredGenerator,
  options: { signal: AbortSignal; budgetMs?: number }): Promise<T | undefined> {
  if (!generate.readCompleted) return undefined
  let found = false
  const completed: StructuredGenerator = async () => { throw new Error('历史边界重放禁止模型派发') }
  completed.readCompleted = async (...args) => {
    const value = await generate.readCompleted!(...args)
    if (value !== undefined) found = true
    return value
  }
  try {
    return await generateStructuredOutput('script_source_map_boundary_repair', schema, completed, prompt,
      { ...options, completedOnly: true })
  } catch (error) {
    if (!found && error instanceof CompletedOutputReplayMiss) return undefined
    throw error
  }
}
