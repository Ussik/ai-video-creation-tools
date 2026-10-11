/** Per-video uses; these never change a profile's saved view metadata or provider frame roles. */
export const videoReferenceUsages = ['identity', 'costume', 'space', 'structure', 'detail', 'scale', 'action', 'composition', 'opening', 'intermediate', 'ending'] as const
export type VideoReferenceUsage = typeof videoReferenceUsages[number]
export interface VideoReferenceUsageSelection { asset_id: string; usage: VideoReferenceUsage }

export const videoReferenceUsageLabels: Record<VideoReferenceUsage, string> = {
  identity: '人物身份', costume: '服装造型', space: '场景空间', structure: '道具结构', detail: '局部细节',
  scale: '比例尺度', action: '动作姿态', composition: '整体构图', opening: '开场构图', intermediate: '过程状态', ending: '结尾构图',
}
export const videoReferenceUsageInstructions: Record<VideoReferenceUsage, string> = {
  identity: '只参考对应人物的身份、五官、发型与外貌，不继承定妆姿势、背景或构图',
  costume: '只参考对应对象的服装款式、配色与穿着细节，不继承姿势、背景或构图',
  space: '只参考场景空间结构、物体位置、轴线与视线关系，不继承图中人物身份或动作',
  structure: '只参考对应道具的外形、结构与材质，不继承背景或画面构图',
  detail: '只参考对应对象的局部细节、连接或持握关系，不复制整张构图',
  scale: '只参考对象间的相对大小与比例，不继承人物五官、服装、姿势、场景或画风',
  action: '只参考对应对象的动作、姿态与受力关系，不继承图中其他人物身份、背景或时间位置',
  composition: '参考整体构图与空间关系，不指定动作起点或时间位置；开场、过程与结尾按正文设计',
  opening: '作为开场构图与初始状态的视觉引导，按正文演绎；这是多图参考引导，不是严格首帧约束',
  intermediate: '作为动作过程中的状态引导，不提前作为开场；发生时机按正文设计',
  ending: '作为结尾构图与收镜状态的视觉引导，不提前作为开场；这是多图参考引导，不是严格尾帧约束',
}

export const videoReferenceShotGuidance = '多图参考中每张图仅承担指定用途，图片顺序不代表动作时间顺序，也不自动把图片1或分镜图当作首帧。依据原提示词写清本镜头的目的、开场状态、动作先后、运镜、收镜状态及已有的声音或对白；没有提供的信息不要补造。开场、过程、结尾参考仅提供相应阶段的视觉引导，严格首帧或首尾帧由对应生成模式控制。'

export function videoReferenceUsageIssue(selections: VideoReferenceUsageSelection[] | undefined, references: string[], mode: string, modality = 'video'): string | null {
  if (!selections?.length) return null
  if (modality !== 'video' || mode !== 'reference') return '逐图用途仅适用于视频多图参考模式'
  if (new Set(selections.map(item => item.asset_id)).size !== selections.length) return '参考图用途不能重复指定同一图片'
  if (selections.some(item => !references.includes(item.asset_id))) return '参考图用途必须对应本次实际提交的图片'
  return null
}
