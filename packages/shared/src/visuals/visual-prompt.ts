import { videoReferenceManifest, visualBindingReferenceAssetIds, type VideoReferenceBinding } from '../media/video-reference-manifest.js'
import { visualReferenceViewLabels, type VisualReferencePurpose, type VisualReferenceSnapshot } from './visual-reference-types.js'
import type { VisualBindingUsage } from './visual-binding-usage.js'
import { videoReferenceUsageInstructions, videoReferenceShotGuidance, type VideoReferenceUsageSelection } from '../media/video-reference-usage.js'
import { stripManagedPromptBlocks } from './prompt-document.js'
import { withImageReferenceMapping } from './image-reference-prompt.js'
export { withImageReferenceMapping } from './image-reference-prompt.js'

export type PromptVisualBinding = {
  kind: 'character' | 'location' | 'prop'; name: string; variant: string; revision: number;
  definition: string; view_requirements: string; board_asset_id: string | null
  profile_id?: string; required?: boolean | number
  reference_assets?: VisualReferenceSnapshot[]
  /** Node-local ownership annotations; never used to select automatic inputs. */
  selected_reference_asset_ids?: string[]
  usage?: VisualBindingUsage
}
export type VideoReferencePromptOptions = {
  /** An authored full document is compiled elsewhere and must not be regenerated. */
  prompt_document?: boolean
  mode?: string
  storyboard_reference_asset_id?: string | null
  excluded_visual_profile_ids?: string[]
  video_reference_usages?: VideoReferenceUsageSelection[]
}
const selectedPurposes: Record<VisualReferencePurpose, string> = {
  identity: '对应对象的身份、五官、发型与外貌特征', costume: '服装款式、配色、纹理与身体比例',
  space: '场景空间结构、位置关系、视线方向与光线连续性', structure: '对应对象的外形、结构、尺度与材质',
  detail: '对应对象的局部纹理、连接与持握等细节',
}

/** Replace only the managed mapping; manually edited action/camera/visual prose stays intact. */
export function withVideoReferenceMapping(prompt: string, bindings: PromptVisualBinding[], references: string[], visualMode: string,
  options: VideoReferencePromptOptions = {}): string {
  const base = stripManagedPromptBlocks(prompt, { blockNames: ['视频参考图用途'] })
  if (options.mode !== 'reference' || !references.length) return base
  const referenceBindings = bindings.map((binding, index): VideoReferenceBinding => ({ ...binding,
    profile_id: binding.profile_id ?? `profile-${index}`, required: !!binding.required,
  }))
  const entries = videoReferenceManifest(references, referenceBindings, { mode: 'reference', visual_reference_mode: visualMode, storyboard_reference_asset_id: options.storyboard_reference_asset_id,
    excluded_visual_profile_ids: options.excluded_visual_profile_ids, video_reference_usages: options.video_reference_usages, append_profile_assets: false })
  const purposes = { storyboard: videoReferenceUsageInstructions.composition, character: '人物身份、面部、发型、服装与身体比例，不继承定妆姿势或背景构图',
    location: '场景空间结构、物体位置、材质与光线连续性', prop: '道具外形、尺度、材质与持握细节', manual: '本镜头的补充视觉参考',
    first_frame: '首帧', last_frame: '尾帧' }
  const context = entries.map(entry => {
    const details = entry.reference_details?.map(detail => `${detail.name}${detail.variant ? `（${detail.variant}）` : ''}：${visualReferenceViewLabels[detail.view]}${detail.label ? `（${detail.label}）` : ''}，用于${selectedPurposes[detail.purpose]}`)
    // A legacy board and an independent view may share one asset; keep both owners' uses.
    if (details?.length) for (const profileId of entry.profile_ids) {
      if (entry.reference_details!.some(detail => detail.profile_id === profileId)) continue
      const binding = referenceBindings.find(binding => binding.profile_id === profileId)
      if (binding) details.push(`${binding.name}${binding.variant ? `（${binding.variant}）` : ''}：${purposes[binding.kind]}`)
    }
    const purpose = entry.usage ? videoReferenceUsageInstructions[entry.usage]
      : details?.length ? `${entry.purpose === 'storyboard' ? `${purposes.storyboard}；` : ''}${details.join('；')}` : purposes[entry.purpose]
    return `图片${entry.index}：${entry.name}${entry.variant ? `（${entry.variant}）` : ''}；用途：${purpose}。`
  }).join('\n')
  const instructions = `${context}\n图片编号严格对应本次实际提交的顺序。${videoReferenceShotGuidance}\n` +
    '正文中始终使用已定义的同一对象名称，明确谁执行动作以及动作的对象；同一人物的面部与身体视角属于同一身份，不生成重复人物或分身。\n' +
    '仅继承每张图指定用途范围内的信息；身份参考保持同一人物，空间参考保持位置与视线关系。不要复制参考图的多视角拼版、文字、标签、色板或无关人物，不把不同视角同时放进故事画面。'
  return `${base}\n\n【视频参考图用途】\n${instructions}\n【视频参考图用途结束】`
}

export const synchronizeVideoReferencePrompt = withVideoReferenceMapping

export function visualGenerationPrompt(prompt: string, bindings: PromptVisualBinding[], references: string[], mode: string,
  options: VideoReferencePromptOptions = {}): string {
  if (options.prompt_document) return prompt
  const base = stripManagedPromptBlocks(prompt, { blockNames: ['镜头视觉设定', '图片参考图用途', '视频参考图用途'] })
  const excluded = new Set(options.excluded_visual_profile_ids || [])
  const referenceBindings = bindings.filter(binding => !binding.profile_id || !excluded.has(binding.profile_id))
  const mapReferences = (value: string) => options.mode === undefined
    ? withImageReferenceMapping(value, referenceBindings, references, mode) : withVideoReferenceMapping(value, bindings, references, mode, options)
  if (!bindings.length) return mapReferences(base)
  const labels = { character: '人物', location: '场景', prop: '道具' }
  const context = bindings.map(binding => {
    const usesImages = mode === 'profiles' && (!binding.profile_id || !excluded.has(binding.profile_id))
    const indexes = usesImages
      ? [...new Set([...visualBindingReferenceAssetIds(binding), ...(binding.selected_reference_asset_ids || [])])]
        .map(id => references.indexOf(id) + 1).filter(index => index > 0) : []
    const selected = usesImages ? binding.reference_assets?.filter(reference => references.includes(reference.asset_id)) : []
    const views = selected?.length ? `\n本次参考用途：${selected.map(reference => `${visualReferenceViewLabels[reference.view]}，用于${selectedPurposes[reference.purpose]}`).join('；')}` : ''
    const referenceLabel = options.mode === undefined ? '参考图' : '图片'
    return `${labels[binding.kind]}：${binding.name}（${binding.variant}，版本 ${binding.revision}）${indexes.length ? `；${referenceLabel} ${indexes.join('、')}` : ''}\n${binding.definition}${views}`
  }).join('\n\n')
  return mapReferences(`${base}\n\n【镜头视觉设定】\n${context}\n保持上述对象的外观、比例、服装、材质与空间关系。只生成当前镜头的一幅完整画面或连续视频；不要复制设定板的多视角拼版、文字、标签或色板。\n【镜头视觉设定结束】`)
}
