import { AsyncLocalStorage } from 'node:async_hooks'

export type ModelRecovery = 'atomic' | 'units' | 'tool' | 'paid'
export type ModelTaskPolicy = Readonly<{
  purpose: string; outputTokens?: number; minimumOutputTokens?: number
  readOnly: boolean; recovery: ModelRecovery
}>
export type ModelUnitProgress = Readonly<{ phase_id: string; label: string; completed_units: number; total_units: number | null }>
export type ModelRequestContext = Readonly<{
  policy: ModelTaskPolicy; taskId?: string; stepId?: string; attemptId?: string
  signal?: AbortSignal; onProgress?: (progress: ModelUnitProgress) => void; onDispatch?: (metrics: unknown) => void; onMetrics?: (metrics: unknown) => void
}>
const context = new AsyncLocalStorage<ModelRequestContext>()
export const currentModelRequestContext = () => context.getStore()
export function reportModelUnitProgress(progress: ModelUnitProgress) {
  if (!progress.phase_id || !progress.label || !Number.isSafeInteger(progress.completed_units) || progress.completed_units < 0 ||
    progress.total_units !== null && (!Number.isSafeInteger(progress.total_units) || progress.total_units < progress.completed_units)) throw new Error('业务单元进度无效')
  currentModelRequestContext()?.onProgress?.({ ...progress, phase_id: progress.phase_id.slice(0, 100), label: progress.label.slice(0, 160) })
}
export function withModelRequestContext<T>(value: ModelRequestContext, work: () => T): T {
  return context.run(value, work)
}
export const modelTaskPolicies = {
  generation: { purpose: 'generation', outputTokens: 65536, minimumOutputTokens: 8192, readOnly: true, recovery: 'units' },
  review: { purpose: 'review', outputTokens: 32768, minimumOutputTokens: 4096, readOnly: true, recovery: 'units' },
  decision: { purpose: 'classification', outputTokens: 4096, minimumOutputTokens: 1024, readOnly: true, recovery: 'atomic' },
  prompt: { purpose: 'prompt', outputTokens: 16384, minimumOutputTokens: 2048, readOnly: true, recovery: 'atomic' },
  tool: { purpose: 'tool_decision', outputTokens: 16384, minimumOutputTokens: 2048, readOnly: true, recovery: 'tool' },
  text: { purpose: 'text', outputTokens: 8192, minimumOutputTokens: 1024, readOnly: true, recovery: 'atomic' },
  paid: { purpose: 'media_generation', readOnly: false, recovery: 'paid' },
} as const satisfies Record<string, ModelTaskPolicy>

/** An explicit compatibility map for existing callers. New operations pass a
 * policy directly; renaming a contract cannot change an explicit policy. */
const contracts = new Map<string, ModelTaskPolicy>()
function register(policy: ModelTaskPolicy, names: readonly string[]) {
  for (const name of names) { contracts.set(name, policy); contracts.set(`${name}_page`, policy) }
}
register(modelTaskPolicies.generation, [
  'workflow_draft', 'script_draft', 'script_stage_draft', 'script_stage_blocks', 'complete_script',
  'controlled_storyboard', 'shot_plan', 'clip_storyboard', 'visual_profiles', 'script_stage_artifact_repair',
  'script_stage_scene_repair', 'script_stage_block_repair', 'script_stage_context_exchange', 'script_draft_repair', 'script_draft_repair_decisions',
  'script_draft_repair_edits', 'script_source_story', 'script_source_map', 'script_source_evidence_repair',
  'script_source_quality_repair', 'script_source_story_overview', 'script_source_story_characters',
  'script_source_story_characters_merge', 'script_source_story_timeline', 'script_source_story_threads',
  'script_source_story_uncertainties', 'video_prompt_analysis',
])
register(modelTaskPolicies.review, [
  'script_draft_completeness', 'script_draft_review_grouping', 'script_review', 'script_source_quality',
  'script_draft_evidence_repair', 'script_finding_groups', 'script_document_review', 'video_review',
  'continuity_report', 'storyboard_directing_review', 'prompt_refinement_semantic_review', 'video_prompt_content_review',
])
register(modelTaskPolicies.decision, [
  'resource_authorization', 'generation_authorization', 'draft_approval', 'script_intent', 'theme_visuals',
  'reply_classification', 'creation_skill_selection', 'creation_skill_reference_selection',
  'script_chat_source_scope', 'script_repair_selection', 'tool_context_checkpoint',
])
register(modelTaskPolicies.prompt, ['refined_prompt', 'image_prompt_optimization', 'asset_prompt', 'canvas_node_proposal', 'video_handoff_plan'])
export function resolveModelTaskPolicy(contractName?: string): ModelTaskPolicy {
  return currentModelRequestContext()?.policy ?? (contractName ? contracts.get(contractName) : undefined) ?? modelTaskPolicies.text
}
export function modelContextFor(contractName?: string, explicit?: ModelRequestContext): ModelRequestContext {
  const inherited = currentModelRequestContext()
  if (explicit) return { ...inherited, ...explicit }
  // Keep task identity, but a nested classification/review has its own purpose.
  return { ...inherited, policy: contractName && contracts.has(contractName) ? contracts.get(contractName)! : inherited?.policy ?? modelTaskPolicies.text }
}
