import { workflowProgress, stageOperations, type WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'
import { z } from 'zod'
import { parseStructuredOutput } from '../generation/structured-output.js'
import { maxStageArtifacts, missingStageArtifacts, scriptArtifactLabels, scriptArtifactTypes, scriptStageArtifacts, scriptStageDeliverables } from '@video-studio/shared/script/script-stage-content'
import { scriptDesignArtifactGuidance, scriptDesignStageInstructions } from '@video-studio/shared/script/script-design-content'
import { scriptStageQualityGuidance } from '@video-studio/shared/script/script-quality'
import { scriptSettingCompletenessGuidance } from '@video-studio/shared/script/script-setting-completeness'
import { scriptTaskArtifactTypes, scriptTaskDeliverables, scriptTaskAcceptance } from '@video-studio/shared/script/script-task-contract'
import { maxScriptSceneDuration } from '@video-studio/shared/script/script-duration'

const workflowRequestFields = z.object({
  stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']),
  operation: z.enum(stageOperations).optional(),
  scope: z.enum(['project', 'episode']).optional(),
  episode_number: z.number().int().min(0).max(200).default(1),
  target_duration: z.number().int().min(5).max(600).optional(),
  intent: z.enum(['source_outline', 'stage_design']).optional(),
  artifact_types: z.array(z.enum(scriptArtifactTypes)).min(1).max(maxStageArtifacts).optional(),
}).strict()

function validateScope(request: z.infer<typeof workflowRequestFields>, ctx: z.RefinementCtx) {
  const scope = request.stage === 'episode' ? 'episode' : 'project'
  if (request.scope && request.scope !== scope) ctx.addIssue({ code: 'custom', message: '创作范围与阶段不一致', path: ['scope'] })
  if (scope === 'episode' && request.episode_number < 1) ctx.addIssue({ code: 'custom', message: '分集正文必须指定目标集数', path: ['episode_number'] })
  if (request.intent === 'source_outline' && request.stage !== 'outline') ctx.addIssue({ code: 'custom', message: '原稿大纲任务只适用于故事大纲阶段', path: ['intent'] })
  if (request.artifact_types && (new Set(request.artifact_types).size !== request.artifact_types.length ||
    request.artifact_types.some(type => !(scriptStageArtifacts[request.stage] as readonly string[]).includes(type)))) {
    ctx.addIssue({ code: 'custom', message: '任务成果必须属于当前阶段且不能重复', path: ['artifact_types'] })
  }
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
  duration: z.number().int().min(1).max(maxScriptSceneDuration)
    .describe('本场完整剧情的估计表演时长，单位为秒，1至600的整数；按完整对白、旁白、动作与必要停顿估计，不是镜头秒数，不按固定字速或机械均分'),
})

export const scriptSceneDurationRepairInstructions = '候选来源 scene:N:duration 是该场完整表演的估计秒数，content 为纯整数；' +
  '需要修正估时时，只将该来源精确替换为1至600的整数数字，不附加单位或说明。结合该场完整对白、旁白、动作、反应与停顿估计，不使用固定字速。' +
  '本集合计由逐场估时重新计算，是只读比较数据，不能作为补丁来源或直接修改；时长明显冲突时调整有依据的场次估时，保留全部已确认对白与必要动作。' +
  '无法兼容创作者明确时长时说明具体冲突，不通过删除或改写对白凑秒数。\n'

export function parseScriptSceneDurationReplacement(content: string): number {
  if (!/^\s*[1-9]\d*\s*$/.test(content)) throw new Error('场次估计时长须修订为以秒为单位的整数，不附加单位或说明')
  return workflowScene.shape.duration.parse(Number(content))
}
const workflowArtifact = z.object({
  artifact_type: z.enum(scriptArtifactTypes),
  title: z.string({ error: '文档标题必须是字符串，请补全 title 后重新提交' }).trim().min(1, '文档标题不能为空，请补全 title 后重新提交').max(160)
    .describe('必填的文档唯一标题，不能省略或留空'),
  content: z.string().trim().min(1).max(100000)
    .describe('按本次任务合同提供完整可编辑正文；整理原稿时保留原稿未知，授权创作时落实具体方案。保留小节标题，不重复 title；补齐时原样保留已有正文'),
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
  if (types.some(type => !allowed.includes(type)) || new Set(types).size !== types.length ||
    (!draft.artifact_types && !types.includes(allowed[0] as typeof types[number]))) {
    ctx.addIssue({ code: 'custom', message: '草稿文档与当前创作阶段不一致', path: ['artifacts'] })
  }
  if (draft.stage === 'episode' && !draft.scenes.length) {
    ctx.addIssue({ code: 'custom', message: '分集正文缺少对应分场，请保留正文并补齐 scenes', path: ['scenes'] })
  } else if (draft.stage !== 'episode' && draft.scenes.length) {
    ctx.addIssue({ code: 'custom', message: '当前项目资料阶段不应包含分场剧本，scenes 必须为空数组', path: ['scenes'] })
  }
  if (draft.stage !== 'episode' && draft.scenes.some(scene => scene.source_scene_id)) {
    ctx.addIssue({ code: 'custom', message: '只有分集正文可关联已有场次', path: ['scenes'] })
  }
})
export const workflowDraftSchema = workflowDraftInput.transform(normalizeWorkflowRequest)
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>

// Validate the declared task contract. Historical drafts without one retain
// their whole-stage completeness requirements.
export const workflowGenerationDraftInput = workflowDraftInput.superRefine((draft, ctx) => {
  const expected = scriptTaskArtifactTypes(draft)
  const missing = expected.filter(type => !draft.artifacts.some(item => item.artifact_type === type && item.content.trim()))
  if (missing.length) ctx.addIssue({ code: 'custom', message: `当前阶段缺少完整文档：${missing.map(type => scriptArtifactLabels[type]).join('、')}`, path: ['artifacts'] })
  if (draft.artifacts.some(item => !expected.includes(item.artifact_type))) ctx.addIssue({ code: 'custom', message: '草稿超出本次约定的任务成果范围', path: ['artifacts'] })
})
export const workflowGenerationDraftSchema = workflowGenerationDraftInput.transform(normalizeWorkflowRequest)

/** Content standards also guide generation authorized through ordinary chat.
 * They describe deliverables without authorizing a new draft or bypassing discussion. */
export function workflowContentInstructions(request: z.infer<typeof workflowRequest>): string {
  const stages = {
    outline: `输出九份独立文档，不把其他栏目合并到 outline，也不要写分场正文：
outline（概要设计）：故事前提、核心冲突、主角目标与阻力、主题、起承转合和结局，覆盖全剧主线。
synopsis（故事简述）：从开端到结局的完整因果链，写清关键事件、人物选择与后果。
world（背景设定）：时代、地理、社会秩序、世界运行规则、能力触发条件、边界、限制与代价、视觉基调；保留已确认事实，将本次授权设计的虚构规则写成具体方案。
structure（全剧分段）：划分叙事阶段，说明各段的事件、冲突升级、人物变化、情绪节奏、转折及对应集数。
hooks（钩子预设）：规划开篇吸引力、持续追看动力与适用的结尾安排，标明关注点、所在集数及后续兑现；是否设置悬念由题材、叙事阶段与创作者明确要求决定，不要求每集留下悬念，终集以主线和情感兑现为准。
foreshadowing（伏笔与回收）：每条写出埋设事件、出现位置、观众当时理解、回收位置和作用；保持时间与因果一致。
reversals（反转预设）：每条说明前置认知、铺垫、揭示点、事实变化与人物代价，避免无依据的突然转折。
constraints（创作禁区）：明确已确认的硬规则、人物行为边界、风格和内容限制、不能破坏的事实；本次设计的创作边界写成具体方案，不额外列一组普通设定要求作者逐项决定。
episode_outline（分集大纲）：覆盖用户明确要求的集数；每集包含目标、事件、冲突、因果推进、人物或道具状态变化、当集结果与情感落点，以及适用的后续承接或追看动力；是否设置悬念由题材、叙事阶段与创作者明确要求决定，终集完成主线、人物弧光和关键伏笔的兑现。未指定集数时依据主线提出明确集数的可编辑草案，说明创作依据；不把默认配置当成创作者确认，不自动改项目设置。`,
    characters: `分别输出 characters（人物小传）和 relationships（人物关系）。
人物小传逐人列出身份、年龄或年龄段、外貌与服装、行为和说话习惯、背景经历、目标、动机、弱点、阻力、秘密与知情范围、主线作用、全剧弧光、分阶段变化、可复用视觉锚点和连续性约束。
人物关系列出对应双方、初始关系、诉求与利益冲突、依赖或权力关系、秘密和信息差、推动关系变化的事件及对应集数、变化后的状态。主次人物都有具体剧情依据，不新增无关人物或改写已确认主线。`,
    locations: '',
    props: '',
    episode: `只写第 ${request.episode_number} 集，不写其他集。输出 episode_script 完整正文和对应 scenes；必须承接已确认的分集大纲、人物、地点、道具、伏笔与前集状态。
集标题写入 title 并标明第 ${request.episode_number} 集；正文包含开场承接、分场标题、地点与时间、出场人物、具体可拍动作、完整对白、必要旁白、冲突推进、适用的转折和情绪停顿、当集结果与情感落点，以及适用的后续承接状态。是否设置悬念由题材、叙事阶段与创作者明确要求决定，终集完成主线、人物弧光和关键伏笔的兑现。落实本集应埋设或回收的伏笔，保持角色知情范围与道具归属一致。
scenes 按正文顺序对应，覆盖正文事件、动作和对白，不遗漏或另写一套故事。${request.target_duration ? `本集总时长目标约 ${request.target_duration} 秒（不是全剧时长）。` : '按创作者明确的单集时长写作；未指定时由故事节奏判断。'} 每场1至600秒，duration 是本场完整剧情的估计表演秒数，不是单个视频镜头的时长。按完整对白、旁白、动作、人物反应与必要停顿估时，不机械均分，不按固定字速计算；短无声动作可以只有2秒，完整对话场不能只为填写合法数字而压成2秒。逐场估计后核对本集合计与明确的时长要求；无法同时保留完整内容和满足明确时长时，指出具体冲突，不删改对白或遗漏动作来凑秒数。`,
  }
  const selected = scriptTaskArtifactTypes(request)
  const content = request.stage === 'outline'
    ? stages.outline.split('\n').filter(line => selected.some(type => line.startsWith(`${type}（`))).join('\n')
    : request.stage === 'characters' && selected.length === 1
      ? stages.characters.split('\n').filter(line => line.startsWith(selected[0] === 'characters' ? '人物小传逐人' : '人物关系列出')).join('\n')
    : request.stage === 'locations' || request.stage === 'props'
      ? selected.length === stageTypes[request.stage].length ? scriptDesignStageInstructions(request.stage)
        : selected.map(type => `${type}（${scriptArtifactLabels[type]}）：${scriptDesignArtifactGuidance[type] || ''}`).join('\n')
      : stages[request.stage]
  const taskScope = `本次任务只交付：${scriptTaskDeliverables(request)}。未选择的栏目不生成、不作为交付缺失。\n` +
    scriptTaskAcceptance(request).map(item => `- ${item}`).join('\n') + '\n'
  if (request.intent === 'source_outline') return taskScope +
    '根据完整原稿整理一份完整、可阅读的大纲，写清原稿已有的核心人物、冲突、关键选择与事件因果；原稿写到哪里就整理到哪里，不编造后续结局、能力代价或伏笔答案。允许开放结局和原稿尚未揭示的信息。\n' +
    '每份文档必须有非空title与完整content，正文保留小节标题且不重复总标题。只生成候选稿，正式保存须经创作者确认。\n'
  return taskScope + `${content}\n` +
    scriptStageQualityGuidance(request.stage) +
    '各文档提供可编辑的完整正文，不能只列标题、模板或泛泛摘要。内容关联到具体人物、事件、集数或场次；确无适用内容时明确说明原因，不改写已确认事实。已有成果继续复用，定向修订保留未受影响的内容。\n' +
    '每份新文档的 title 是必填的唯一文档标题，必须为非空字符串；缺失或空白会被校验拒绝，需补全后重新提交。content 只写正文和小节标题，不在开头重复 title；正文无需再写文档总标题。补齐已有阶段时，已有文档的标题和正文仍须原样保留。\n' +
    '创作者明确授权模型决定后已经作出的具体设定应沿用，不标为待定；创作者后续修改优先。\n' +
    (request.artifact_types ? '按本任务的固定验收要求自检，不把未选择栏目或下阶段细节升级为本轮任务。\n' : scriptSettingCompletenessGuidance(request.stage))
}

export function workflowInstructions(request: z.infer<typeof workflowRequest>, protocol: 'json' | 'tools' = 'json'): string {
  const singleDocument = request.stage !== 'episode' && request.artifact_types?.length === 1
  const scenesExample = request.stage === 'episode'
    ? `[{${request.operation === 'regenerate' ? '"source_scene_id":"已有场次的原ID（新场次省略此字段）",' : ''}"heading":"场次标题","location":"地点","time_of_day":"日/夜","characters":"出场人物","action":"画面动作","dialogue":"对白","narration":"旁白","duration":秒数}]`
    : '[]'
  const boundary = request.stage === 'episode'
    ? `任务范围：仅第 ${request.episode_number} 集正文。全剧资料和前集正文用于承接，不得修改其他集或全剧文档。`
    : request.intent === 'source_outline'
    ? '任务范围：整理上传原稿已有的完整故事，整理到原稿当前结尾。原稿未说明的内容保持未知，原稿只读；只生成本次约定的大纲，不推进其他文档或分集正文。'
    : '任务范围：整个项目的全剧资料，不属于任何单集。聊天中最近写过的集数、下一集计划以及创作要求中的单集措辞仅作背景，不能把本轮改为该集或下一集的文档。人物、地点和道具覆盖全剧已确认的内容；大纲覆盖全剧主线与结局。保持已保存各集事实。只更新所选资料，不生成、改写或推进分集正文。'
  return `\n本轮为“${workflowLabels[request.stage]}”${request.operation === 'regenerate' ? singleDocument ? '所选栏目重新设计' : '整阶段重新设计' : request.operation === 'supplement' ? '补齐栏目' : request.operation === 'revise' ? '局部修订' : '文档生成'}。只完成本轮阶段，不为普通创作细节重复提问或要求逐项授权，不声称已保存或已完成其他阶段。\n${boundary}\n${workflowContentInstructions(request)}` +
    (request.operation === 'regenerate' ? request.stage === 'episode'
      ? '创作者明确要求重新设计本集：先read_documents分段读完本集已保存正文及全部分场（用scene_next_offset继续分页；只有场次没有正文时用read_episode_scenes）。提交完整episode_script和按正文顺序同步的scenes；每个已有场次填source_scene_id为读取到的原ID，全部保留且各出现一次，可以改写和调整顺序；新场次省略source_scene_id。不得删除已有场次或按数组下标套用ID，不改写镜头或素材，不保存。工具模式使用create_document_draft建立待确认草稿。\n'
      : singleDocument ? '先读取所选栏目及关联资料，再通过create_document_draft提交本次所选栏目的完整新设计草稿；保留文档ID，其他栏目只作参考，不改写、不保存。\n'
        : '创作者明确要求整阶段重新设计：先读完这个阶段全部原文，再通过create_document_draft提交全部栏目完整的新设计草稿；仅此操作允许改写已有文档，保留文档ID，不保存。\n' : '') +
    (protocol === 'tools' ? '新阶段将完整成果作为 create_document_draft 的参数提交；已有阶段缺少文档时，先 read_documents 读完已有原文，将已有文档的标题和正文原样保留并补齐缺失文档，一并提交完整阶段。已有文档的定向修改用 propose_document_patch；仅明确operation=regenerate时允许create_document_draft建立替代草稿；补齐草稿可继续用 manage_document_draft 修改。stage、scope、episode_number 使用本轮任务范围；artifacts 和 scenes 遵循以下内容结构。不要在正文模拟工具调用或直接返回 JSON 代替函数。内容结构：' : '只输出一个合法 JSON 对象，不要解释或代码围栏。格式：') +
    `{"artifacts":[{"artifact_type":"文档类型","title":"文档标题","content":"完整可编辑正文"}],"scenes":${scenesExample}}。` +
    `本次文档类型必须且只允许 ${scriptTaskArtifactTypes(request).join('、')}，各类型恰好一份且正文非空；非分集阶段 scenes 必须为空数组。\n`
}

export function parseWorkflowDraft(raw: string, request: z.infer<typeof workflowRequest>): WorkflowDraft | null {
  const result = parseStructuredOutput(raw, workflowEnvelope)
  if (!result) return null
  const parsed = workflowGenerationDraftSchema.safeParse({ ...request, ...result })
  if (!parsed.success) return null
  return parsed.data
}

export const workflowEnvelope = z.object({ artifacts: z.array(workflowArtifact).min(1).max(maxStageArtifacts), scenes: z.array(workflowScene).max(100).default([]) }).strict()

export function workflowDraftFieldInstructions(stage: WorkflowStage, artifactTypes: readonly string[] = stageTypes[stage]): string {
  return '最外层必须是包含 artifacts 和 scenes 两个数组的完整对象，不能只返回单份文档、单个场次或场次数组。' +
    'artifacts 中每份文档必须且只能包含 artifact_type、title、content 三个字段。' +
    'artifact_type 是必填的文档类型，不得用 type 代替；历史资料中的 type、status、episode_number 和保存元数据只用于理解上下文，不得复制到输出文档。' +
    `本轮 artifact_type 只允许 ${artifactTypes.join('、')}，每种恰好一份；不要把中文文档名、道具名或小节名当作文档类型。` +
    'title 和 content 必须保留原任务要求的完整内容；只修正字段结构，不压缩、改写或遗漏正文。' +
    (stage === 'episode' ? 'source_scene_id、heading、location、time_of_day、characters、action、dialogue、narration、duration 都是 scenes 数组成员的字段，不是最外层字段；保留场次内容并放入 scenes，不要因外层格式错误删除这些内容。即使只有一场，也须同时返回完整 episode_script 文档和 scenes 数组。scenes 必须提供至少一个完整场次，按本集正文顺序覆盖全部动作和对白，不能省略或返回空数组。' : 'scenes 必须返回空数组。')
}

/** Narrow the actual wire schema as well as the prose instructions. Keep the
 * generic envelope for historical drafts and streamed-unit recovery. */
export function workflowStageEnvelope(stage: WorkflowStage, artifactTypes: ReturnType<typeof scriptTaskArtifactTypes> = [...stageTypes[stage]]) {
  return workflowEnvelope.extend({
    artifacts: z.array(workflowArtifact.extend({
      artifact_type: z.enum(artifactTypes as [typeof artifactTypes[number], ...typeof artifactTypes[number][]]).describe('必填文档类型；仅使用本任务列出的类型标识'),
    })).min(1).max(artifactTypes.length),
    scenes: stage === 'episode' ? z.array(workflowScene).min(1, '分集正文必须包含至少一个对应场次').max(100)
      .describe('必填，按本集正文顺序提供至少一个完整场次并覆盖全部正文，不能省略或返回空数组')
      : z.array(z.object({}).strict()).max(0).default([])
      .describe('全剧资料没有分场，必须返回空数组'),
  }).describe(workflowDraftFieldInstructions(stage, artifactTypes))
}

/** Function calling needs the same stage boundary on the wire as JSON output;
 * superRefine alone is invisible to providers' JSON Schema implementations. */
export function workflowStageDraftInput(stage: WorkflowStage, artifactTypes: ReturnType<typeof scriptTaskArtifactTypes> = [...stageTypes[stage]]) {
  const fields = workflowStageEnvelope(stage, artifactTypes).shape
  return workflowGenerationDraftInput.safeExtend({
    stage: z.literal(stage), artifacts: fields.artifacts,
    // The project-stage wire schema permits only []; it is consequently a
    // subtype of the runtime scene array even though Zod infers {}[].
    scenes: fields.scenes as unknown as typeof workflowEnvelope.shape.scenes,
  })
}

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
