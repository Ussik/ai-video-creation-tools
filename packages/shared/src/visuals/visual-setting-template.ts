import { withVisualProfilePrompt } from './visual-profile-prompt.js'

export type VisualSettingKind = 'character' | 'location' | 'prop'

export const visualSettingTemplates: Record<VisualSettingKind, { label: string; body: string; views: string }> = {
  character: {
    label: '人物设定',
    body: '以连接的参考图片为依据，为同一人物制作专业影视人物设定图，保留其身份、外貌与服装特征，整理清晰的多视角与局部细节。',
    views: '完整全身正面、侧面、背面及四分之三视角，统一身高比例与站姿尺度；面部、发型、服装结构与关键配饰特写；配色、面料和材质样本。',
  },
  location: {
    label: '场景设定',
    body: '以连接的参考图片为依据，为同一场景制作专业影视场景设定图，保留其空间结构、固定陈设与材质特征，整理布局、多角度与关键细节。',
    views: '空间平面布局与主要方向的多角度视图，明确门窗、通道、固定陈设及相互位置；建筑结构、尺度比例、材质与配色细节；固定光源的位置及光照关系。',
  },
  prop: {
    label: '道具设定',
    body: '以连接的参考图片为依据，为同一道具制作专业影视道具设定图，保留其造型、结构、材质与配色特征，整理多视角、关键局部及必要使用状态。',
    views: '正面、侧面、背面、俯视及必要的四分之三视角，统一各视图的尺度比例；关键结构、连接部位、纹样与磨损细节；尺寸、材质和配色样本，必要时展示持握或开合状态。',
  },
}

const referenceFeatures: Record<VisualSettingKind, string> = {
  character: '人物的面部轮廓、五官关系、发型、体型比例、服装结构、配饰、配色与材质',
  location: '场景的建筑形制、空间布局、门窗与通道位置、固定陈设、尺度比例、配色与材质',
  prop: '道具的整体轮廓、结构比例、连接方式、纹样、配色与材质',
}

/** Compose instructions for the image generator; this does not inspect image pixels. */
export function withVisualSettingTemplate(body: string, kind: VisualSettingKind,
  references: { asset_id: string; name: string }[]): string {
  const template = visualSettingTemplates[kind]
  const referenceRule = references.length
    ? '参考图 1 是主参考，以其中对应类别的主体为本次设定对象；其余参考图默认仅补充同一对象的视角与细节。不同参考之间存在冲突时，以主参考为准，创作者在正文中明确指定的参考用途与改动除外。其他对象只按正文明确说明的互动或尺度对比用途使用，不拼接成新的混合身份。'
    : '接入参考图片后，以实际提交的图片确定本次设定对象。'
  return withVisualProfilePrompt(body, {
    kind, name: template.label.replace('设定', ''), variant: '参考图设定',
    definition: `${referenceRule}\n根据实际参考图片保留${referenceFeatures[kind]}；仅为补全视角推演与可见结构一致的细节，所有视图保持同一对象、同一版本。参考图片用于对象外观和结构，不照搬其原有构图、拼版、文字、水印或界面。`,
    view_requirements: template.views,
  }, references.map(reference => ({ ...reference, role: 'manual' as const })))
}
