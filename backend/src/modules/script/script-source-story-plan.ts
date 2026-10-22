import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'

export type SourceStoryTask = {
  key: string; kind: 'overview' | 'characters' | 'characters_merge' | 'timeline' | 'threads' | 'uncertainties'
  target_names?: string[]; section_ids?: number[]; include_additional_characters?: boolean
  merge_candidates?: ScriptSourceStory['characters']; coverage_parent?: string
}

export function groups<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

/** Bound the expected response, not the source supplied for understanding.
 * Dense chapters receive smaller windows; sparse chapters need fewer full reads.
 * A single dense chapter remains intact and is never silently truncated. */
function outputGroups(state: ScriptSourceAnalysis, kind: 'timeline' | 'threads' | 'uncertainties'): number[][] {
  const result: number[][] = []
  let current: number[] = [], size = 0
  for (const [id, section] of state.sections.entries()) {
    const events = section.events.reduce((total, event) => total + Math.max(180, event.summary.length * 2 + 80), 0)
    const threads = (section.open_threads || []).reduce((total, thread) => total + Math.max(240, thread.length * 2 + 100), 0)
    const estimate = kind === 'timeline' ? 120 + events : kind === 'threads' ? 180 + threads + events / 2
      : 160 + section.summary.length / 2 + events / 4
    if (current.length && (size + estimate > 12_000 || current.length >= 32)) { result.push(current); current = []; size = 0 }
    current.push(id); size += estimate
  }
  if (current.length) result.push(current)
  return result
}

export function sourceStoryTasks(state: ScriptSourceAnalysis, legacy = false): SourceStoryTask[] {
  const names = [...new Map(state.sections.flatMap(section => section.characters.map(character =>
    [character.name.normalize('NFKC').trim(), character.name] as const))).values()]
  // Character batches retain the small evidence-pack scope and coverage recovery.
  const nameGroups = names.length ? groups(names, 12) : [[]]
  return [
    { key: 'overview', kind: 'overview' },
    ...nameGroups.map((target_names, index): SourceStoryTask => ({ key: `characters:${index}`, kind: 'characters', target_names, include_additional_characters: index === 0 })),
    ...(['timeline', 'threads', 'uncertainties'] as const).flatMap(kind =>
      (legacy ? groups(state.sections.map((_, id) => id), 12) : outputGroups(state, kind))
        .map((section_ids, index): SourceStoryTask => ({ key: `${kind}:${index}`, kind, section_ids }))),
  ]
}
