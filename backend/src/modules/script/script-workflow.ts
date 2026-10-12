import { workflowProgress, stageOperations, type WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'
import { z } from 'zod'
import { parseStructuredOutput } from '../generation/structured-output.js'
import { maxStageArtifacts, missingStageArtifacts, scriptArtifactLabels, scriptArtifactTypes, scriptStageArtifacts, scriptStageDeliverables } from '@video-studio/shared/script/script-stage-content'
import { scriptDesignStageInstructions } from '@video-studio/shared/script/script-design-content'
import { scriptStageQualityGuidance } from '@video-studio/shared/script/script-quality'

const workflowRequestFields = z.object({
  stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']),
  operation: z.enum(stageOperations).optional(),
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
  source_scene_id: z.string().min(1).max(160).optional()
    .describe('仅重新设计已保存分集时使用：已有场次填写读取到的原场次ID，新场次省略；保留全部已有场次，不能复用或捏造ID'),
  heading: z.string().trim().min(1).max(120),
  location: z.string().max(500).default(''), time_of_day: z.string().max(120).default(''),
  characters: z.string().max(2000).default(''), action: z.string().max(10000).default(''),
  dialogue: z.string().max(10000).default(''), narration: z.string().max(10000).default(''),
  duration: z.number().int().min(1).max(30),
})
const workflowArtifact = z.object({
  artifact_type: z.enum(scriptArtifactTypes),
  title: z.string({ error: '文档标题必须是字符串，请补全 title 后重新提交' }).trim().min(1, '文档标题不能为空，请补全 title 后重新提交').max(160)
    .describe('必填的文档唯一标题，不能省略或留空'),
  content: z.string().trim().min(1).max(100000)
    .describe('完整可编辑正文，保留小节标题，不重复 title；补齐已有阶段时原样保留已有正文'),
}).strict()
const stageTypes = scriptStageArtifacts
export type WorkflowStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export const workflowStages: WorkflowStage[] = ['outline', 'characters', 'locations', 'props', 'episode']
export const workflowLabels = { outline: '全剧故事大纲', characters: '全剧人物设定', locations: '全剧场景设计', props: '全剧道具设计', episode: '分集剧本' }
export const workflowDraftInput = workflowRequestFields.extend({
  artifacts: z.array(workflowArtifact).min(1).max(maxStageArtifacts),
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
  if (draft.stage !== 'episode' && draft.scenes.some(scene => scene.source_scene_id)) {
    ctx.addIssue({ code: 'custom', message: '只有分集正文可关联已有场次', path: ['scenes'] })
  }
})
export const workflowDraftSchema = workflowDraftInput.transform(normalizeWorkflowRequest)
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>

// Historical saved drafts remain editable. Newly generated drafts must contain
// every deliverable for their stage before they can be offered for confirmation.
export const workflowGenerationDraftInput = workflowDraftInput.superRefine((draft, ctx) => {
  const missing = missingStageArtifacts(draft.stage, draft.artifacts)
  if (missing.length) ctx.addIssue({ code: 'custom', message: `当前阶段缺少完整文档：${missing.map(type => scriptArtifactLabels[type]).join('、')}`, path: ['artifacts'] })
})
export const workflowGenerationDraftSchema = workflowGenerationDraftInput.transform(normalizeWorkflowRequest)

/** Content standards also guide generation authorized through ordinary chat.
 * They describe deliverables without authorizing a new draft or bypassing discussion. */
export function workflowContentInstructions(request: z.infer<typeof workflowRequest>): string {
  const stages = {
    outline: `输出九份独立文档，不把其他栏目合并到 outline，也不要写分场正文：
outline（概要设计）：故事前提、核心冲突、主角目标与阻力、主题、起承转合和结局，覆盖全剧主线。
synopsis（故事简述）：从开端到结局的完整因果链，写清关键事件、人物选择与后果。
world（背景设定）：时代、地理、社会秩序、世界运行规则、能力边界与代价、视觉基调；区分确认事实和待定设定。
structure（全剧分段）：划分叙事阶段，说明各段的事件、冲突升级、人物变化、情绪节奏、转折及对应集数。
hooks（钩子预设）：分别规划开篇钩子、持续追看动力与各集结尾悬念，标明引出的问题、所在集数及后续兑现。
foreshadowing（伏笔与回收）：每条写出埋设事件、出现位置、观众当时理解、回收位置和作用；保持时间与因果一致。
reversals（反转预设）：每条说明前置认知、铺垫、揭示点、事实变化与人物代价，避免无依据的突然转折。
constraints（创作禁区）：明确已确认的硬规则、人物行为边界、风格和内容限制、不能破坏的事实，以及尚需作者决定的事项。
episode_outline（分集大纲）：覆盖用户明确要求的集数；每集包含目标、事件、冲突、因果推进、人物或道具状态变化、结尾悬念与下一集承接。未确认集数时写可编辑的分集方案并说明待定，不擅自确立集数。`,
    characters: `分别输出 characters（人物小传）和 relationships（人物关系）。
人物小传逐人列出身份、年龄或年龄段、外貌与服装、行为和说话习惯、背景经历、目标、动机、弱点、阻力、秘密与知情范围、主线作用、全剧弧光、分阶段变化、可复用视觉锚点和连续性约束。
人物关系列出对应双方、初始关系、诉求与利益冲突、依赖或权力关系、秘密和信息差、推动关系变化的事件及对应集数、变化后的状态。主次人物都有具体剧情依据，不新增无关人物或改写已确认主线。`,
    locations: scriptDesignStageInstructions('locations'),
    props: scriptDesignStageInstructions('props'),
    episode: `只写第 ${request.episode_number} 集，不写其他集。输出 episode_script 完整正文和对应 scenes；必须承接已确认的分集大纲、人物、地点、道具、伏笔与前集状态。
集标题写入 title 并标明第 ${request.episode_number} 集；正文包含开场承接、分场标题、地点与时间、出场人物、具体可拍动作、完整对白、必要旁白、冲突升级、转折、情绪停顿、结尾钩子以及留给下一集的状态。落实本集应埋设或回收的伏笔，保持角色知情范围与道具归属一致。
scenes 按正文顺序对应，覆盖正文事件、动作和对白，不遗漏或另写一套故事。${request.target_duration ? `本集总时长目标约 ${request.target_duration} 秒（不是全剧时长）。` : '按创作者明确的单集时长写作；未指定时由故事节奏判断。'} 每场1至30秒，按对白、动作和停顿分配，不机械均分。`,
  }
  return `本阶段必须完整包含：${scriptStageDeliverables(request.stage)}。\n${stages[request.stage]}\n` +
    scriptStageQualityGuidance(request.stage) +
    '各文档提供可编辑的完整正文，不能只列标题、模板或泛泛摘要。内容关联到具体人物、事件、集数或场次；确无适用内容时明确说明原因，不虚构事实。已有成果继续复用，定向修订保留未受影响的内容。\n' +
    '每份新文档的 title 是必填的唯一文档标题，必须为非空字符串；缺失或空白会被校验拒绝，需补全后重新提交。content 只写正文和小节标题，不在开头重复 title；正文无需再写文档总标题。补齐已有阶段时，已有文档的标题和正文仍须原样保留。\n' +
    '创作者明确授权模型决定后已经作出的具体设定应沿用，不标为待定；创作者后续修改优先。其他未知且未授权模型决定的设定标为待定，不把未获授权的建议当成已确认事实。\n'
}

export function workflowInstructions(request: z.infer<typeof workflowRequest>, protocol: 'json' | 'tools' = 'json'): string {
  const boundary = request.stage === 'episode'
    ? `任务范围：仅第 ${request.episode_number} 集正文。全剧资料和前集正文用于承接，不得修改其他集或全剧文档。`
    : '任务范围：整个项目的全剧资料，不属于任何单集。聊天中最近写过的集数、下一集计划以及创作要求中的单集措辞仅作背景，不能把本轮改为该集或下一集的文档。人物、地点和道具覆盖全剧已确认的内容；大纲覆盖全剧主线与结局。保持已保存各集事实。只更新所选资料，不生成、改写或推进分集正文。'
  return `\n本轮为“${workflowLabels[request.stage]}”${request.operation === 'regenerate' ? '整阶段重新设计' : request.operation === 'supplement' ? '补齐栏目' : request.operation === 'revise' ? '局部修订' : '文档生成'}。只完成本轮阶段，不提问、不声称已保存或已完成其他阶段。\n${boundary}\n${workflowContentInstructions(request)}` +
    (request.operation === 'regenerate' ? request.stage === 'episode'
      ? '创作者明确要求重新设计本集：先read_documents分段读完本集已保存正文及全部分场（用scene_next_offset继续分页；只有场次没有正文时用read_episode_scenes）。提交完整episode_script和按正文顺序同步的scenes；每个已有场次填source_scene_id为读取到的原ID，全部保留且各出现一次，可以改写和调整顺序；新场次省略source_scene_id。不得删除已有场次或按数组下标套用ID，不改写镜头或素材，不保存。工具模式使用create_document_draft建立待确认草稿。\n'
      : '创作者明确要求整阶段重新设计：先读完这个阶段全部原文，再通过create_document_draft提交全部栏目完整的新设计草稿；仅此操作允许改写已有文档，保留文档ID，不保存。\n' : '') +
    (protocol === 'tools' ? '新阶段将完整成果作为 create_document_draft 的参数提交；已有阶段缺少文档时，先 read_documents 读完已有原文，将已有文档的标题和正文原样保留并补齐缺失文档，一并提交完整阶段。已有文档的定向修改用 propose_document_patch；仅明确operation=regenerate时允许create_document_draft建立替代草稿；补齐草稿可继续用 manage_document_draft 修改。stage、scope、episode_number 使用本轮任务范围；artifacts 和 scenes 遵循以下内容结构。不要在正文模拟工具调用或直接返回 JSON 代替函数。内容结构：' : '只输出一个合法 JSON 对象，不要解释或代码围栏。格式：') +
    '{"artifacts":[{"artifact_type":"文档类型","title":"文档标题","content":"完整可编辑正文"}],"scenes":[' +
    `{${request.stage === 'episode' && request.operation === 'regenerate' ? '"source_scene_id":"已有场次的原ID（新场次省略此字段）",' : ''}"heading":"场次标题","location":"地点","time_of_day":"日/夜","characters":"出场人物","action":"画面动作","dialogue":"对白","narration":"旁白","duration":秒数}]}。` +
    `本阶段文档类型必须且只允许 ${stageTypes[request.stage].join('、')}，各类型恰好一份且正文非空；非分集阶段 scenes 必须为空数组。\n`
}

export function parseWorkflowDraft(raw: string, request: z.infer<typeof workflowRequest>): WorkflowDraft | null {
  const result = parseStructuredOutput(raw, workflowEnvelope)
  if (!result) return null
  const parsed = workflowGenerationDraftSchema.safeParse({ ...request, ...result })
  if (!parsed.success) return null
  return parsed.data
}

export const workflowEnvelope = z.object({ artifacts: z.array(workflowArtifact).min(1).max(maxStageArtifacts), scenes: z.array(workflowScene).max(100).default([]) }).strict()

export function workflowReply(draft: WorkflowDraft): string {
  const scope = draft.stage === 'episode' ? `第 ${draft.episode_number} 集` : workflowLabels[draft.stage]
  return `${scope}草稿已生成：${draft.artifacts.length} 份文档${draft.scenes.length ? `，${draft.scenes.length} 场、${draft.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : ''}。请检查下方预览，确认后保存并继续下一阶段。`
}

export { workflowProgress } from '@video-studio/shared/script/script-stage-access'
export type { WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'

export function workflowGuidance(script: WorkflowProgressInput): string {
  const progress = workflowProgress(script)
  const saved = workflowStages.filter(stage => progress.completed[stage] && stage !== 'episode').map(stage => workflowLabels[stage])
  return `创作推荐顺序：故事方向 → 全剧故事大纲 → 全剧人物设定与关系 → 全剧场景设计 → 全剧道具设计 → 指定集正文 → 分镜。大纲与人物可迭代，场景/道具按剧情需要补齐；未保存阶段必须依次生成并确认保存；已保存阶段可随时明确指定修改、补齐或重新设计。\n` +
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
    (context.mode === 'review' ? '当前草稿待确认。可以讨论修改，但不提供任何新文档生成、下一阶段或分镜操作；提醒检查并保存或放弃草稿。\n' : context.mode === 'explicit' ? '创作者已明确指定本阶段，可针对性处理已保存阶段；未保存阶段仍须依序生成。只处理这个目标，不连带重做其他资料。\n' : '阶段由已保存成果决定，模型无权自行跳阶段。不能重复建议重新生成已保存文档。设定方案的同意、回答、跳过只确认该项设定，不代表阶段完成；草稿必须由创作者保存后才能推进。\n')
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
