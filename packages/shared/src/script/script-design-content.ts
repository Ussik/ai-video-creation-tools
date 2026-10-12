import { scriptArtifactLabels, scriptStageArtifacts, type StageArtifactType } from './script-stage-content.js'

/** Design deliverables share their content requirements across all generation entry points. */
export const scriptDesignArtifactGuidance: Partial<Record<StageArtifactType, string>> = {
  locations: '按全剧实际需要的地点建立清单：统一名称、别名、内外景、地点类型、剧情用途、承载的事件或冲突、首次出现、对应集数或场次、是否反复使用。此文档用于地点索引与叙事功能，详细空间、视觉和状态分别写入对应文档。',
  location_layouts: '沿用场景清单的地点名称，逐地点说明地理关系、空间尺度与分区、固定设施、出入口、人物行动路线、相对距离、可见范围、视线和声源、遮挡与行动障碍；在本阶段授权内设计支撑剧情的虚构布局，写清其如何影响行动、冲突和信息获取，保留已确认空间锚点。精确尺寸只在剧情需要时拟定，不捏造真实拍摄场地数据。',
  location_atmosphere: '沿用场景清单的地点名称，逐地点说明建筑与陈设、材质、色彩、时间与天气、光线及光源、环境声、情绪氛围和可复用视觉锚点；区分固定特征与剧情所需的气氛变化，遵循已确认的时代、视觉媒介与风格。',
  location_continuity: '按地点追踪各次出现的集数或场次、进入与离开状态、时间天气变化、设施或环境变化、造成变化的事件、后续影响和不能改变的空间锚点；标明相邻场次的移动与时间承接、可复用空间和连续性约束，没有变化时明确稳定状态。',
  props: '按全剧实际需要的道具建立清单：统一名称、别名、类别、关联人物、剧情用途、首次出现、涉及集数或场次、重要程度。此文档用于物件索引，外观、功能规则和归属变化分别写入对应文档；没有必要道具时写出原因，不为填栏目虚构物件。',
  prop_visuals: '沿用道具清单的物件名称，逐件说明形态、尺度、材质、颜色、年代、使用痕迹、标识、关键辨识细节与可复用视觉锚点；损坏、磨损等外观变体对应具体剧情状态，保证不同场次仍可辨认同一物件。',
  prop_functions: '沿用道具清单的物件名称，逐件说明如何推动事件、传递信息、形成阻碍或兑现伏笔，关联具体人物选择与后果、埋设与回收位置、使用方式、触发条件、能力边界、限制和代价；象征意义必须有剧情依据，关键功能先有铺垫再使用。',
  prop_continuity: '按道具追踪首次出现、初始持有者与知情者、对应集数或场次、转移双方、转移或使用事件、损坏或消耗、变化后的持有者与状态、最终去向和跨场连续性约束；明确人物何时取得物件或得知其功能，没有流转时写明固定归属与状态。',
}

export function scriptDesignStageInstructions(stage: 'locations' | 'props'): string {
  const types = scriptStageArtifacts[stage]
  return `分别输出以下四份独立文档，各类型恰好一份，不合并到主文档：\n` +
    types.map(type => `${type}（${scriptArtifactLabels[type]}）：${scriptDesignArtifactGuidance[type]}`).join('\n') + '\n' +
    '各文档使用相同的地点或道具名称，将集数、场次、人物和事件相互对应，避免重复抄写整份资料或互相矛盾。遵守已确认的地点与道具数量限制，不新增无关素材；没有适用变化或功能时说明实际原因，正文仍须非空。不生成图片，不把设计文档替换为生图提示词。'
}
