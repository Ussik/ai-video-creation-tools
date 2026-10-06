import { z } from 'zod'
import { parseStructuredOutput } from './structured-output.js'

export const workflowRequest = z.object({
  stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']),
  episode_number: z.number().int().min(1).max(200).default(1),
  target_duration: z.number().int().min(5).max(600).optional(),
}).strict()

export const workflowScene = z.object({
  heading: z.string().trim().min(1).max(120),
  location: z.string().max(500).default(''), time_of_day: z.string().max(120).default(''),
  characters: z.string().max(2000).default(''), action: z.string().max(10000).default(''),
  dialogue: z.string().max(10000).default(''), narration: z.string().max(10000).default(''),
  duration: z.number().int().min(1).max(30),
})
const workflowArtifact = z.object({
  artifact_type: z.enum(['outline', 'synopsis', 'world', 'episode_outline', 'characters', 'relationships', 'locations', 'props', 'episode_script']),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20000),
}).strict()
const stageTypes = {
  outline: ['outline', 'synopsis', 'world', 'episode_outline'],
  characters: ['characters', 'relationships'], locations: ['locations'], props: ['props'], episode: ['episode_script'],
} as const
export const workflowLabels = { outline: '故事大纲', characters: '人物设定', locations: '场景设计', props: '道具设计', episode: '分集剧本' }
export const workflowDraftSchema = workflowRequest.extend({
  artifacts: z.array(workflowArtifact).min(1).max(4),
  scenes: z.array(workflowScene).max(100).default([]),
}).strict().superRefine((draft, ctx) => {
  const allowed: readonly string[] = stageTypes[draft.stage]
  const types = draft.artifacts.map(artifact => artifact.artifact_type)
  if (types.some(type => !allowed.includes(type)) || new Set(types).size !== types.length || !types.includes(allowed[0] as typeof types[number])) {
    ctx.addIssue({ code: 'custom', message: '草稿文档与当前创作阶段不一致', path: ['artifacts'] })
  }
  if ((draft.stage === 'episode') !== (draft.scenes.length > 0)) {
    ctx.addIssue({ code: 'custom', message: '仅分集正文阶段需要分场剧本', path: ['scenes'] })
  }
})
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>

export function workflowInstructions(request: z.infer<typeof workflowRequest>): string {
  const stages = {
    outline: '整理故事主线、人物目标、世界规则、起承转合与结局；输出 outline，并补充 synopsis、world、episode_outline。分集大纲必须覆盖用户明确要求的集数，每集写出事件、冲突、推进和结尾悬念。不要写分场正文。',
    characters: '输出 characters 和 relationships：人物身份、目标、阻力、弧光、关系变化以及可复用的外观和服装设定。不要新增无关人物或改写已确认主线。',
    locations: '输出 locations：列出实际需要的地点、空间布局、光线、时间、色彩、反复出现的视觉锚点和对应剧情。遵守用户的地点数量限制，不生成图片。',
    props: '输出 props：列出关键道具的形态、材质、使用者、剧情功能、状态变化及连续性约束。不生成图片。',
    episode: `只写第 ${request.episode_number} 集，不写其他集。输出 episode_script 正文和该集 scenes；必须承接已确认的分集大纲、人物、地点、道具和前集状态。正文包含集标题、分场标题、可拍动作、对白和结尾钩子。${request.target_duration ? `本集总时长目标约 ${request.target_duration} 秒（不是全剧时长）。` : '按创作者明确的单集时长写作；未指定时由故事节奏判断。'} 每场1至30秒，按对白和动作分配，不机械均分。`,
  }
  return `\n本轮为“${workflowLabels[request.stage]}”文档生成。只完成本轮阶段，不提问、不声称已保存或已完成其他阶段。\n${stages[request.stage]}\n` +
    '只输出一个合法 JSON 对象，不要解释或代码围栏。格式：' +
    '{"artifacts":[{"artifact_type":"文档类型","title":"文档标题","content":"完整可编辑正文"}],"scenes":[' +
    '{"heading":"场次标题","location":"地点","time_of_day":"日/夜","characters":"出场人物","action":"画面动作","dialogue":"对白","narration":"旁白","duration":秒数}]}。' +
    `本阶段文档类型只允许 ${stageTypes[request.stage].join('、')}；非分集阶段 scenes 必须为空数组。\n`
}

export function parseWorkflowDraft(raw: string, request: z.infer<typeof workflowRequest>): WorkflowDraft | null {
  const envelope = z.object({ artifacts: z.array(workflowArtifact), scenes: z.array(workflowScene).default([]) })
  const result = parseStructuredOutput(raw, envelope)
  if (!result) return null
  const parsed = workflowDraftSchema.safeParse({ ...request, ...result })
  if (!parsed.success) return null
  if (parsed.data.stage === 'episode') parsed.data.artifacts[0]!.title = `第 ${request.episode_number} 集剧本`
  return parsed.data
}

export function workflowReply(draft: WorkflowDraft): string {
  const scope = draft.stage === 'episode' ? `第 ${draft.episode_number} 集` : workflowLabels[draft.stage]
  return `${scope}草稿已生成：${draft.artifacts.length} 份文档${draft.scenes.length ? `，${draft.scenes.length} 场、${draft.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : ''}。请检查下方预览，确认后保存并继续下一阶段。`
}
