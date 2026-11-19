import type { TextInputScopeDiagnostics } from '../providers/text-input-scope.js'
export const modelOperationStages = ['dialogue_source_correction', 'timing_repair', 'outline_generation', 'outline_review', 'shot_expansion', 'format_correction', 'director_review',
  'content_repair', 'repair_scope_review', 'recheck', 'script_outline', 'script_characters', 'script_locations', 'script_props', 'script_episode', 'script_review',
  'source_analysis', 'source_directory', 'source_synthesis', 'source_characters', 'source_timeline', 'source_threads', 'source_uncertainties', 'source_review', 'visual_organization', 'prompt_optimization', 'prompt_review', 'image_understanding',
  'video_understanding', 'continuity_review', 'canvas_adjustment', 'image_generation', 'video_generation', 'speech_generation'] as const
export type ModelOperationStage = typeof modelOperationStages[number]
export const modelOperationStageLabels: Record<ModelOperationStage, string> = {
  dialogue_source_correction: '台词来源纠正', timing_repair: '时长校正', outline_generation: '大纲生成', outline_review: '大纲校验', shot_expansion: '镜头扩写', format_correction: '格式修正', director_review: '导演复核',
  content_repair: '内容修复', repair_scope_review: '修复范围复核', recheck: '修复复查', script_outline: '剧本大纲', script_characters: '人物设计', script_locations: '场景设计',
  script_props: '道具设计', script_episode: '分集正文', script_review: '剧本复核', source_analysis: '原稿分析', source_directory: '目录分析', source_synthesis: '全剧整合', source_characters: '人物整合',
  source_timeline: '事件整合', source_threads: '伏笔整合', source_uncertainties: '不确定事项整合', source_review: '原稿复核',
  visual_organization: '视觉设定整理', prompt_optimization: '提示词优化', prompt_review: '提示词复核', image_understanding: '图片理解',
  video_understanding: '视频理解', continuity_review: '连续性复核', canvas_adjustment: '画布调整', image_generation: '图片生成',
  video_generation: '视频生成', speech_generation: '语音生成',
}
export type ModelResultStatus = 'valid' | 'invalid_json' | 'invalid_contract' | 'invalid_business' | 'passed' | 'needs_work' | 'inconclusive'
export type StructuralChangeEvent = { source: 'patch_merge' | 'schema_normalization' | 'business_validation'; field_path: string; before_hash: string; after_hash: string }
export type ModelResultEvent = Partial<TextInputScopeDiagnostics> & { cache_hit?: boolean; local_reuse?: boolean; final_state?: 'needs_confirmation' | 'ready' | 'provider_rejected'; structural_changes?: StructuralChangeEvent[]; phase: 'structure' | 'quality'; status: ModelResultStatus; stage?: ModelOperationStage;
  scene_id?: string; shot_id?: string; field_path?: string;
  business_result?: 'generated'; review_status?: 'passed' | 'warnings' | 'needs_work' | 'review_inconclusive_no_action' | 'review_inconclusive_needs_user';
  issue_count?: number; repaired?: boolean; repair_effect?: 'improved' | 'unchanged' | 'regressed'; duration_ms?: number;
  first_pass_status?: ModelResultStatus; repair_count?: number; repaired_units?: string[];
  validation_latency_ms?: number; repair_latency_ms?: number; structured_enforcement?: string;
  json_error_position?: number; json_error_line?: number; json_error_column?: number;
  repair_strategy?: string; repair_applied?: boolean; root_object_detected?: boolean;
  input_tokens_before_repair?: number; input_tokens_after_repair?: number;
  unit_index?: number; unit_count?: number; failure_code?: string; evidence_ref_ids?: string[]; evidence_fields?: string[];
  evidence_validation?: 'passed' | 'failed'; scene_duration?: number; shot_duration_sum?: number; delta?: number; started_at_ms?: number; ended_at_ms?: number;
  task_key?: string; section_ids?: number[]; field_paths?: string[]; schema_issue_codes?: string[]; correction_items?: number; reused_items?: number;
  task_id?: string; unit_key?: string; checkpoint_source?: 'original_raw' | 'correction' | 'validated_unit' | 'none'; is_new_model_call?: boolean;
  recovery_type?: 'local_migration' | 'unit_resume' | 'partial_batch' | 'blocked' | 'none'; model_request_count?: number; local_validation_count?: number; attempt?: number;
  input_source_chars?: number; input_index_chars?: number; evidence_expanded?: boolean; repair_type?: 'syntax_insertions' | 'local_fields' | 'local_reuse';
  recovery_action?: 'started' | 'response_saved' | 'stopped' | 'boundary_transfer'; recovery_error_type?: 'format' | 'reference';
  recovery_attempts?: number; recovery_input_chars?: number; recovery_output_chars?: number;
  request_category?: 'full_source' | 'targeted' | 'local_patch' | 'local_reuse' }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
const signedInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= -1_000_000_000 && Number(value) <= 1_000_000_000
/** Construct only fixed diagnostics. Creative text and caller-provided metadata
 * never cross this observation boundary. */
export function safeModelResult(value: unknown): ModelResultEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const item = value as ModelResultEvent
  const allowed = item.phase === 'structure' ? ['valid', 'invalid_json', 'invalid_contract', 'invalid_business']
    : item.phase === 'quality' ? ['passed', 'needs_work', 'inconclusive'] : []
  if (!allowed.includes(item.status)) return
  const event: ModelResultEvent = { phase: item.phase, status: item.status }
  for (const key of ['input_scene_count', 'input_shot_count', 'input_scope_chars', 'input_rules_chars', 'input_facts_chars', 'input_profiles_chars', 'input_original_chars', 'input_transport_chars', 'input_transport_estimated_tokens'] as const) if (integer(item[key])) event[key] = item[key]
  if (typeof item.input_schema_hash === 'string' && /^[a-f0-9]{64}$/.test(item.input_schema_hash)) event.input_schema_hash = item.input_schema_hash
  if (typeof item.input_schema_present === 'boolean') event.input_schema_present = item.input_schema_present
  if (typeof item.input_scope_hash === 'string' && /^[a-f0-9]{64}$/.test(item.input_scope_hash)) event.input_scope_hash = item.input_scope_hash
  if (['catalog', 'profile', 'coverage'].includes(String(item.input_scope_stage))) event.input_scope_stage = item.input_scope_stage
  if (item.input_boundary === 'assembly' || item.input_boundary === 'transport') event.input_boundary = item.input_boundary
  if (typeof item.input_scope_present === 'boolean') event.input_scope_present = item.input_scope_present
  if (item.business_result === 'generated') event.business_result = item.business_result
  if (['passed', 'warnings', 'needs_work', 'review_inconclusive_no_action', 'review_inconclusive_needs_user'].includes(item.review_status || '')) event.review_status = item.review_status
  if (modelOperationStages.includes(item.stage as ModelOperationStage)) event.stage = item.stage
  for (const key of ['issue_count', 'duration_ms', 'repair_count', 'validation_latency_ms', 'repair_latency_ms', 'json_error_position', 'json_error_line', 'json_error_column', 'input_tokens_before_repair', 'input_tokens_after_repair', 'unit_index', 'unit_count'] as const) if (integer(item[key])) event[key] = item[key]
  for (const key of ['scene_duration', 'shot_duration_sum'] as const) if (integer(item[key])) event[key] = item[key]
  if (signedInteger(item.delta)) event.delta = item.delta
  if (['valid', 'invalid_json', 'invalid_contract', 'invalid_business', 'passed', 'needs_work', 'inconclusive'].includes(String(item.first_pass_status))) event.first_pass_status = item.first_pass_status
  if (Array.isArray(item.repaired_units)) { const values = item.repaired_units.filter(value => typeof value === 'string' && /^[a-z0-9_.:-]{1,160}$/i.test(value)).slice(0, 64); if (values.length) event.repaired_units = [...new Set(values)] }
  if (typeof item.structured_enforcement === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(item.structured_enforcement)) event.structured_enforcement = item.structured_enforcement
  if (typeof item.repair_strategy === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(item.repair_strategy)) event.repair_strategy = item.repair_strategy
  if (typeof item.repair_applied === 'boolean') event.repair_applied = item.repair_applied
  for (const key of ['cache_hit', 'local_reuse'] as const) if (typeof item[key] === 'boolean') event[key] = item[key]
  if (['needs_confirmation', 'ready', 'provider_rejected'].includes(String(item.final_state))) event.final_state = item.final_state
  if (typeof item.root_object_detected === 'boolean') event.root_object_detected = item.root_object_detected
  for (const key of ['started_at_ms', 'ended_at_ms'] as const) if (Number.isSafeInteger(item[key]) && Number(item[key]) >= 0) event[key] = item[key]
  for (const key of ['model_request_count', 'local_validation_count', 'correction_items', 'reused_items', 'input_source_chars', 'input_index_chars'] as const) if (integer(item[key])) event[key] = item[key]
  if (Array.isArray(item.structural_changes)) event.structural_changes = item.structural_changes.filter(change => change &&
    ['patch_merge', 'schema_normalization', 'business_validation'].includes(change.source) &&
    typeof change.field_path === 'string' && change.field_path.length <= 150 && /^\$(?:\.[a-zA-Z_][a-zA-Z_0-9]*|\[\d+\])*$/.test(change.field_path) &&
    /^[a-f0-9]{64}$/.test(change.before_hash) && /^[a-f0-9]{64}$/.test(change.after_hash)).slice(0, 32)
    .map(({ source, field_path, before_hash, after_hash }) => ({ source, field_path, before_hash, after_hash }))
  if (typeof item.task_key === 'string' && /^(?:directory|overview|characters|characters_merge|timeline|threads|uncertainties)(?::[a-f0-9]+)?(?:\/coverage:\d+)?$/.test(item.task_key)) event.task_key = item.task_key
  if (typeof item.task_id === 'string' && /^[a-z0-9_.:-]{1,160}$/i.test(item.task_id)) event.task_id = item.task_id
  if (typeof item.unit_key === 'string' && /^(?:[a-z0-9_.:-]{1,160}|@appearance:[a-z0-9_.:-]{1,100}|@visual-coverage)$/i.test(item.unit_key)) event.unit_key = item.unit_key
  if (['original_raw', 'correction', 'validated_unit', 'none'].includes(item.checkpoint_source || '')) event.checkpoint_source = item.checkpoint_source
  if (typeof item.is_new_model_call === 'boolean') event.is_new_model_call = item.is_new_model_call
  if (['local_migration', 'unit_resume', 'partial_batch', 'blocked', 'none'].includes(item.recovery_type || '')) event.recovery_type = item.recovery_type
  if (integer(item.attempt)) event.attempt = item.attempt
  if (Array.isArray(item.section_ids) && item.section_ids.length <= 1000 && item.section_ids.every(integer)) event.section_ids = item.section_ids
  if (typeof item.failure_code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(item.failure_code)) event.failure_code = item.failure_code
  if (Array.isArray(item.schema_issue_codes)) event.schema_issue_codes = [...new Set(item.schema_issue_codes.filter(code => ['invalid_type', 'invalid_value', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'custom'].includes(code)))].slice(0, 16)
  if (Array.isArray(item.field_paths)) event.field_paths = item.field_paths.filter(path => typeof path === 'string' && path.length <= 150 && /^(?:\$(?:\.[a-zA-Z_][a-zA-Z_0-9]*|\[\d+\])*|[a-zA-Z_][a-zA-Z_0-9.\[\]]{0,149})$/.test(path)).slice(0, 100)
  if (['full_source', 'targeted', 'local_patch', 'local_reuse'].includes(item.request_category || '')) event.request_category = item.request_category
  if (typeof item.evidence_expanded === 'boolean') event.evidence_expanded = item.evidence_expanded
  if (['syntax_insertions', 'local_fields', 'local_reuse'].includes(item.repair_type || '')) event.repair_type = item.repair_type
  if (['started', 'response_saved', 'stopped', 'boundary_transfer'].includes(item.recovery_action || '')) event.recovery_action = item.recovery_action
  if (['format', 'reference'].includes(item.recovery_error_type || '')) event.recovery_error_type = item.recovery_error_type
  for (const key of ['recovery_attempts', 'recovery_input_chars', 'recovery_output_chars'] as const) if (integer(item[key])) event[key] = item[key]
  if (typeof item.repaired === 'boolean') event.repaired = item.repaired
  if (['improved', 'unchanged', 'regressed'].includes(String(item.repair_effect))) event.repair_effect = item.repair_effect
  for (const key of ['scene_id', 'shot_id', 'field_path'] as const) if (typeof item[key] === 'string' && /^[a-z0-9_.:-]{1,180}$/i.test(item[key])) event[key] = item[key]
  if (typeof item.failure_code === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(item.failure_code)) event.failure_code = item.failure_code
  for (const key of ['evidence_ref_ids', 'evidence_fields'] as const) if (Array.isArray(item[key])) {
    const values = item[key].filter(value => typeof value === 'string' && /^[a-z0-9_.:-]{1,160}$/i.test(value)).slice(0, 64)
    if (values.length) event[key] = [...new Set(values)]
  }
  if (item.evidence_validation === 'passed' || item.evidence_validation === 'failed') event.evidence_validation = item.evidence_validation
  return event
}

/** Code-owned contract names select diagnostics only, never a model/policy. */
export function modelContractStage(name?: string): ModelOperationStage | undefined {
  const fixed: Record<string, ModelOperationStage> = { storyboard_scene_plan: 'outline_generation', storyboard_shot_batch: 'shot_expansion',
    storyboard_directing_review: 'director_review', storyboard_outline_review: 'outline_review', storyboard_targeted_repair: 'content_repair', storyboard_repair_scope_review: 'repair_scope_review',
    prompt_refinement_semantic_review: 'prompt_review', refined_prompt: 'prompt_optimization', image_prompt_optimization: 'prompt_optimization',
    asset_prompt: 'prompt_optimization', script_source_map_boundary_repair: 'content_repair', script_source_story_character_repair: 'content_repair', canvas_node_proposal: 'canvas_adjustment', video_review: 'video_understanding',
    continuity_report: 'continuity_review', video_prompt_analysis: 'video_understanding', visual_profiles: 'visual_organization', visual_profile_content: 'visual_organization', visual_profile_usage: 'visual_organization', visual_profile_catalog: 'visual_organization', visual_reference_coverage: 'visual_organization' }
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
