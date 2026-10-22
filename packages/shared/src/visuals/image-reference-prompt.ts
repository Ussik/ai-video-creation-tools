import { visualBindingReferenceAssetIds } from '../media/video-reference-manifest.js'
import { visualBindingApplies } from './visual-binding-usage.js'
import type { PromptVisualBinding } from './visual-prompt.js'
import { visualReferenceViewLabels, type VisualReferencePurpose } from './visual-reference-types.js'

// The two leading newlines belong to the managed block. Leave the creator's
// whitespace before them and after the closing marker untouched.
const referenceBlock = /(?:\n\n)?【图片参考图用途】[\s\S]*?【图片参考图用途结束】/g
const selectedPurposes: Record<VisualReferencePurpose, string> = {
  identity: '对应对象的身份、五官、发型与外貌特征', costume: '服装款式、配色、纹理与身体比例',
  space: '场景空间结构、位置关系、视线方向与光线连续性', structure: '对应对象的外形、结构、尺度与材质',
  detail: '对应对象的局部纹理、连接与持握等细节',
}
const bindingPurposes: Record<PromptVisualBinding['kind'], string> = {
  character: '人物身份、面部、发型、服装与身体比例，不继承定妆姿势或背景构图',
  location: '场景空间结构、物体位置、材质与光线连续性',
  prop: '道具外形、尺度、材质与持握细节',
}
const bindingLabels: Record<PromptVisualBinding['kind'], string> = { character: '人物', location: '场景', prop: '道具' }

/** Synchronize image ownership and uses without rebuilding the creator's prose. */
export function withImageReferenceMapping(prompt: string, bindings: PromptVisualBinding[], references: string[], visualMode: string): string {
  const base = prompt.replace(referenceBlock, '')
  if (!references.length) return base
  const activeBindings = visualMode === 'profiles' ? bindings.filter(binding => visualBindingApplies(binding, 'image')) : []
  const lines = references.map((assetId, index) => {
    const owners = activeBindings.filter(binding => visualBindingReferenceAssetIds(binding).includes(assetId))
    if (!owners.length) return `参考图 ${index + 1}：补充参考；用途：以正文明确要求为准，不自动认定为某个人物身份或绑定设定。`
    const names = owners.map(binding => {
      const name = binding.name.trim() || `未命名${bindingLabels[binding.kind]}`
      return `${name}${binding.variant.trim() ? `（${binding.variant.trim()}）` : ''}`
    })
    const purposes = owners.flatMap((binding, ownerIndex) => {
      const selected = binding.reference_assets?.filter(reference => reference.asset_id === assetId) || []
      return selected.length ? selected.map(reference => `${names[ownerIndex]}：${visualReferenceViewLabels[reference.view]}` +
        `${reference.label.trim() ? `（${reference.label.trim()}）` : ''}，用于${selectedPurposes[reference.purpose]}`)
        : [`${names[ownerIndex]}：${bindingPurposes[binding.kind]}`]
    })
    return `参考图 ${index + 1}：${[...new Set(names)].join(' / ')}；用途：${[...new Set(purposes)].join('；')}。`
  })
  const instructions = lines.join('\n') + '\n图片编号严格对应本次实际提交的顺序。仅继承每张图指定用途范围内的信息，保持同一对象的身份、外观与空间关系。' +
    '\n同一对象的不同视图属于同一主体，不生成重复人物或分身。只生成当前镜头的一幅完整画面，不复制参考图的多视角拼版、文字、标签、色板或无关人物。'
  return `${base}\n\n【图片参考图用途】\n${instructions}\n【图片参考图用途结束】`
}
