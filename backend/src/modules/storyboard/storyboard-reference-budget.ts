import { all } from '../../infrastructure/database/db.js'
import type { Model, Shot } from '../../infrastructure/database/db.js'
import { supportsVideoMultiReference, videoReferenceImageLimit } from '@video-studio/shared/media/video-reference-config'
import { visualBindingApplies, type VisualBindingUsage } from '@video-studio/shared/visuals/visual-binding-usage'
import { visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import { recommendVisualReferences } from '@video-studio/shared/visuals/visual-reference-selection'
import type { StoryboardReferenceBudget } from '@video-studio/shared/storyboard/storyboard-planning-types'
import type { VisualProfile } from '../visuals/visual-profiles.js'
import { parseVisualReferenceSnapshots, visualReferenceAssets } from '../visuals/visual-reference-assets.js'
import { projectVisualStyle } from '../visuals/project-visual-style.js'

type ProfileDraft = Pick<VisualProfile, 'kind' | 'name' | 'variant'> & {
  scene_ids: string[]
  shot_usage?: Array<{ shot_id: string; usage: VisualBindingUsage }>
}
type Binding = { shot_id: string; profile_id: string; name: string; usage?: VisualBindingUsage;
  board_asset_id: string | null; reference_assets?: unknown }
type DraftOptions = { replaceSceneBindings?: boolean; inheritSceneReferences?: boolean }

/** Planning has no chosen video model yet. Use a safe nine-image baseline and
 * respect stricter enabled multi-reference models, reserving the composition image. */
export function storyboardReferenceBudget(): StoryboardReferenceBudget {
  const models = all<Pick<Model, 'settings'>>(`SELECT m.settings FROM models m JOIN providers p ON p.id=m.provider_id
    WHERE m.modality='video' AND m.enabled=1 AND m.archived=0 AND p.enabled=1 AND p.archived=0 AND p.adapter<>'demo'`)
  const limits = models.flatMap(model => {
    let settings: Record<string, unknown>
    try { settings = JSON.parse(model.settings) } catch { return [] }
    return supportsVideoMultiReference(settings) ? [videoReferenceImageLimit(settings)] : []
  })
  const max_images = Math.min(9, ...limits)
  return { max_images, storyboard_images: 1, max_setting_images: max_images - 1 }
}

export function storyboardReferenceBudgetInstructions(budget = storyboardReferenceBudget()): string {
  return `【每镜参考图预算】视频最多 ${budget.max_images} 张参考图片，必须为生成后的分镜构图图预留 ${budget.storyboard_images} 张，` +
    `因此每镜开镜图片与视频过程各最多使用 ${budget.max_setting_images} 张设定参考图。` +
    '预算按实际图片去重计算，不按人物、场景或道具的档案数量计算；同一人物的面部图和身体图是两张，共用同一图片只计一张。' +
    '场次候选设定总数不限于单镜预算，仅为实际出镜且影响一致性的对象安排参考，不继承整场全部设定。' +
    '单镜确实需要超过预算时，在分镜规划中拆成有叙事意义且空间、动作连续的镜头，保留原有剧情、对白和关键对象，不能隐去必要对象或把其用途伪装成none来凑数量。\n'
}

/** Mirror preparation: keep existing frozen selections, scope scene candidates
 * by shot usage, and estimate unresolved profiles as their future single board. */
export function storyboardReferenceBudgetIssues(projectId: string, sceneIds: string[], drafts?: ProfileDraft[], options: DraftOptions = {}): Array<{ scene_id: string; message: string }> {
  const budget = storyboardReferenceBudget()
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', projectId)
    .filter(shot => sceneIds.includes(shot.source_scene_id || ''))
  const saved = all<Binding>(`SELECT b.* FROM shot_visual_bindings b JOIN shots s ON s.id=b.shot_id WHERE s.project_id=?`, projectId)
  const profiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=?', projectId)
  const sceneBindings = all<{ scene_id: string; profile_id: string }>(`SELECT b.* FROM scene_visual_bindings b
    JOIN script_scenes s ON s.id=b.scene_id WHERE s.project_id=?`, projectId)
  const style = projectVisualStyle(projectId)
  const key = (profile: Pick<VisualProfile, 'kind' | 'name' | 'variant'>) => JSON.stringify([profile.kind, profile.name, profile.variant])
  const issues: Array<{ scene_id: string; message: string }> = []
  for (const shot of shots) {
    const bindings = new Map(saved.filter(binding => binding.shot_id === shot.id).map(binding => [binding.profile_id, binding]))
    if (drafts) {
      if (options.replaceSceneBindings !== false) for (const binding of bindings.values()) {
        if (sceneBindings.some(scene => scene.scene_id === shot.source_scene_id && scene.profile_id === binding.profile_id)) binding.usage = 'none'
      }
      for (const draft of drafts) {
        if (!draft.scene_ids.includes(shot.source_scene_id || '')) continue
        const usage = draft.shot_usage ? draft.shot_usage.find(item => item.shot_id === shot.id)?.usage || 'none' : 'both'
        const profile = profiles.find(profile => key(profile) === key(draft))
        const profileId = profile?.id || `planned:${key(draft)}`
        const existing = bindings.get(profileId)
        // Canvas preparation inherits new bindings before applying their usage,
        // so it freezes image-camera selections even for video-only objects.
        const referencePrompt = usage === 'video' && !options.inheritSceneReferences ? shot.video_prompt : shot.image_prompt
        const references = !existing && profile ? recommendVisualReferences(profile, visualReferenceAssets(profile.id),
          [referencePrompt, shot.start_state].filter(Boolean).join('\n'), style.version) : []
        bindings.set(profileId, existing ? { ...existing, usage } : { shot_id: shot.id, profile_id: profileId,
          name: draft.name, usage, board_asset_id: profile?.board_asset_id || null, reference_assets: references })
      }
    }
    for (const modality of ['image', 'video']) {
      const active = [...bindings.values()].filter(binding => visualBindingApplies(binding, modality))
      const ids = new Set(active.flatMap(binding => {
        const ids = visualBindingReferenceAssetIds({ board_asset_id: binding.board_asset_id,
          reference_assets: parseVisualReferenceSnapshots(binding.reference_assets) })
        return ids.length ? ids : [`pending:${binding.profile_id}`]
      }))
      if (ids.size > budget.max_setting_images) issues.push({ scene_id: shot.source_scene_id!,
        message: `镜头「${shot.title}」的${modality === 'image' ? '开镜图片' : '视频过程'}需 ${ids.size} 张设定参考图，最多允许 ${budget.max_setting_images} 张；` +
          `视频共 ${budget.max_images} 张额度需为分镜图预留 1 张。请按实际出镜范围整理引用；必要对象过多时重新规划并拆分镜头，保留剧情和对白。` })
    }
  }
  return issues
}

export function assertStoryboardReferenceBudget(projectId: string, sceneIds: string[], drafts?: ProfileDraft[], options?: DraftOptions): void {
  const issue = storyboardReferenceBudgetIssues(projectId, sceneIds, drafts, options)[0]
  if (issue) throw Object.assign(new Error(issue.message), { statusCode: 422 })
}
