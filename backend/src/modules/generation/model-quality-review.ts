import { reportModelResult, withModelOperationStage, type ModelOperationStage } from './model-result-observation.js'

/** Run only an actual independent quality check here. Structure-only or
 * skipped reviews must never be promoted to a passed business result. */
export async function observeModelQualityReview<T>(stage: ModelOperationStage, review: () => Promise<T>, options: {
  issues(error: unknown): readonly string[] | undefined; previousIssues?: readonly string[]
}): Promise<T> {
  return withModelOperationStage(stage, async () => {
    const result = (ids: readonly string[] | undefined) => {
      const before = options.previousIssues && new Set(options.previousIssues)
      const after = ids && new Set(ids)
      reportModelResult({ phase: 'quality', status: after ? after.size ? 'needs_work' : 'passed' : 'inconclusive',
        ...(after ? { issue_count: after.size } : {}), ...(before ? { repaired: true } : {}),
        ...(before && after ? { repair_effect: [...after].some(id => !before.has(id)) ? 'regressed' as const
          : after.size < before.size ? 'improved' as const : 'unchanged' as const } : {}) })
    }
    try { const value = await review(); result([]); return value }
    catch (error) { result(options.issues(error)); throw error }
  })
}
