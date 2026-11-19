import { generationUnitStore } from '../generation/generation-unit-store.js'
import { creativeInputHash } from '../skills/creative-model-state.js'
import { reportModelResult } from '../generation/model-result-observation.js'

/** Only completed validated object content crosses a source-update run. Exact
 * prompt/contract/model/identity matching excludes changed facts and usages.
 * Raw/unknown responses never enter this cache; explicit refresh bypasses it. */
export async function visualProfileContent<T>(input: {
  projectId: string; identity: unknown; unitKey: string; reuse: boolean;
  validate: (value: unknown) => T; generate: () => Promise<unknown>;
}): Promise<T> {
  const inputHash = creativeInputHash(input.identity)
  const store = generationUnitStore(input.projectId, 'visual-profile-content-cache', { policy: 1, input_hash: inputHash })
  const saved = store.read().steps.content
  if (input.reuse && saved?.input_hash === inputHash) {
    const result = input.validate(structuredClone(saved.value))
    reportModelResult({ stage: 'visual_organization', phase: 'structure', status: 'valid', unit_key: input.unitKey,
      request_category: 'local_reuse', cache_hit: true, local_reuse: true, is_new_model_call: false,
      reused_items: 1, repair_strategy: 'visual_content_exact_input_v1' })
    return result
  }
  reportModelResult({ stage: 'visual_organization', phase: 'structure', status: 'valid', task_id: 'visual_content_cache_check',
    unit_key: input.unitKey, cache_hit: false, is_new_model_call: false, model_request_count: 0,
    repair_strategy: input.reuse ? 'visual_content_input_changed_v1' : 'visual_content_fresh_run_v1' })
  const result = input.validate(await input.generate())
  store.save({ steps: { content: { input_hash: inputHash, value: result } } })
  return result
}
