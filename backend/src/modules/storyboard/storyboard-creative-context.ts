import { one, all, type ScriptGenerationOptions, type ScriptScene } from '../../infrastructure/database/db.js'
import { activeCreatorRequirements } from '../script/script-creator-requirements.js'

type Target = { kind: 'scenes'; scenes: Pick<ScriptScene, 'id' | 'episode_number'>[] } | { kind: 'clip' }
type Decision = { id: string; topic: string; content: string; basis: string; source_text: string }

/** Scope used to be unrestricted prose. Only exact, explicit selectors can be
 * filtered mechanically; legacy prose remains labelled context for formal
 * scenes, and never proves applicability to an independent clip. */
function applicable(scope: string, target: Target) {
  if (scope === 'project' || scope === '项目级') return true
  if (scope === 'clip') return target.kind === 'clip'
  if (target.kind === 'clip') return false
  const episode = /^episode:([1-9]\d*)$/.exec(scope)
  if (episode) return target.scenes.some(scene => scene.episode_number === Number(episode[1]))
  if (scope.startsWith('scene:') && scope.length > 6) return target.scenes.some(scene => scene.id === scope.slice(6))
  return true
}

/** Read the persisted settings, not an unsaved form or a stale chat snapshot.
 * Independent clips inherit project art direction and audience/genre defaults,
 * but not the series plot, characters, structure or episode timing. */
export function storyboardCreativeContext(projectId: string, target: Target) {
  const row = one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', projectId)
  let settings: ScriptGenerationOptions = {}
  try {
    const parsed: unknown = JSON.parse(row?.generation_options || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as ScriptGenerationOptions
  } catch { /* Old invalid settings cannot become creative facts. */ }
  const fields: (keyof ScriptGenerationOptions)[] = target.kind === 'clip'
    ? ['genre', 'genre_fusion', 'audience', 'era', 'visual_style', 'visual_style_details']
    : ['genre', 'genre_fusion', 'audience', 'era', 'core_hook', 'visual_style', 'visual_style_details', 'story_structure', 'character_notes', 'episode_count', 'episode_duration']
  const generation_settings = Object.fromEntries(fields.filter(field => settings[field] !== undefined && settings[field] !== '')
    .map(field => [field, settings[field]]))
  const creator_requirements = activeCreatorRequirements(projectId).filter(item => applicable(item.scope, target))
    .map(({ id, kind, quote, scope }) => ({ id, kind, quote, scope }))
  // Decisions have no structured scope today. They help interpret formal
  // scenes, but cannot be safely imported into an independent clip's story.
  const confirmed_decisions = target.kind === 'clip' ? [] : all<Decision>(
    'SELECT id, topic, content, basis, source_text FROM script_story_decisions WHERE project_id=? ORDER BY id', projectId)
  return { creator_requirements, confirmed_decisions, generation_settings }
}
export type StoryboardCreativeContext = ReturnType<typeof storyboardCreativeContext>

export function storyboardCreativeContextVersion(context: StoryboardCreativeContext) {
  return context.creator_requirements.length || context.confirmed_decisions.length || Object.keys(context.generation_settings).length
    ? { creative_context: context } : {}
}

export const storyboardCreativeAuthority = '创作者本次明确指令优先于历史要求、已确认决定、生成设置和技能建议。' +
  'creator_requirements只含仍有效的台账原话；kind=requirement才是要求，kind=open_question是尚未确定的问题，不得升级为已确认事实或硬约束。' +
  '每条要求只在scope适用的范围生效；episode:N与scene:ID分别限定集和场，project为项目通用，clip仅适用于独立片段。' +
  '空scope或旧自由文本范围不证明全局适用，须结合原话与本次所选场次判断，不能把局部要求扩展到其他场次。' +
  'confirmed_decisions保留原始source_text和basis，仅作为解释本次相关内容的已确认背景，不据此添加其他场次剧情。' +
  'generation_settings是已保存的项目默认；本次明确时长、片段原文与导演要求覆盖不适用的默认，技能不得强加冲突的节奏、结构或结尾模板。'

export function storyboardCreativeContextPrompt(context: StoryboardCreativeContext) {
  return `${storyboardCreativeAuthority}\n项目创作上下文：${JSON.stringify(context)}\n`
}
