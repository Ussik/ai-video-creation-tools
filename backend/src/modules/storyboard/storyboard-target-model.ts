import { one, type Model } from '../../infrastructure/database/db.js'
import { supportsVideoMultiReference, videoReferenceImageLimit } from '@video-studio/shared/media/video-reference-config'
import type { StoryboardReferenceBudget } from '@video-studio/shared/storyboard/storyboard-planning-types'
import { configuredVideoPromptDialect } from '../generation/seedance-prompt.js'

export function storyboardTargetModel(id?: string) {
  if (!id) return null
  const model = one<Model>(`SELECT m.* FROM models m JOIN providers p ON p.id=m.provider_id
    WHERE m.id=? AND m.modality='video' AND m.enabled=1 AND m.archived=0 AND p.enabled=1 AND p.archived=0`, id)
  if (!model) throw Object.assign(new Error('目标视频模型不存在、已停用或不是视频模型，请重新选择'), { statusCode: 422 })
  let settings: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(model.settings)
    if (value && typeof value === 'object' && !Array.isArray(value)) settings = value as Record<string, unknown>
  } catch { /* Legacy malformed settings offer no inferred capability. */ }
  const profile = settings.video_reference_profile === 'seedance_2_0' ? 'Seedance 2.0'
    : settings.video_reference_profile === 'seedance_2_5' ? 'Seedance 2.5' : ''
  const budget: StoryboardReferenceBudget | null = supportsVideoMultiReference(settings)
    ? { max_images: videoReferenceImageLimit(settings), storyboard_images: 1, max_setting_images: Math.max(0, videoReferenceImageLimit(settings) - 1) } : null
  return { id: model.id, target_model: `${profile} ${model.name} ${model.remote_id}`.trim(),
    target_dialect: configuredVideoPromptDialect({ name: model.name, remote_id: model.remote_id, settings }), settings, budget,
    signature: JSON.stringify({ id: model.id, name: model.name, remote_id: model.remote_id, settings: model.settings }) }
}

export function storyboardTargetInstructions(target: ReturnType<typeof storyboardTargetModel>) {
  return target ? `【目标视频制作能力】${JSON.stringify({ target_model: target.target_model,
    supported_modes: target.settings.supported_modes || [], duration_options: target.settings.duration_options || null })}。` +
    '以上是实际视频生成模型，规划文本模型不代表视频模型。镜长是剪辑目标，素材生成时长可不同；对白和关键动作需要完整可用区间，不自动截断或加速台词。' +
    (target.budget ? '\n' : '当前未配置可验证的多图参考能力，不强套其他视频模型的图片上限，不为假定额度机械拆镜。\n') :
    '目标视频模型尚未指定：使用通用制作约束，不声称拥有特定模型能力；生成时长与剪辑目标时长分别确认。\n'
}
