import type { ScriptArtifact, ScriptScene, Shot } from '../../infrastructure/database/db.js'

export type VisualAnalysisProfile = { id: string; kind: string; name: string; variant: string; definition: string; view_requirements: string;
  base_profile_id?: string | null; state_delta?: string; source_draft_key?: string | null }
export const visualScopeScenes = (scenes: ScriptScene[]) => scenes.map(({ id, episode_number, heading, location, characters, action, dialogue, narration }) =>
  ({ id, episode_number, heading, location, characters, action, dialogue, narration }))
export const visualScopeShots = (shots: Shot[]) => shots.map(({ id, source_scene_id, title, prompt, image_prompt, video_prompt, start_state, end_state }) =>
  ({ shot_id: id, scene_id: source_scene_id, title, prompt, image_prompt, video_prompt, start_state, end_state }))

const globalTypes = new Set(['world', 'constraints'])
const visualTypes = new Set(['characters', 'locations', 'location_layouts', 'location_atmosphere', 'location_continuity', 'props', 'prop_visuals', 'prop_functions', 'prop_continuity'])
function label(value: string): string {
  return value.replace(/[（(][^）)]*[）)]/gu, '').replace(/^(?:人物|角色|道具|场景)\s*\d*\s*[:：.、-]?\s*/u, '')
    .replace(/(?:连续性|外观与辨识|外观设计|视觉设计)$/u, '').trim()
}
/** Select whole semantic records/subtrees, never a character-prefix/suffix.
 * Scope evidence is always complete; selecting reference facts does not decide
 * which objects appear. World rules remain global and deduplicated. */
export function visualAnalysisFacts(input: { outline: string; characters: string; artifacts: ScriptArtifact[]; scenes: ScriptScene[]; shots: Shot[];
  profiles: VisualAnalysisProfile[]; objectName?: string }) {
  const scopeText = JSON.stringify([visualScopeScenes(input.scenes), visualScopeShots(input.shots)])
  const names = input.objectName ? [input.objectName] : [...new Set([
    ...input.scenes.flatMap(scene => [scene.location, ...(scene.characters || '').split(/[、,，;；\n]/u)].map(value => value?.trim()).filter((value): value is string => !!value && value.length > 1)),
    ...input.profiles.filter(profile => scopeText.includes(profile.name)).map(profile => profile.name),
  ])]
  const sceneLabels = input.scenes.map(scene => (scene.heading || '').match(/EP\d+-SC\d+/iu)?.[0] || scene.heading || '')
  const documents = [{ id: 'outline', title: '故事概要', content: input.outline || '', type: 'outline' },
    { id: 'characters', title: '人物资料', content: input.characters || '', type: 'characters' },
    ...input.artifacts.filter(item => !item.episode_number || input.scenes.some(scene => scene.episode_number === item.episode_number))
      .map(({ id, title, content, artifact_type }) => ({ id, title, content, type: artifact_type }))]
  const seen = new Set<string>()
  return documents.flatMap(document => {
    const content = document.content.replace(/\r\n/g, '\n'), hasHeadings = /^#{1,6}\s/mu.test(content)
    const sections = content.split(hasHeadings ? /\n(?=#{1,6}\s)/u : /\n\s*\n/u).map(text => text.trim()).filter(Boolean)
    let selectedLevel: number | undefined
    const selected = sections.filter((section, index) => {
      const match = section.match(/^(#{1,6})\s+([^\n]+)/u), level = match?.[1]?.length
      if (level !== undefined && selectedLevel !== undefined && level <= selectedLevel) selectedLevel = undefined
      const heading = label(match?.[2] || ''), tokens = heading.split(/[与、/]/u).map(value => value.trim()).filter(value => value.length > 1)
      const namedHeading = !!heading && tokens.some(token => scopeText.includes(token) || names.some(name => label(name) === token))
      const ownScene = sceneLabels.some(value => value && section.includes(value))
      const global = globalTypes.has(document.type)
      const narrativePremise = ['outline', 'synopsis'].includes(document.type) && index === 0
      const visual = visualTypes.has(document.type)
      // For object documents, an unrelated object's body mentioning the hero
      // is not a reason to load that object's entire profile. Explicit headings
      // and their child sections are authoritative record boundaries.
      const unstructuredMatch = (!hasHeadings || !match) && names.some(name => section.includes(name))
      const tableMatch = visual && section.includes('|') && names.some(name => section.includes(name))
      const relevant = global || narrativePremise || ownScene || namedHeading || selectedLevel !== undefined || unstructuredMatch || tableMatch || !hasHeadings && content.length <= 1200
      if (relevant && level !== undefined && (namedHeading || ownScene)) selectedLevel = level
      if (!relevant || seen.has(section)) return false
      seen.add(section)
      return true
    })
    return selected.length ? [{ source_id: document.id, title: document.title, sections: selected }] : []
  })
}
export function visualScopeBlock(scenes: ScriptScene[], shots: Shot[]) {
  return '【本次范围数据，只读】\n' + JSON.stringify({ legal_scene_ids: scenes.map(scene => scene.id), legal_shot_ids: shots.map(shot => shot.id),
    scenes: visualScopeScenes(scenes), planned_shots: visualScopeShots(shots) })
}
