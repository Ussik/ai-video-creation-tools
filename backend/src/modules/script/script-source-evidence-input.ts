import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceStoryTask } from './script-source-story-plan.js'
import type { SourcePassage, SourceWork } from './script-source-map.js'

/** Unit IDs remain global; no clipping or renumbering of evidence sentences. */
export function adjacentSourcePassages(passages: SourcePassage[], work: SourceWork, margin = 1200): SourcePassage[] {
  return passages.flatMap(p => {
    const units = p.units.filter(u => u.offset + u.text.length > Math.max(0, work.offset - margin) && u.offset < work.offset + work.length + margin)
    return units.length ? [{ ...p, units, offset: units[0]!.offset, content: units.map(u => u.text).join('') }] : []
  })
}

function indexedEvidence(value: unknown): any {
  if (Array.isArray(value)) return value.map(indexedEvidence)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => key === 'quote' && typeof child === 'string' ? ['length', child.length] : [key, indexedEvidence(child)]))
}

export function sourceStoryEvidenceInput(state: ScriptSourceAnalysis, source: { filename: string; content: string }, task: SourceStoryTask, extra: number[] = []) {
  const selected = new Set(task.section_ids || [])
  if (task.target_names?.length) state.sections.forEach((section, id) => {
    if (section.characters.some(c => task.target_names!.includes(c.name)) || task.target_names!.some(name => source.content.slice(section.offset, section.offset + section.length).includes(name))) selected.add(id)
  })
  for (const id of [...selected]) for (const neighbor of [id - 1, id + 1]) if (state.sections[neighbor]) selected.add(neighbor)
  // Explicit supporting references may be distant. Names stay in the global
  // locator index; sharing a protagonist alone does not select the whole book.
  state.sections.forEach((section, id) => {
    for (const ref of [...section.characters.map(c => c.evidence), ...section.events.map(e => e.evidence)]) {
      if (!selected.has(id)) continue
      for (const support of ref.supporting || []) {
        const linked = state.sections.findIndex(s => support.offset >= s.offset && support.offset < s.offset + s.length)
        if (linked >= 0) selected.add(linked)
      }
    }
  })
  extra.forEach(id => { if (!state.sections[id]) throw new Error('扩读只能引用真实章节'); selected.add(id) })
  const section_ids = [...selected].sort((a, b) => a - b)
  const ranges = section_ids.map(id => { const s = state.sections[id]!; return { section_id: id, offset: s.offset, length: s.length,
    content: source.content.slice(s.offset, s.offset + s.length) } })
  return { filename: source.filename, total_length: source.content.length, selected_section_ids: section_ids, source_ranges: ranges,
    position_index: state.sections.map((s, id) => ({ id, offset: s.offset, length: s.length, title: s.title, episode_number: s.episode_number,
      names: s.characters.map(c => c.name), knowledge_locators: (s.knowledge || []).map(k => ({ statement: k.statement, kind: k.kind, status: k.status })), event_locators: s.events.map(e => ({ summary: e.summary, evidence_offset: e.evidence.offset })), open_threads: s.open_threads || [] })),
    facts: section_ids.map(id => indexedEvidence({ id,
      characters: task.target_names?.length ? state.sections[id]!.characters.filter(c => task.target_names!.includes(c.name)) : [],
      knowledge: state.sections[id]!.knowledge || [] })),
    unresolved: section_ids.flatMap(id => (state.sections[id]!.knowledge_pending || []).map(item => ({ section_id: id, usage: 'not_accepted_do_not_use_as_fact', candidate: indexedEvidence(item.candidate) }))) }
}
