import { videoReferenceManifest, type VideoReferenceBinding } from './video-reference-manifest.js'

export type PromptVisualBinding = {
  kind: 'character' | 'location' | 'prop'; name: string; variant: string; revision: number;
  definition: string; view_requirements: string; board_asset_id: string | null
  profile_id?: string; required?: boolean | number
}
export type VideoReferencePromptOptions = {
  mode?: string
  storyboard_reference_asset_id?: string | null
  excluded_visual_profile_ids?: string[]
}
const referenceBlock = /【视频参考图用途】[\s\S]*?【视频参考图用途结束】\s*/g

/** Replace only the managed mapping; manually edited action/camera/visual prose stays intact. */
export function withVideoReferenceMapping(prompt: string, bindings: PromptVisualBinding[], references: string[], visualMode: string,
  options: VideoReferencePromptOptions = {}): string {
  const base = prompt.replace(referenceBlock, '').trim()
  if (options.mode !== 'reference' || !references.length) return base
  const entries = videoReferenceManifest(references, bindings.filter(binding => binding.board_asset_id && references.includes(binding.board_asset_id)).map((binding, index): VideoReferenceBinding => ({ ...binding,
    profile_id: binding.profile_id ?? `profile-${index}`, required: !!binding.required,
  })), { mode: 'reference', visual_reference_mode: visualMode, storyboard_reference_asset_id: options.storyboard_reference_asset_id,
    excluded_visual_profile_ids: options.excluded_visual_profile_ids })
  const purposes = { storyboard: '开镜构图、动作起点与初始空间关系', character: '人物身份、面部、发型、服装与身体比例',
    location: '场景空间结构、物体位置、材质与光线连续性', prop: '道具外形、尺度、材质与持握细节', manual: '本镜头的补充视觉参考',
    first_frame: '首帧', last_frame: '尾帧' }
  const context = entries.map(entry => `图片${entry.index}：${entry.name}${entry.variant ? `（${entry.variant}）` : ''}；用途：${purposes[entry.purpose]}。`).join('\n')
  const instructions = `${context}\n图片编号严格对应本次实际提交的顺序。对应对象不能互换或混合身份，动作、转身、遮挡与运镜过程中保持人物、服装、场景及道具一致。\n` +
    (options.storyboard_reference_asset_id ? '分镜图用于开镜构图与动作起点，按此起始状态连续演绎；多图参考属于构图引导，不要求将参考拼版作为首帧。\n' : '') +
    '人物、场景、道具信息图仅用于对应对象的一致性，不复制其多视角拼版、文字、标签、色板或无关人物，不把不同视角同时放进故事画面。'
  return `${base}\n\n【视频参考图用途】\n${instructions}\n【视频参考图用途结束】`
}

export const synchronizeVideoReferencePrompt = withVideoReferenceMapping

export function visualGenerationPrompt(prompt: string, bindings: PromptVisualBinding[], references: string[], mode: string,
  options: VideoReferencePromptOptions = {}): string {
  if (!bindings.length) return withVideoReferenceMapping(prompt, bindings, references, mode, options)
  const labels = { character: '人物', location: '场景', prop: '道具' }
  const context = bindings.map(binding => {
    const index = mode === 'profiles' && options.mode !== 'reference' && binding.board_asset_id ? references.indexOf(binding.board_asset_id) + 1 : 0
    return `${labels[binding.kind]}：${binding.name}（${binding.variant}，版本 ${binding.revision}）${index ? `；参考图 ${index}` : ''}\n${binding.definition}\n视图说明：${binding.view_requirements}`
  }).join('\n\n')
  return withVideoReferenceMapping(`${prompt}\n\n【镜头视觉设定】\n${context}\n保持上述对象的外观、比例、服装、材质与空间关系。只生成当前镜头的一幅完整画面或连续视频；不要复制设定板的多视角拼版、文字、标签或色板。`, bindings, references, mode, options)
}
