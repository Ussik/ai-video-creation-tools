import { z } from 'zod'
import type { ScriptScene, Shot } from '../../infrastructure/database/db.js'

export const visualReferenceCoverageSchema = z.array(z.object({
  scene_id: z.string().min(1), shot_id: z.string().min(1).nullable(),
  source_excerpt: z.string().trim().min(1).max(3000),
  objects: z.array(z.object({
    kind: z.enum(['character', 'location', 'prop']), name: z.string().trim().min(1).max(100),
    variant: z.string().trim().min(1).max(100), usage: z.enum(['image', 'video', 'both']),
    requires_profile: z.boolean(), reason: z.string().trim().min(8).max(2000),
  }).strict()).max(100),
  no_reference_reason: z.string().trim().max(3000),
}).strict()).max(1000)
export type ReferenceCoverage = z.infer<typeof visualReferenceCoverageSchema>
export type CoverageProfile = { kind: string; name: string; variant: string; scene_ids: string[];
  draft_key?: string; id?: string; base_draft_key?: string | null; base_profile_id?: string | null; state_delta?: string;
  shot_usage?: Array<{ shot_id: string; usage: string }> }
const identity = (profile: Pick<CoverageProfile, 'kind' | 'name' | 'variant'>) => JSON.stringify([profile.kind, profile.name, profile.variant])
const parentheses = (name: string) => name.replace(/[（）]/g, character => character === '（' ? '(' : ')')

export function canonicalizeCoverageObjects(coverage: ReferenceCoverage, profiles: CoverageProfile[]): ReferenceCoverage {
  return coverage.map(item => ({ ...item, objects: item.objects.map(object => {
    const candidates = profiles.filter(profile => profile.scene_ids.includes(item.scene_id)
      && profile.kind === object.kind && profile.variant === object.variant)
    const exact = candidates.filter(profile => identity(profile) === identity(object))
    const matches = exact.length ? exact : candidates.filter(profile => parentheses(profile.name) === parentheses(object.name))
    if (matches.length > 1) throw Object.assign(new Error(`「${object.name} · ${object.variant}」对应多个同场档案。请核对本场的同名档案。`), {
      code: 'visual_coverage_identity_ambiguous', statusCode: 422,
    })
    return matches.length ? { ...object, name: matches[0]!.name } : object
  }) }))
}
const modes = (usage: string) => usage === 'both' ? ['image', 'video'] : usage === 'none' ? [] : [usage]
function invalid(message: string): never { throw Object.assign(new Error(message), { statusCode: 422 }) }

export function referenceCoverageTargets(scenes: ScriptScene[], shots: Shot[]) {
  return scenes.flatMap<{ scene_id: string; shot_id: string | null; sources: string[] }>(scene => {
    const planned = shots.filter(shot => shot.source_scene_id === scene.id)
    return planned.length ? planned.map(shot => ({ scene_id: scene.id, shot_id: shot.id,
      sources: [shot.title, shot.prompt, shot.image_prompt, shot.video_prompt, shot.start_state, shot.end_state].filter((value): value is string => !!value) }))
      : [{ scene_id: scene.id, shot_id: null, sources: [scene.heading, scene.characters, scene.action, scene.dialogue, scene.narration].filter((value): value is string => !!value) }]
  })
}

/** Check model-owned identities and source evidence before any binding/cache writes.
 * This enforces declared coverage without guessing identity from prose keywords. */
export function validateVisualReferenceCoverage(coverage: ReferenceCoverage | undefined, scenes: ScriptScene[], shots: Shot[], profiles: CoverageProfile[]) {
  if (!coverage) invalid('缺少逐镜视觉覆盖说明，请重新整理参考设定')
  const targets = referenceCoverageTargets(scenes, shots)
  const key = (value: { scene_id: string; shot_id: string | null }) => JSON.stringify([value.scene_id, value.shot_id])
  if (new Set(coverage.map(key)).size !== coverage.length || coverage.length !== targets.length ||
    coverage.some(item => !targets.some(target => key(target) === key(item)))) invalid('视觉覆盖说明必须逐一对应本次每个镜头，不能遗漏、重复或引用范围外镜头')
  for (const item of coverage) {
    const target = targets.find(target => key(target) === key(item))!
    if (!target.sources.some(source => source.includes(item.source_excerpt))) invalid('视觉覆盖的来源摘录必须逐字取自对应镜头或无分镜场次')
    if (!item.objects.length && item.no_reference_reason.trim().length < 8) invalid('空镜或无需参考设定的镜头必须明确说明原因（至少8字），不能用空结果跳过整理')
    if (new Set(item.objects.map(identity)).size !== item.objects.length) invalid('同一镜头的出镜对象不能重复，请合并图片与视频用途')
  }
  const differences = visualCoverageDifferences(coverage, scenes, shots, profiles)
  if (differences.length) throw Object.assign(new Error('逐镜参考用途与出镜说明不一致，缺少对应档案或镜头用途，或参考用途缺少相应的逐镜出镜对象说明：' + JSON.stringify(differences)), {
    code: 'visual_coverage_conflict', statusCode: 422, retryable: false, differences,
    diagnostics: JSON.stringify({ stage: 'coverage', differences }),
  })
}
export function visualCoverageDifferences(coverage: ReferenceCoverage, scenes: ScriptScene[], shots: Shot[], profiles: CoverageProfile[]) {
  const differences: Array<{ object_key: string; shot_id: string | null; scene_id: string; missing_modes: string[]; extra_modes: string[]; expected: string[]; actual: string[]; source_excerpt: string }> = []
  for (const item of coverage) {
    const objects = item.objects.filter(object => object.requires_profile)
    const identities = new Set([...profiles.filter(profile => profile.scene_ids.includes(item.scene_id)).map(identity), ...objects.map(identity)])
    for (const id of identities) {
      const profile = profiles.find(profile => identity(profile) === id && profile.scene_ids.includes(item.scene_id))
      const object = objects.find(object => identity(object) === id)
      const expected = profile ? item.shot_id ? modes(profile.shot_usage?.find(row => row.shot_id === item.shot_id)?.usage || 'none') : object ? modes(object.usage) : [] : []
      const actual = object ? modes(object.usage) : []
      const missing_modes = expected.filter(mode => !actual.includes(mode)), extra_modes = actual.filter(mode => !expected.includes(mode))
      if (missing_modes.length || extra_modes.length) differences.push({ object_key: profile?.draft_key || profile?.id || id,
        shot_id: item.shot_id, scene_id: item.scene_id, expected, actual, missing_modes, extra_modes, source_excerpt: item.source_excerpt })
    }
  }
  return differences
}

/** Design scoping changes display variants; keep explicit identities aligned. */
export function scopeVisualReferenceCoverage(coverage: ReferenceCoverage, original: CoverageProfile[], scoped: CoverageProfile[]): ReferenceCoverage {
  return coverage.map(item => ({ ...item, objects: item.objects.map(object => {
    const index = original.findIndex(profile => identity(profile) === identity(object) && profile.scene_ids.includes(item.scene_id))
    return index < 0 ? object : { ...object, variant: scoped[index]!.variant }
  }) }))
}

export const visualReferenceCoverageInstructions = `逐镜返回 visual_coverage，已规划镜头每镜一条；尚无镜头的场次一条且 shot_id=null。scene_id、shot_id只能使用本次范围。source_excerpt逐字摘录对应镜头的开镜、动作或收镜原文；无分镜时摘录该场原文。objects逐项列出图片或视频实际可见的人物、环境和关键道具，以kind/name/variant精确标明身份和状态，usage说明image/video/both；requires_profile=true的对象必须有同身份档案且shot_usage覆盖其用途；不需要独立参考的普通背景物等设为false，并在reason说明依据。所有对象都填写reason。只在对白提及的对象不算出镜；不得按关键词猜身份或将全场档案绑定每镜。没有出镜对象时objects=[]，必须用no_reference_reason解释为何本镜无需参考，并提供支持的source_excerpt。全none或profiles=[]不能省略上述说明。`
