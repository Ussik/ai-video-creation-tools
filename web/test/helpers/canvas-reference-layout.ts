import type { CanvasPreparationRecovery, CanvasPreparationSnapshot, Model, ProjectDetail } from '../../src/shared/api/api'

export const referenceLayoutStates = ['idle', 'preparing', 'running', 'unknown', 'partial', 'complete', 'stale', 'error', 'cancelling', 'limited'] as const
export type ReferenceLayoutState = typeof referenceLayoutStates[number]
export const layoutSignature = 'a'.repeat(64)
export const layoutModels = [{ id: 'layout-model', name: '离线文本模型', modality: 'text', enabled: true, is_default: true }] as Model[]
const scene = { id: 'scene', episode_number: 1, heading: '雨夜钟表铺', duration: 15 }
const shot = { id: 'shot', shot_id: 'shot', source_scene_id: 'scene', scene_id: 'scene', design_id: null, deleted_at: null, superseded_by: null,
  title: '推门入店', prompt: '林晚推门进入钟表铺', image_prompt: '林晚站在钟表铺门口', video_prompt: '林晚推门进入钟表铺', duration: 15, start_state: '门外', end_state: '柜台前', cut_note: '' }
export const layoutDetail = { id: 'layout-project', name: '状态布局隔离验收', brief: '雨夜探店', ratio: '9:16', script: { outline: '雨夜探店', characters: '林晚', scenes: [scene], artifacts: [] }, shots: [shot], jobs: [], assets: [] } as unknown as ProjectDetail
export const layoutContext = { signature: layoutSignature, scenes: [{ ...scene, planned: true, shot_count: 1, material_count: 0 }], documents: [], skills: [], default_skill_ids: [], existing_shots: [shot], project: { name: '状态布局隔离验收', style: '日漫风格' },
  reference_preparation: { signature: layoutSignature, scene_ids: ['scene'], needs_analysis: ['scene'], default_skill_ids: [], skill_policy: { stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] } } }

export function layoutSnapshot(state: ReferenceLayoutState): CanvasPreparationSnapshot {
  const caps: CanvasPreparationRecovery = { run_id: 'layout-run', state: state === 'running' || state === 'cancelling' ? 'running' : state === 'unknown' ? 'unknown' : state === 'partial' || state === 'limited' ? 'partial' : state === 'complete' || state === 'stale' ? 'complete' : 'idle',
    model_id: 'layout-model', full_scope: state === 'complete' || state === 'stale', can_retry_failed: state === 'partial', retry_reason: '仅补齐未完成的参考', retryable_unit_keys: state === 'partial' ? ['prop'] : [],
    can_continue: state === 'idle' || state === 'preparing', continue_reason: '按当前范围继续', pending_unit_keys: [], can_restart_all: state === 'partial' || state === 'complete', restart_reason: '本次运行状态需核对', requires_confirmation: false,
    budget: { task_requests: 15, task_max_requests: 512, run_requests: 15, run_max_requests: 256, runs: 1, max_runs: 3 },
    inspection: { executor: state === 'running' || state === 'cancelling' ? 'active' : 'none', owner_request_id: 'layout-owner', can_cancel: state === 'running', cancel_requested: state === 'cancelling', can_abandon: false, unresolved_responses: state === 'unknown' ? 1 : 0, pending_requests: state === 'running' ? 1 : 0, message: '',
      ...(state === 'running' || state === 'cancelling' ? { progress: { label: '整理人物和道具', completed_units: 3, total_units: 5 } } : {}) } }
  if (state === 'stale') caps.adoption = { can_adopt: false, source_matches: false, reason: '当前分镜已更新', completed_profiles: 15, missing_shot_ids: [], can_prepare_current: true, can_discard: true, discarded: false }
  const profile = { draft_key: 'character', kind: 'character' as const, name: '林晚', variant: '默认', definition: '短黑发，深蓝外衣，携带铜钥匙。', view_requirements: '正侧背', scene_ids: ['scene'] }
  const retained_plan = { signature: 'b'.repeat(64), scene_ids: ['scene'], profiles: Array.from({ length: 15 }, (_, i) => ({ ...profile, draft_key: 'old-' + i, name: i === 0 ? '林晚' : '旧参考' + (i + 1) })) }
  const plan = state === 'complete' || state === 'partial' || state === 'limited' ? { signature: layoutSignature, scene_ids: ['scene'], profiles: [profile], preparation: caps,
    ...(state === 'partial' ? { status: 'partial' as const, failed_units: [{ unit_key: 'prop', name: '铜钥匙', variant: '默认', code: 'visual_profile_locked_field_changed', message: '一次受限纠正未完成', retryable: false, recovery_type: 'blocked' as const, checkpoint_source: 'original_raw' as const, is_new_model_call: false, attempt: 1, recovery: { action: 'retry' as const, model_call: 'required' as const, token: 'c'.repeat(64) } }] } : {}) } : undefined
  if (state === 'limited' && plan) {
    plan.profiles = Array.from({ length: 3 }, (_, i) => ({ ...profile, draft_key: 'current-' + i, name: ['林晚', '钟表铺', '铜钥匙'][i]! }))
    Object.assign(plan, { status: 'partial', failed_units: [{ unit_key: '@appearance:shot', stage: 'coverage', name: '镜头「锁链无声」用途仲裁', code: 'visual_coverage_evidence_noncontiguous', message: 'image_prompt证据拼接了不连续原文，省略了中间内容；请选择一个连续逐字证据ID，不能拼接。', retryable: false, recovery_type: 'blocked', checkpoint_source: 'original_raw', is_new_model_call: false, attempt: 4, model_request_count: 4, local_validation_count: 5, recovery: { action: 'none', model_call: 'none', reason: '本镜头已发生 4/4 次实际模型请求，达到上限；保留全部档案及原答。' } }] })
    caps.continue_reason = '本镜头已发生 4/4 次实际模型请求，达到上限；保留全部档案及原答。'
  }
  return { signature: layoutSignature, scene_ids: ['scene'], preparation: caps, retained_plan, ...(plan ? { plan } : {}) }
}
