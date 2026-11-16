import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages, validateSourceCoverage } from './script-source-map.js'
import { scriptSourceVersion } from './script-source-identity.js'
import type { ScriptCharacterSourceContext } from './script-character-source-context.js'
/** A candidate is not an identity decision. Include every literal occurrence,
 * adjacent source units, final disclosure and frozen full-read hypotheses.
 * The model explicitly escalates missing pronoun/identity context to full source. */
export function sourceCharacterMergeContext(state: ScriptSourceAnalysis, source: { filename: string; content: string },
  candidates: ScriptSourceStory['characters'], overview?: Pick<ScriptSourceStory, 'summary' | 'ending' | 'settings'>): ScriptCharacterSourceContext | undefined {
  if (process.env.VIDEO_STUDIO_SCRIPT_CHARACTER_CONTEXT === '0' || process.env.VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT === '0' ||
    state.source_version !== scriptSourceVersion(source) || !overview || !candidates.length) return
  try { validateSourceCoverage(source.content, state.sections) } catch { return }
  const names = [...new Set(candidates.flatMap(item => [item.name, ...item.aliases]))]
  const units = scriptSourcePassages(source.content).flatMap(passage => passage.units), selected = new Set<number>()
  for (const name of names) {
    const hits = units.flatMap((unit, index) => unit.text.normalize('NFKC').includes(name.normalize('NFKC').trim()) ? [index] : [])
    if (!hits.length) return
    for (const index of hits) for (const neighbor of [index - 1, index, index + 1]) if (units[neighbor]) selected.add(neighbor)
  }
  // The original ending can be needed even if it only uses pronouns.
  for (const id of overview.ending.section_ids) {
    const section = state.sections[id]
    if (!section) return
    units.forEach((unit, index) => { if (unit.offset >= section.offset && unit.offset < section.offset + section.length) selected.add(index) })
  }
  const ranges: ScriptCharacterSourceContext['source_ranges'] = []
  for (const index of [...selected].sort((a, b) => a - b)) {
    const unit = units[index]!, previous = ranges.at(-1)
    if (previous && previous.offset + previous.length === unit.offset) previous.length += unit.text.length
    else ranges.push({ offset: unit.offset, length: unit.text.length, section_ids: [], content: '' })
  }
  for (const range of ranges) {
    range.content = source.content.slice(range.offset, range.offset + range.length)
    range.section_ids = state.sections.flatMap((section, id) => section.offset < range.offset + range.length && section.offset + section.length > range.offset ? [id] : [])
  }
  const selectedLength = ranges.reduce((sum, range) => sum + range.length, 0)
  if (selectedLength >= source.content.length * 0.8) return
  const sectionIds = [...new Set(ranges.flatMap(range => range.section_ids))].sort((a, b) => a - b)
  return { mode: 'targeted', reason: 'merge_exact_source_occurrences', source_version: scriptSourceVersion(source), analysis_source_version: state.source_version,
    context_hash: createHash('sha256').update(JSON.stringify(['merge-evidence-v1', state.source_version, candidates, ranges, overview])).digest('hex'),
    known_names: names, selected_section_ids: sectionIds, source_ranges: ranges, literal_matches: names.map(name => ({ name,
      section_ids: state.sections.flatMap((section, id) => source.content.slice(section.offset, section.offset + section.length).includes(name) ? [id] : []), raw_match_section_ids: [] })),
    identity_hypotheses: candidates, global_background: { ...overview, interpretation_only: true },
    coverage: { complete_source: false, total_length: source.content.length, selected_length: selectedLength, total_sections: state.sections.length, selected_sections: sectionIds.length } }
}
