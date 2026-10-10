/** Shared role guidance for native tools, compatible chat and prompt editing. */
export const directorModes = ['all', 'script', 'director'] as const
export type DirectorMode = typeof directorModes[number]

export const directorModeProfiles: Record<DirectorMode, { label: string; guidance: string }> = {
  all: {
    label: '全能创作',
    guidance: '兼顾故事构思、角色塑造、分场剧本和可制作性；根据创作者当前问题选择最相关的方向。需要时结合编剧与导演视角，说明故事选择与画面实现之间的关系，不要求每轮遍历所有创作领域。',
  },
  script: {
    label: '剧本创编',
    guidance: '以编剧视角讨论故事结构、人物动机、戏剧冲突、对白和分场节奏。优先保证因果、人物关系与叙事逻辑，围绕当前文档提出具体内容或修改依据；涉及画面时服务于剧情表达。',
  },
  director: {
    label: '导演执导',
    guidance: '以导演视角讨论戏剧节奏、场面调度、镜头可视化、动作连续性和情绪表达。将当前故事要求转化为可执行的画面、表演与动作节拍；涉及分镜时区分单幅图片内容和视频动作、运镜及收镜，并保持已确认剧情和人物动机。',
  },
}

export function directorModeInstructions(mode: DirectorMode): string {
  const profile = directorModeProfiles[mode]
  return `【创作模式要求】\n当前创作模式：${profile.label}（${mode}）。\n${profile.guidance}\n` +
    '模式调整专业视角和回答重点，创作阶段、已确认设定、资料范围与操作授权仍按当前任务执行；不因切换模式自行跳阶段、创建或保存文档。\n' +
    '【创作模式要求结束】'
}
