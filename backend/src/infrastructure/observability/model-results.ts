export const modelOperationStages = ['outline_generation', 'outline_review', 'shot_expansion', 'format_correction', 'director_review',
  'content_repair', 'repair_scope_review', 'recheck', 'script_outline', 'script_characters', 'script_locations', 'script_props', 'script_episode', 'script_review',
  'source_analysis', 'source_review', 'visual_organization', 'prompt_optimization', 'prompt_review', 'image_understanding',
  'video_understanding', 'continuity_review', 'canvas_adjustment', 'image_generation', 'video_generation', 'speech_generation'] as const
export type ModelOperationStage = typeof modelOperationStages[number]
export const modelOperationStageLabels: Record<ModelOperationStage, string> = {
  outline_generation: '大纲生成', outline_review: '大纲校验', shot_expansion: '镜头扩写', format_correction: '格式修正', director_review: '导演复核',
  content_repair: '内容修复', repair_scope_review: '修复范围复核', recheck: '修复复查', script_outline: '剧本大纲', script_characters: '人物设计', script_locations: '场景设计',
  script_props: '道具设计', script_episode: '分集正文', script_review: '剧本复核', source_analysis: '原稿分析', source_review: '原稿复核',
  visual_organization: '视觉设定整理', prompt_optimization: '提示词优化', prompt_review: '提示词复核', image_understanding: '图片理解',
  video_understanding: '视频理解', continuity_review: '连续性复核', canvas_adjustment: '画布调整', image_generation: '图片生成',
  video_generation: '视频生成', speech_generation: '语音生成',
}
export type ModelResultStatus = 'valid' | 'invalid_json' | 'invalid_contract' | 'invalid_business' | 'passed' | 'needs_work' | 'inconclusive'
export type ModelResultEvent = { phase: 'structure' | 'quality'; status: ModelResultStatus; stage?: ModelOperationStage;
  issue_count?: number; repaired?: boolean; repair_effect?: 'improved' | 'unchanged' | 'regressed'; duration_ms?: number;
  unit_index?: number; unit_count?: number }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
/** Construct only fixed diagnostics. Creative text and caller-provided metadata
 * never cross this observation boundary. */
export function safeModelResult(value: unknown): ModelResultEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const item = value as ModelResultEvent
  const allowed = item.phase === 'structure' ? ['valid', 'invalid_json', 'invalid_contract', 'invalid_business']
    : item.phase === 'quality' ? ['passed', 'needs_work', 'inconclusive'] : []
  if (!allowed.includes(item.status)) return
  const event: ModelResultEvent = { phase: item.phase, status: item.status }
  if (modelOperationStages.includes(item.stage as ModelOperationStage)) event.stage = item.stage
  for (const key of ['issue_count', 'duration_ms', 'unit_index', 'unit_count'] as const) if (integer(item[key])) event[key] = item[key]
  if (typeof item.repaired === 'boolean') event.repaired = item.repaired
  if (['improved', 'unchanged', 'regressed'].includes(String(item.repair_effect))) event.repair_effect = item.repair_effect
  return event
}

/** Code-owned contract names select diagnostics only, never a model/policy. */
export function modelContractStage(name?: string): ModelOperationStage | undefined {
  const fixed: Record<string, ModelOperationStage> = { storyboard_scene_plan: 'outline_generation', storyboard_shot_batch: 'shot_expansion',
    storyboard_directing_review: 'director_review', storyboard_outline_review: 'outline_review', storyboard_targeted_repair: 'content_repair', storyboard_repair_scope_review: 'repair_scope_review',
    prompt_refinement_semantic_review: 'prompt_review', refined_prompt: 'prompt_optimization', image_prompt_optimization: 'prompt_optimization',
    asset_prompt: 'prompt_optimization', canvas_node_proposal: 'canvas_adjustment', video_review: 'video_understanding',
    continuity_report: 'continuity_review', video_prompt_analysis: 'video_understanding', visual_profiles: 'visual_organization' }
  if (name && Object.hasOwn(fixed, name)) return fixed[name]
  if (name?.startsWith('script_source_')) return /quality|review/.test(name) ? 'source_review' : 'source_analysis'
  if (name === 'script_review' || name === 'script_document_review' || name === 'script_draft_review_grouping') return 'script_review'
  return undefined
}
