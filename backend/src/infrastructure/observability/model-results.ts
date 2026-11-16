export const modelOperationStages = ['outline_generation', 'outline_review', 'shot_expansion', 'format_correction', 'director_review',
  'content_repair', 'repair_scope_review', 'recheck', 'script_outline', 'script_characters', 'script_locations', 'script_props', 'script_episode', 'script_review',
  'source_analysis', 'source_directory', 'source_synthesis', 'source_characters', 'source_timeline', 'source_threads', 'source_uncertainties', 'source_review', 'visual_organization', 'prompt_optimization', 'prompt_review', 'image_understanding',
  'video_understanding', 'continuity_review', 'canvas_adjustment', 'image_generation', 'video_generation', 'speech_generation'] as const
export type ModelOperationStage = typeof modelOperationStages[number]
export const modelOperationStageLabels: Record<ModelOperationStage, string> = {
  outline_generation: '大纲生成', outline_review: '大纲校验', shot_expansion: '镜头扩写', format_correction: '格式修正', director_review: '导演复核',
  content_repair: '内容修复', repair_scope_review: '修复范围复核', recheck: '修复复查', script_outline: '剧本大纲', script_characters: '人物设计', script_locations: '场景设计',
  script_props: '道具设计', script_episode: '分集正文', script_review: '剧本复核', source_analysis: '原稿分析', source_directory: '目录分析', source_synthesis: '全剧整合', source_characters: '人物整合',
  source_timeline: '事件整合', source_threads: '伏笔整合', source_uncertainties: '不确定事项整合', source_review: '原稿复核',
  visual_organization: '视觉设定整理', prompt_optimization: '提示词优化', prompt_review: '提示词复核', image_understanding: '图片理解',
  video_understanding: '视频理解', continuity_review: '连续性复核', canvas_adjustment: '画布调整', image_generation: '图片生成',
  video_generation: '视频生成', speech_generation: '语音生成',
}
export type ModelResultStatus = 'valid' | 'invalid_json' | 'invalid_contract' | 'invalid_business' | 'passed' | 'needs_work' | 'inconclusive'
export type ModelResultEvent = { phase: 'structure' | 'quality'; status: ModelResultStatus; stage?: ModelOperationStage;
  issue_count?: number; repaired?: boolean; repair_effect?: 'improved' | 'unchanged' | 'regressed'; duration_ms?: number;
  unit_index?: number; unit_count?: number; started_at_ms?: number; ended_at_ms?: number;
  task_key?: string; section_ids?: number[]; failure_code?: string; field_paths?: string[]; correction_items?: number; reused_items?: number;
  input_source_chars?: number; input_index_chars?: number; evidence_expanded?: boolean; repair_type?: 'syntax_insertions' | 'local_fields' | 'local_reuse';
  recovery_action?: 'started' | 'response_saved' | 'stopped' | 'boundary_transfer'; recovery_error_type?: 'format' | 'reference';
  recovery_attempts?: number; recovery_input_chars?: number; recovery_output_chars?: number;
  request_category?: 'full_source' | 'targeted' | 'local_patch' | 'local_reuse' }
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
  for (const key of ['started_at_ms', 'ended_at_ms'] as const) if (Number.isSafeInteger(item[key]) && Number(item[key]) >= 0) event[key] = item[key]
  for (const key of ['correction_items', 'reused_items', 'input_source_chars', 'input_index_chars'] as const) if (integer(item[key])) event[key] = item[key]
  if (typeof item.task_key === 'string' && /^(?:directory|overview|characters|characters_merge|timeline|threads|uncertainties)(?::[a-f0-9]+)?(?:\/coverage:\d+)?$/.test(item.task_key)) event.task_key = item.task_key
  if (Array.isArray(item.section_ids) && item.section_ids.length <= 1000 && item.section_ids.every(integer)) event.section_ids = item.section_ids
  if (typeof item.failure_code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(item.failure_code)) event.failure_code = item.failure_code
  if (Array.isArray(item.field_paths)) event.field_paths = item.field_paths.filter(path => typeof path === 'string' && /^[a-zA-Z_][a-zA-Z_0-9.\[\]]{0,149}$/.test(path)).slice(0, 100)
  if (['full_source', 'targeted', 'local_patch', 'local_reuse'].includes(item.request_category || '')) event.request_category = item.request_category
  if (typeof item.evidence_expanded === 'boolean') event.evidence_expanded = item.evidence_expanded
  if (['syntax_insertions', 'local_fields', 'local_reuse'].includes(item.repair_type || '')) event.repair_type = item.repair_type
  if (['started', 'response_saved', 'stopped', 'boundary_transfer'].includes(item.recovery_action || '')) event.recovery_action = item.recovery_action
  if (['format', 'reference'].includes(item.recovery_error_type || '')) event.recovery_error_type = item.recovery_error_type
  for (const key of ['recovery_attempts', 'recovery_input_chars', 'recovery_output_chars'] as const) if (integer(item[key])) event[key] = item[key]
  if (typeof item.repaired === 'boolean') event.repaired = item.repaired
  if (['improved', 'unchanged', 'regressed'].includes(String(item.repair_effect))) event.repair_effect = item.repair_effect
  return event
}

/** Code-owned contract names select diagnostics only, never a model/policy. */
export function modelContractStage(name?: string): ModelOperationStage | undefined {
  const fixed: Record<string, ModelOperationStage> = { storyboard_scene_plan: 'outline_generation', storyboard_shot_batch: 'shot_expansion',
    storyboard_directing_review: 'director_review', storyboard_outline_review: 'outline_review', storyboard_targeted_repair: 'content_repair', storyboard_repair_scope_review: 'repair_scope_review',
    prompt_refinement_semantic_review: 'prompt_review', refined_prompt: 'prompt_optimization', image_prompt_optimization: 'prompt_optimization',
    asset_prompt: 'prompt_optimization', script_source_map_boundary_repair: 'content_repair', script_source_story_character_repair: 'content_repair', canvas_node_proposal: 'canvas_adjustment', video_review: 'video_understanding',
    continuity_report: 'continuity_review', video_prompt_analysis: 'video_understanding', visual_profiles: 'visual_organization' }
  if (name && Object.hasOwn(fixed, name)) return fixed[name]
  const sourceName = name?.replace(/_(?:page|structure_repair)$/, '')
  const sourceStages: Record<string, ModelOperationStage> = { script_source_map: 'source_directory', script_source_story: 'source_synthesis',
    script_source_story_overview: 'source_synthesis', script_source_story_characters: 'source_characters', script_source_story_characters_merge: 'source_characters',
    script_source_story_timeline: 'source_timeline', script_source_story_threads: 'source_threads', script_source_story_uncertainties: 'source_uncertainties',
    script_source_quality_repair: 'content_repair', script_source_quality_repair_batch: 'content_repair' }
  if (sourceName && Object.hasOwn(sourceStages, sourceName)) return sourceStages[sourceName]
  if (name?.startsWith('script_source_')) return /quality|review/.test(name) ? 'source_review' : 'source_analysis'
  if (name === 'script_review' || name === 'script_document_review' || name === 'script_draft_review_grouping') return 'script_review'
  return undefined
}
