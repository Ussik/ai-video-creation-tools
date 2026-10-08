import { z } from 'zod'
import { parseStructuredOutput } from './structured-output.js'

const workflowRequestFields = z.object({
  stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']),
  scope: z.enum(['project', 'episode']).optional(),
  episode_number: z.number().int().min(0).max(200).default(1),
  target_duration: z.number().int().min(5).max(600).optional(),
}).strict()

function validateScope(request: z.infer<typeof workflowRequestFields>, ctx: z.RefinementCtx) {
  const scope = request.stage === 'episode' ? 'episode' : 'project'
  if (request.scope && request.scope !== scope) ctx.addIssue({ code: 'custom', message: '创作范围与阶段不一致', path: ['scope'] })
  if (scope === 'episode' && request.episode_number < 1) ctx.addIssue({ code: 'custom', message: '分集正文必须指定目标集数', path: ['episode_number'] })
}

// Older callers attached their selected episode to every stage. Project
// documents have no target episode or runtime, regardless of that stale state.
export function normalizeWorkflowRequest<T extends z.infer<typeof workflowRequestFields>>(request: T) {
  const { scope: _scope, episode_number, target_duration, ...rest } = request
  return { ...rest, scope: request.stage === 'episode' ? 'episode' as const : 'project' as const,
    episode_number: request.stage === 'episode' ? episode_number : 0,
    ...(request.stage === 'episode' && target_duration !== undefined ? { target_duration } : {}) }
}
export const workflowRequest = workflowRequestFields.superRefine(validateScope).transform(normalizeWorkflowRequest)

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
export type WorkflowStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export const workflowStages: WorkflowStage[] = ['outline', 'characters', 'locations', 'props', 'episode']
export const workflowLabels = { outline: '全剧故事大纲', characters: '全剧人物设定', locations: '全剧场景设计', props: '全剧道具设计', episode: '分集剧本' }
export const workflowDraftInput = workflowRequestFields.extend({
  artifacts: z.array(workflowArtifact).min(1).max(4),
  scenes: z.array(workflowScene).max(100).default([]),
}).strict().superRefine(validateScope).superRefine((draft, ctx) => {
  const allowed: readonly string[] = stageTypes[draft.stage]
  const types = draft.artifacts.map(artifact => artifact.artifact_type)
  if (types.some(type => !allowed.includes(type)) || new Set(types).size !== types.length || !types.includes(allowed[0] as typeof types[number])) {
    ctx.addIssue({ code: 'custom', message: '草稿文档与当前创作阶段不一致', path: ['artifacts'] })
  }
  if ((draft.stage === 'episode') !== (draft.scenes.length > 0)) {
    ctx.addIssue({ code: 'custom', message: '仅分集正文阶段需要分场剧本', path: ['scenes'] })
  }
})
export const workflowDraftSchema = workflowDraftInput.transform(normalizeWorkflowRequest)
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>

export function workflowInstructions(request: z.infer<typeof workflowRequest>): string {
  const stages = {
    outline: '整理故事主线、人物目标、世界规则、起承转合与结局；输出 outline，并补充 synopsis、world、episode_outline。分集大纲必须覆盖用户明确要求的集数，每集写出事件、冲突、推进和结尾悬念。不要写分场正文。',
    characters: '输出 characters 和 relationships：人物身份、目标、阻力、弧光、关系变化以及可复用的外观和服装设定。不要新增无关人物或改写已确认主线。',
    locations: '输出 locations：列出实际需要的地点、空间布局、光线、时间、色彩、反复出现的视觉锚点和对应剧情。遵守用户的地点数量限制，不生成图片。',
    props: '输出 props：列出关键道具的形态、材质、使用者、剧情功能、状态变化及连续性约束。不生成图片。',
    episode: `只写第 ${request.episode_number} 集，不写其他集。输出 episode_script 正文和该集 scenes；必须承接已确认的分集大纲、人物、地点、道具和前集状态。正文包含集标题、分场标题、可拍动作、对白和结尾钩子。${request.target_duration ? `本集总时长目标约 ${request.target_duration} 秒（不是全剧时长）。` : '按创作者明确的单集时长写作；未指定时由故事节奏判断。'} 每场1至30秒，按对白和动作分配，不机械均分。`,
  }
  const boundary = request.stage === 'episode'
    ? `任务范围：仅第 ${request.episode_number} 集正文。全剧资料和前集正文用于承接，不得修改其他集或全剧文档。`
    : '任务范围：整个项目的全剧资料，不属于任何单集。聊天中最近写过的集数、下一集计划以及创作要求中的单集措辞仅作背景，不能把本轮改为该集或下一集的文档。人物、地点和道具覆盖全剧已确认的内容；大纲覆盖全剧主线与结局。保持已保存各集事实。只更新所选资料，不生成、改写或推进分集正文。'
  return `\n本轮为“${workflowLabels[request.stage]}”文档生成。只完成本轮阶段，不提问、不声称已保存或已完成其他阶段。\n${boundary}\n${stages[request.stage]}\n` +
    '创作者明确授权模型决定后已经作出的具体设定应沿用，不标为待定；创作者后续修改优先。其他未知且未授权模型决定的设定标为待定，不把未获授权的建议当成已确认事实。\n' +
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

export type WorkflowProgressInput = {
  outline?: string; characters?: string;
  artifacts?: Array<{ artifact_type: string; content: string; episode_number?: number; status?: string }>;
  scenes?: Array<{ episode_number?: number }>;
  generation_options?: { episode_count?: number };
}

/** Recommendations use saved project documents, never a last-clicked stage or a pending draft. */
export function workflowProgress(script: WorkflowProgressInput) {
  const artifacts = script.artifacts || []
  const ready = artifacts.filter(item => item.status !== 'draft' && item.content.trim())
  const has = (type: string) => ready.some(item => item.artifact_type === type && !item.episode_number)
  const legacy = (type: string, content?: string) => !artifacts.some(item => item.artifact_type === type && !item.episode_number) && !!content?.trim()
  const episodes = [...new Set([
    ...ready.filter(item => item.artifact_type === 'episode_script').map(item => item.episode_number || 0),
    ...(script.scenes || []).map(item => item.episode_number || 0),
  ].filter(number => Number.isInteger(number) && number > 0 && number <= 200))].sort((a, b) => a - b)
  const count = Math.min(200, Math.max(1, script.generation_options?.episode_count || 200))
  const nextEpisode = Array.from({ length: count }, (_, index) => index + 1).find(number => !episodes.includes(number)) || null
  const completed: Record<WorkflowStage, boolean> = {
    outline: has('outline') || legacy('outline', script.outline),
    characters: has('characters') || legacy('characters', script.characters),
    locations: has('locations'), props: has('props'), episode: nextEpisode === null,
  }
  const missing = workflowStages.filter(stage => !completed[stage])
  return { completed, missing, next_stage: missing[0] || null, next_episode: nextEpisode, episodes }
}

export function workflowGuidance(script: WorkflowProgressInput): string {
  const progress = workflowProgress(script)
  const saved = workflowStages.filter(stage => progress.completed[stage] && stage !== 'episode').map(stage => workflowLabels[stage])
  return `创作推荐顺序：故事方向 → 全剧故事大纲 → 全剧人物设定与关系 → 全剧场景设计 → 全剧道具设计 → 指定集正文 → 分镜。大纲与人物可迭代，场景/道具按剧情需要补齐；这是建议顺序，不阻止创作者明确跳到指定阶段。\n` +
    `已保存全剧资料：${saved.join('、') || '无'}。已保存正文集数：${progress.episodes.join('、') || '无'}。\n` +
    (progress.next_stage ? `按已有成果推荐下一步：${progress.next_stage === 'episode' ? `第 ${progress.next_episode} 集正文` : workflowLabels[progress.next_stage]}。\n` : '已保存资料和已设定集数的正文已齐备，可核对连续性或制作分镜。\n') +
    '已有文档必须复用，不能声称它未生成或重复建议从头生成；仅当创作者要求修改或实际发现与新大纲的具体冲突时，说明受影响部分并建议针对性更新，保留无关内容。大纲更新不自动使人物/场景/道具失效，不强制重做。普通讨论的推进建议应先补最早缺失的全剧资料；仅提到下一阶段不自动授权生成文档。\n'
}


export function directorStageInstructions(context: DirectorStageContext): string {
  const label = context.stage ? workflowLabels[context.stage] : '连续性核对与分镜准备'
  return `\n【程序确定的当前创作阶段】\n${JSON.stringify(context)}\n本轮围绕${label}${context.episode_number ? `（第 ${context.episode_number} 集）` : ''}展开。` +
    '故事方向讨论属于大纲的准备：第一份正式成果应是全剧大纲；只追问会影响当前成果的关键设定，信息足够后提供生成当前阶段文档的操作，避免无休止补充细节。大纲阶段可问人物身份和关系，但这些问题用于主线设计，不能因此转去生成完整人物档案、场景、道具或分集正文。\n' +
    '每个交互必须附 interaction:{stage:当前阶段,purpose:setting|generate|revise,episode_number:仅分集时的目标集数}。stage 指该问题服务的正式成果，不是问题提到的人物或地点。setting 是补充设定或确认方案，不执行文档生成；generate/revise 是生成/修改本阶段文档的提议，必须用 kind:workflow_action 和 interaction 表达，不能伪装成同意按钮或将生成其他阶段放入选项。question_set 的每个问题各自携带 interaction。普通解释仍用自然语言。\n' +
    (context.stage ? `前述交互格式示例也必须补上 interaction。文档操作只返回 {"kind":"workflow_action","interaction":${JSON.stringify({ stage: context.stage, purpose: 'generate', ...(context.episode_number ? { episode_number: context.episode_number } : {}) })},"intro":"当前阶段的创作依据与生成建议"}，修改已有文档时 purpose 改为 revise；程序会提供明确生成按钮，不能自行声称已经生成或保存。\n` : '当前没有待生成阶段，不提出文档生成操作；可解释连续性与分镜准备事项，创作者明确指定修改目标后才进入对应阶段。\n') +
    (context.mode === 'review' ? '当前草稿待确认。可以讨论修改，但不提供任何新文档生成、下一阶段或分镜操作；提醒检查并保存或放弃草稿。\n' : context.mode === 'explicit' ? '创作者已明确指定本阶段，可针对性修改或跳转；只处理这个目标，不连带重做其他资料。\n' : '阶段由已保存成果决定，模型无权自行跳阶段。不能重复建议重新生成已保存文档。设定方案的同意、回答、跳过只确认该项设定，不代表阶段完成；草稿必须由创作者保存后才能推进。\n')
}

export type DirectorStageContext = {
  stage: WorkflowStage | null; episode_number: number | null;
  mode: 'default' | 'explicit' | 'review' | 'complete'; progress_key: string;
}
export type DirectorInteraction = {
  stage: WorkflowStage; purpose: 'setting' | 'generate' | 'revise'; episode_number?: number;
}

export function workflowProgressKey(script: WorkflowProgressInput): string {
  const progress = workflowProgress(script)
  return JSON.stringify([progress.completed, progress.episodes, progress.next_episode])
}

export function directorStageContext(script: WorkflowProgressInput, options: {
  pending?: { stage: WorkflowStage; episode_number: number };
  explicit?: { stage: WorkflowStage; episode_number: number };
  previous?: DirectorStageContext;
} = {}): DirectorStageContext {
  const progress = workflowProgress(script), progress_key = workflowProgressKey(script)
  const selected = options.pending || options.explicit
  if (selected) return { stage: selected.stage, episode_number: selected.stage === 'episode' ? selected.episode_number : null,
    mode: options.pending ? 'review' : 'explicit', progress_key }
  if (options.previous?.mode === 'explicit' && options.previous.progress_key === progress_key) return options.previous
  return { stage: progress.next_stage, episode_number: progress.next_stage === 'episode' ? progress.next_episode : null,
    mode: progress.next_stage ? 'default' : 'complete', progress_key }
}

/** Topic is not stage: a protagonist question can serve the outline. Document
 * transitions must match the current stage and wait for confirmed saving. */
export function allowsDirectorInteraction(interaction: DirectorInteraction | undefined, context: DirectorStageContext): boolean {
  if (!interaction || !context.stage || interaction.stage !== context.stage) return false
  if (interaction.stage === 'episode' && interaction.episode_number !== context.episode_number) return false
  if (interaction.purpose === 'setting') return true
  if (context.mode === 'review' || context.mode === 'complete') return false
  return interaction.purpose !== 'revise' || context.mode === 'explicit'
}
