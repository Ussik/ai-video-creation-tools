import { withTextInputScope } from '../../infrastructure/providers/text-input-scope.js'
import { z } from 'zod'
import type { CanvasUnitFailure } from '@video-studio/shared/api/contracts'
import type { ScriptScene, Shot } from '../../infrastructure/database/db.js'
import type { GenerationSteps } from '../script/script-generation-steps.js'
import type { StructuredGenerator } from '../generation/model-output.js'
import { settledVisualResponse } from './visual-profile-retry.js'
import { appearanceArbitration, appearanceFamily, applyAppearanceDecisions, coverageProfileKey } from './visual-appearance-arbitration.js'
import { visualCoverageUnit } from './visual-coverage-unit.js'
import { referenceCoverageTargets, validateVisualReferenceCoverage, visualCoverageDifferences, visualReferenceCoverageSchema,
  visualReferenceCoverageInstructions, type CoverageProfile, type ReferenceCoverage } from './visual-reference-coverage.js'

export const coverageUnitKey = '@visual-coverage'
export const isCoverageUnit = (key: string) => key === coverageUnitKey || key.startsWith('@appearance:')
/** Historical exact response lookup is supplied by the owner so a new prompt
 * can never turn an unresolved old coverage request into a fresh purchase. */
export async function prepareVisualCoverage<T extends CoverageProfile>(input: {
  scenes: ScriptScene[]; shots: Shot[]; profiles: T[]; steps: GenerationSteps; signal?: AbortSignal;
  generate: StructuredGenerator; historical: () => import('../generation/model-output-checkpoints.js').StructuredOutputCheckpoint | undefined;
  hasHistorical: boolean; selectedKeys?: readonly string[]; retries: Map<string, string>; trustedTerminalTransport?: boolean;
}) {
  const targets = referenceCoverageTargets(input.scenes, input.shots)
  const schema = z.object({ visual_coverage: visualReferenceCoverageSchema.length(targets.length) }).strict()
  const evidenceShots = input.shots.map(({ id, source_scene_id, title, prompt, image_prompt, video_prompt, start_state, end_state }) =>
    ({ id, scene_id: source_scene_id, title, prompt, image_prompt, video_prompt, start_state, end_state }))
  const identities = input.profiles.map(({ draft_key, id, kind, name, variant, scene_ids, base_draft_key, base_profile_id, state_delta }) =>
    ({ key: draft_key || id, kind, name, variant, scene_ids, base_draft_key, base_profile_id, state_delta }))
  // Coverage has its own contract and no profile/shot_usage examples. Full
  // selected shot evidence is kept; project/style/skill prose is unnecessary.
  const prompt = '只返回Schema中的visual_coverage；objects只有kind/name/variant/usage/requires_profile/reason，不能写reference_view。no_reference_reason必须是字符串，有对象时为空字符串。\n' +
    visualReferenceCoverageInstructions + '\n第一帧与视频过程分开判断，变体不能提前到尚未发生的首帧；背景可见也算视频用途。基础目录不是出镜名单，不按全场继承。\n' +
    '合法示例：' + JSON.stringify({ visual_coverage: [{ scene_id: targets[0]?.scene_id, shot_id: targets[0]?.shot_id, source_excerpt: '对应镜头逐字摘录',
      objects: [{ kind: 'prop', name: '目录中的确切名称', variant: '默认', usage: 'video', requires_profile: true, reason: '该状态仅在视频发生变化之后可见' }], no_reference_reason: '' }] }) +
    '\n本次镜头证据：' + JSON.stringify(evidenceShots) + '\n无分镜场次：' + JSON.stringify(input.scenes.filter(scene => !input.shots.some(shot => shot.source_scene_id === scene.id))) +
    '\n锁定身份与状态目录：' + JSON.stringify(identities)
  const scopedGenerate = (evidence: string | ((text: string) => string), sceneCount: number, shotCount: number, profilesChars = JSON.stringify(identities).length): StructuredGenerator => (text, contract, context) =>
    withTextInputScope({ evidence: typeof evidence === 'string' ? evidence : evidence(text), diagnostics: { input_scope_stage: 'coverage', input_scene_count: sceneCount, input_shot_count: shotCount,
      input_rules_chars: 0, input_facts_chars: 0, input_profiles_chars: profilesChars, input_original_chars: prompt.length } }, text,
      () => input.generate(text, contract, context))
  let seedRaw: string | undefined
  if (input.hasHistorical) {
    const saved = input.historical()
    if (!settledVisualResponse(saved)) return { profiles: input.profiles, failed_units: [{ unit_key: coverageUnitKey, stage: 'coverage' as const,
      name: '逐镜覆盖检查', code: 'model_delivery_unknown', message: '旧覆盖响应无法精确绑定或尚未结算，不能因输入升级重新发送。', retryable: false, recovery_type: 'blocked' as const,
      checkpoint_source: 'original_raw' as const, is_new_model_call: false, attempt: 1, recovery: { action: 'inspect' as const, model_call: 'unknown' as const } }] }
    seedRaw = saved.correction?.raw || saved.raw
  }
  const validateCandidate = (raw: unknown) => {
    const result = schema.parse(raw)
    // Validate source/target identities without treating prior usage as truth.
    const aligned = input.profiles.map(profile => ({ ...profile, shot_usage: profile.shot_usage?.map(row => ({ ...row,
      usage: result.visual_coverage.find(item => item.shot_id === row.shot_id)?.objects.find(object => object.requires_profile && object.kind === profile.kind && object.name === profile.name && object.variant === profile.variant)?.usage || 'none' })) }))
    validateVisualReferenceCoverage(result.visual_coverage, input.scenes, input.shots, aligned)
    return result
  }
  const candidate = await visualCoverageUnit({ key: coverageUnitKey, name: '逐镜覆盖检查', sceneIds: input.scenes.map(scene => scene.id), shotIds: input.shots.map(shot => shot.id),
    schema, prompt, steps: input.steps, generate: scopedGenerate('本次镜头证据：' + JSON.stringify(evidenceShots), input.scenes.length, input.shots.length), signal: input.signal, validate: validateCandidate, seedRaw,
    retryToken: input.retries.get(coverageUnitKey), trustedTerminalTransport: input.trustedTerminalTransport })
  if ('failure' in candidate) return { profiles: input.profiles, failed_units: [candidate.failure] }
  const coverage = candidate.value.visual_coverage
  const differences = visualCoverageDifferences(coverage, input.scenes, input.shots, input.profiles)
  const families = new Set(differences.flatMap(diff => {
    const profile = input.profiles.find(profile => coverageProfileKey(profile) === diff.object_key)
    return profile ? [appearanceFamily(profile, input.profiles)] : []
  }))
  let profiles = structuredClone(input.profiles), visual_coverage: ReferenceCoverage = structuredClone(coverage)
  const failed_units: CanvasUnitFailure[] = []
  for (const shot of input.shots) {
    const affected = profiles.filter(profile => profile.scene_ids.includes(shot.source_scene_id || '') && families.has(appearanceFamily(profile, profiles)))
    if (!affected.length || !affected.some(profile => profile.shot_usage?.some(row => row.shot_id === shot.id && row.usage !== 'none'))
      && !coverage.find(row => row.shot_id === shot.id)?.objects.some(object => affected.some(profile => profile.kind === object.kind && profile.name === object.name && profile.variant === object.variant))) continue
    const scene = input.scenes.find(scene => scene.id === shot.source_scene_id)!
    const plan = appearanceArbitration(shot, scene, affected)
    const key = '@appearance:' + shot.id
    const result = await visualCoverageUnit({ key, name: '镜头「' + shot.title + '」用途仲裁', sceneIds: [scene.id], shotIds: [shot.id],
      ...plan, steps: input.steps, generate: scopedGenerate(plan.evidenceForPrompt, 1, 1, JSON.stringify(affected.map(({ draft_key, id, kind, name, variant, base_draft_key, base_profile_id, state_delta }) => ({ draft_key, id, kind, name, variant, base_draft_key, base_profile_id, state_delta }))).length), signal: input.signal, retryToken: input.retries.get(key), trustedTerminalTransport: input.trustedTerminalTransport, allowModelDispatch: !input.selectedKeys || input.selectedKeys.includes(coverageUnitKey) || input.selectedKeys.includes(key) })
    if ('failure' in result) { failed_units.push(result.failure); if (result.failure.recovery?.model_call === 'unknown') break; continue }
    const merged = applyAppearanceDecisions(profiles, visual_coverage, shot, result.value.decisions)
    profiles = merged.profiles; visual_coverage = merged.visual_coverage
  }
  if (failed_units.length) return { profiles, visual_coverage, failed_units }
  validateVisualReferenceCoverage(visual_coverage, input.scenes, input.shots, profiles)
  return { profiles, visual_coverage }
}
