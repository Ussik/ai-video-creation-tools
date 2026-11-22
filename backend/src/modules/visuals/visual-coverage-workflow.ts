import { withTextInputScope } from '../../infrastructure/providers/text-input-scope.js'
import { z } from 'zod'
import type { CanvasUnitFailure } from '@video-studio/shared/api/contracts'
import type { ScriptScene, Shot } from '../../infrastructure/database/db.js'
import type { GenerationSteps } from '../script/script-generation-steps.js'
import type { StructuredGenerator } from '../generation/model-output.js'
import { settledVisualResponse } from './visual-profile-retry.js'
import { appearanceArbitration, appearanceFamily, applyAppearanceDecisions, coverageProfileKey } from './visual-appearance-arbitration.js'
import { visualCoverageBinding, visualCoverageUnit } from './visual-coverage-unit.js'
import { canonicalizeCoverageObjects, referenceCoverageTargets, validateVisualReferenceCoverage, visualCoverageDifferences, visualReferenceCoverageSchema,
  visualReferenceCoverageInstructions, type CoverageProfile, type ReferenceCoverage } from './visual-reference-coverage.js'

export const coverageUnitKey = '@visual-coverage'
export const isCoverageUnit = (key: string) => key === coverageUnitKey || key.startsWith('@appearance:')
export function fullCoveragePlan(input: { scenes: ScriptScene[]; shots: Shot[]; profiles: CoverageProfile[] }) {
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
  const validate = (raw: unknown) => {
    const visual_coverage = canonicalizeCoverageObjects(schema.parse(raw).visual_coverage, input.profiles)
    const aligned = input.profiles.map(profile => ({ ...profile, shot_usage: profile.shot_usage?.map(row => ({ ...row,
      usage: visual_coverage.find(item => item.shot_id === row.shot_id)?.objects.find(object => object.requires_profile && object.kind === profile.kind && object.name === profile.name && object.variant === profile.variant)?.usage || 'none' })) }))
    validateVisualReferenceCoverage(visual_coverage, input.scenes, input.shots, aligned)
    return { visual_coverage }
  }
  return { key: coverageUnitKey, schema, prompt, validate, evidenceShots, profilesChars: JSON.stringify(identities).length }
}

export async function prepareVisualCoverage<T extends CoverageProfile>(input: {
  scenes: ScriptScene[]; shots: Shot[]; profiles: T[]; steps: GenerationSteps; signal?: AbortSignal;
  generate: StructuredGenerator; historical: () => import('../generation/model-output-checkpoints.js').StructuredOutputCheckpoint | undefined;
  hasHistorical: boolean; selectedKeys?: readonly string[]; retries: Map<string, string>; trustedTerminalTransport?: boolean;
}) {
  const full = fullCoveragePlan(input)
  const { stepId } = visualCoverageBinding(full)
  const incompatible = Object.keys(input.steps.checkpoint.steps).some(key => {
    const match = /^(?:visual-unit-failure:|(?:response:|coverage-attempt-v2:|coverage-local-v2:)unit:)([a-f0-9]{64}):@visual-coverage(?::|$)/.exec(key)
    return match && 'unit:' + match[1] + ':' + coverageUnitKey !== stepId
  })
  const scopedGenerate = (evidence: string | ((text: string) => string), sceneCount: number, shotCount: number, profilesChars = full.profilesChars): StructuredGenerator => (text, contract, context) =>
    withTextInputScope({ evidence: typeof evidence === 'string' ? evidence : evidence(text), diagnostics: { input_scope_stage: 'coverage', input_scene_count: sceneCount, input_shot_count: shotCount,
      input_rules_chars: 0, input_facts_chars: 0, input_profiles_chars: profilesChars, input_original_chars: full.prompt.length } }, text,
      () => input.generate(text, contract, context))
  let seedRaw: string | undefined
  if (input.hasHistorical || incompatible) {
    const saved = !incompatible && input.historical()
    const reason = '保留的覆盖响应与当前场次、镜头或目录无法精确绑定，或响应尚未结算。请核对该次运行的记录。'
    if (!saved || !settledVisualResponse(saved)) return { profiles: input.profiles, failed_units: [{ unit_key: coverageUnitKey, stage: 'coverage' as const,
      name: '逐镜覆盖检查', code: 'model_delivery_unknown', message: reason, retryable: false, recovery_type: 'blocked' as const,
      checkpoint_source: 'original_raw' as const, is_new_model_call: false, attempt: 1, recovery: { action: 'inspect' as const, model_call: 'unknown' as const, reason } }] }
    seedRaw = saved.correction?.raw || saved.raw
  }
  const candidate = await visualCoverageUnit({ ...full, name: '逐镜覆盖检查', sceneIds: input.scenes.map(scene => scene.id), shotIds: input.shots.map(shot => shot.id),
    steps: input.steps, generate: scopedGenerate('本次镜头证据：' + JSON.stringify(full.evidenceShots), input.scenes.length, input.shots.length), signal: input.signal, seedRaw,
    retryToken: input.retries.get(coverageUnitKey), trustedTerminalTransport: input.trustedTerminalTransport })
  if ('failure' in candidate) return { profiles: input.profiles, failed_units: [candidate.failure] }
  const coverage = candidate.value.visual_coverage
  const differences = visualCoverageDifferences(coverage, input.scenes, input.shots, input.profiles)
  const profileByKey = new Map(input.profiles.map(profile => [coverageProfileKey(profile), profile]))
  const familiesByShot = new Map<string | null, Set<string>>()
  const legacyFamilies = new Set<string>()
  for (const difference of differences) {
    const profile = profileByKey.get(difference.object_key)
    if (!profile) continue
    const family = appearanceFamily(profile, input.profiles)
    const families = familiesByShot.get(difference.shot_id) || new Set<string>()
    families.add(family)
    familiesByShot.set(difference.shot_id, families)
    legacyFamilies.add(family)
  }
  let profiles = structuredClone(input.profiles), visual_coverage: ReferenceCoverage = structuredClone(coverage)
  const failed_units: CanvasUnitFailure[] = []
  let deliveryPending = false
  for (const shot of input.shots) {
    const scene = input.scenes.find(scene => scene.id === shot.source_scene_id)
    if (!scene) continue
    const key = '@appearance:' + shot.id
    const select = (families?: Set<string>) => profiles.filter(profile => profile.scene_ids.includes(scene.id) && families?.has(appearanceFamily(profile, profiles)))
    const legacy = select(legacyFamilies)
    const legacyVisible = legacy.some(profile => profile.shot_usage?.some(row => row.shot_id === shot.id && row.usage !== 'none'))
      || coverage.find(row => row.shot_id === shot.id)?.objects.some(object => legacy.some(profile => profile.kind === object.kind && profile.name === object.name && profile.variant === object.variant))
    let affected = select(familiesByShot.get(shot.id))
    if (legacyVisible) {
      const prior = visualCoverageBinding({ key, ...appearanceArbitration(shot, scene, legacy) }).stepId
      if (input.hasHistorical || Object.keys(input.steps.checkpoint.steps).some(slot => slot === prior || slot.includes(prior + ':')
        || slot === 'visual-unit-failure:' + prior.slice('unit:'.length))) affected = legacy
    }
    if (!affected.length) continue
    const plan = appearanceArbitration(shot, scene, affected)
    const result = await visualCoverageUnit({ key, name: '镜头「' + shot.title + '」用途仲裁', sceneIds: [scene.id], shotIds: [shot.id],
      ...plan, steps: input.steps, generate: scopedGenerate(plan.evidenceForPrompt, 1, 1, JSON.stringify(affected.map(({ draft_key, id, kind, name, variant, base_draft_key, base_profile_id, state_delta }) => ({ draft_key, id, kind, name, variant, base_draft_key, base_profile_id, state_delta }))).length), signal: input.signal,
      retryToken: deliveryPending ? undefined : input.retries.get(key), trustedTerminalTransport: input.trustedTerminalTransport,
      allowModelDispatch: !deliveryPending && (!input.selectedKeys || input.selectedKeys.includes(coverageUnitKey) || input.selectedKeys.includes(key)) })
    if ('failure' in result) {
      failed_units.push(result.failure)
      if (result.failure.recovery?.model_call === 'unknown') deliveryPending = true
      continue
    }
    const merged = applyAppearanceDecisions(profiles, visual_coverage, shot, result.value.decisions)
    profiles = merged.profiles; visual_coverage = merged.visual_coverage
  }
  if (failed_units.length) return { profiles, visual_coverage, failed_units }
  validateVisualReferenceCoverage(visual_coverage, input.scenes, input.shots, profiles)
  return { profiles, visual_coverage }
}
