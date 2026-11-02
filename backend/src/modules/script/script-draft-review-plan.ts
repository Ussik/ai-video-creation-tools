import type { ScriptStage, StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import type { GenerationSteps } from './script-generation-steps.js'

export type ScriptDraftReviewIntent = 'source_outline' | 'stage_design'
export type ScriptDraftReviewScope = 'whole' | 'adaptive' | 'tasks'
export type DraftReviewSource = { key: string; artifact_type: StageArtifactType; title: string; content: string }
export type DraftReviewTask = { id: string; label: string; kind: 'deliverable' | 'consistency'; sources: DraftReviewSource[] }

const acceptance: Record<StageArtifactType, string> = {
  outline: '本次要求的故事前提、主角目标、主要冲突、关键事件与结局可理解，因果自洽。',
  synopsis: '故事简述准确表达本次主线、人物选择与结局，未漏掉改变故事走向的已知事件。',
  world: '本次剧情实际依赖的背景和规则能解释已写事件，不与已知事实矛盾。',
  structure: '已要求的分段顺序、关键转折与阶段衔接成立。',
  hooks: '已设计的钩子与真实剧情相容，不把观众未知误判为作者缺设定。',
  foreshadowing: '已设计的伏笔与回收相互对应，相关事件的因果与集位一致。',
  reversals: '已设计的反转有前提且后果不与既有事实矛盾。',
  constraints: '忠实保留创作者已明确的禁区与约束。',
  episode_outline: '已要求的各集关键事件与状态衔接合理，集数服从原稿及明确要求。',
  characters: '关键人物身份、目标与行为动机足以支撑当前剧情，不改变已确认事实。',
  relationships: '人物双方关系、冲突与变化和已有角色事实及剧情相容。',
  locations: '剧情必要地点名称、用途与出现关系一致。',
  location_layouts: '剧情实际依赖的空间、入口与动线能解释所写行动。',
  location_atmosphere: '已要求的视觉信息可理解且不与实际地点、时间和剧情矛盾。',
  location_continuity: '场景进入、离开与变化后的状态能承接实际事件。',
  props: '必要道具名称、用途及其人物关系一致。',
  prop_visuals: '已要求的辨识信息与具体道具事实相容。',
  prop_functions: '剧情实际依赖的道具功能和使用条件能解释事件，不强加普通物件的能力。',
  prop_continuity: '持有、转移、使用与最终去向符合已写事件。',
  episode_script: '本集事件因果、人物行动、正文与分场一致，承接已有大纲；必要动作和表达可理解。',
}

export function draftReviewAcceptance(sources: DraftReviewSource[]): string {
  return '【本次实际成果的检查范围】\n' + [...new Map(sources.map(source => [source.artifact_type, source])).values()]
    .map(source => `- ${source.title}：${acceptance[source.artifact_type]}`).join('\n') +
    '\n以上只检查本次已要求的内容，不能要求未交付文档或下阶段栏目；固定任务合同优先于通用创作指导。\n'
}

const groups: Partial<Record<ScriptStage, Array<{ id: string; label: string; artifacts: StageArtifactType[] }>>> = {
  outline: [
    { id: 'story', label: '核对故事主线与分集承接', artifacts: ['outline', 'synopsis', 'structure', 'episode_outline'] },
    { id: 'world', label: '核对背景规则与创作约束', artifacts: ['world', 'constraints'] },
    { id: 'payoffs', label: '核对钩子、伏笔与反转安排', artifacts: ['hooks', 'foreshadowing', 'reversals'] },
  ],
  locations: [
    { id: 'space', label: '核对地点用途与空间动线', artifacts: ['locations', 'location_layouts'] },
    { id: 'continuity', label: '核对场景视觉与连续性', artifacts: ['location_atmosphere', 'location_continuity'] },
  ],
  props: [
    { id: 'identity', label: '核对道具用途与外观辨识', artifacts: ['props', 'prop_visuals'] },
    { id: 'continuity', label: '核对道具规则与状态流转', artifacts: ['prop_functions', 'prop_continuity'] },
  ],
}

/** Split responsibilities, never source passages. Small work keeps its single
 * review. Large multi-document work gains reusable local tasks followed by a
 * mandatory full-work consistency check; no changed-key hint can skip it. */
export function planDraftReviewTasks(stage: ScriptStage, sources: DraftReviewSource[], scope: ScriptDraftReviewScope = 'whole'): DraftReviewTask[] {
  if (scope === 'whole' || scope === 'adaptive' && sources.reduce((sum, source) => sum + source.content.length, 0) < 16_000) return []
  const defined = groups[stage]
  if (!defined) return []
  const tasks: DraftReviewTask[] = defined.flatMap(group => {
    const selected = sources.filter(source => group.artifacts.includes(source.artifact_type))
    return selected.length ? [{ id: group.id, label: group.label, kind: 'deliverable' as const, sources: selected }] : []
  })
  if (tasks.length < 2) return []
  // Unknown future artifact types must still be reviewed locally and globally.
  const included = new Set(tasks.flatMap(task => task.sources.map(source => source.key)))
  const remaining = sources.filter(source => !included.has(source.key))
  if (remaining.length) tasks.push({ id: 'other', label: '核对其余本次交付内容', kind: 'deliverable', sources: remaining })
  return [...tasks, { id: 'consistency', label: '核对全部成果与原稿的一致性', kind: 'consistency', sources }]
}

/** Recovery/evidence modules keep their existing checkpoint protocol. Prefix
 * their step ids per logical task so one task cannot overwrite another's
 * recovery policy or mistake its result for a completed sibling. */
export function draftReviewTaskSteps(steps: GenerationSteps | undefined, id: string): GenerationSteps | undefined {
  if (!steps) return undefined
  const prefix = `review:task:${id}:`
  return {
    get checkpoint() {
      return { ...steps.checkpoint, steps: Object.fromEntries(Object.entries(steps.checkpoint.steps)
        .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value])) }
    },
    retain: (key, label, input, value, validate, parentId) => steps.retain(prefix + key, label, input, value, validate, parentId),
    forget: key => steps.forget(prefix + key),
    run: (key, label, input, work, validate, parentId) => steps.run(prefix + key, label, input, work, validate, parentId),
  }
}

/** Only known task-specific repair decisions are scoped. Full manuscript,
 * creator messages, shared facts and saved documents remain intact. The final
 * consistency task receives the original context without this projection. */
export function draftReviewTaskContext(context: unknown, sources: DraftReviewSource[]): unknown {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context
  const record = context as Record<string, unknown>, history = record.resolved_findings
  if (!history || typeof history !== 'object' || Array.isArray(history)) return context
  const resolution = history as Record<string, unknown>
  if (!Array.isArray(resolution.decisions) || !Array.isArray(resolution.summaries)) return context
  const keys = new Set(sources.map(source => source.key))
  const decisions = resolution.decisions.filter(item => !item || typeof item !== 'object' ||
    !('source_key' in item) || keys.has(String(item.source_key)))
  // A reply such as “use option two / same as above” can depend on another
  // document's history. Prefer a larger exact input over breaking that link.
  const referencesHistory = /(?:方案|选项)\s*[一二三四五六七八九十百零〇两\dA-Za-z]+|同上|同前|前述|上述|上文|(?:原|之前|此前|上次)(?:的)?(?:方案|建议|约定|决定|规则|设定|答案)|\b(?:option|plan)\s*[a-z\d]+\b/i
  if (decisions.some(item => item && typeof item === 'object' &&
    ['decision', 'answer'].some(key => key in item && typeof (item as Record<string, unknown>)[key] === 'string' &&
      referencesHistory.test((item as Record<string, unknown>)[key] as string)))) return context
  const summaryIds = new Set(decisions.flatMap(item => item && typeof item === 'object' && 'summary_id' in item ? [item.summary_id] : []))
  const summaries = resolution.summaries.filter(item => !item || typeof item !== 'object' || !('id' in item) || summaryIds.has(item.id))
  // A group with no decision of its own sees exactly what it saw before any
  // decision existed. Otherwise an unrelated document's repair would change this
  // group's input and force it to be reviewed again.
  if (!decisions.length && !summaries.length) {
    const { resolved_findings: _unrelated, ...withoutHistory } = record
    return withoutHistory
  }
  return { ...record, resolved_findings: { ...resolution, decisions, summaries } }
}
