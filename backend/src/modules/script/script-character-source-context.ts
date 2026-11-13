import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceSection, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { scriptSourceVersion } from './script-source-identity.js'
import { validateSourceCoverage } from './script-source-map.js'

type Character = ScriptSourceStory['characters'][number]
type Overview = Pick<ScriptSourceStory, 'summary' | 'ending'>
type Source = { filename: string; content: string }
export type ScriptCharacterSourceContextOptions = {
  targetNames: readonly string[]
  includeAdditionalCharacters?: boolean
  /** Validated results of the first, complete-manuscript discovery task. */
  seedCharacters?: readonly Character[]
  /** Validated complete-manuscript overview; background, never primary evidence. */
  overview?: Overview
  enabled?: boolean
  maxSelectedCharacters?: number
}
export type ScriptCharacterSourceContext = {
  mode: 'full' | 'targeted'
  reason: string
  source_version: string
  analysis_source_version: string
  context_hash: string
  known_names: string[]
  selected_section_ids: number[]
  /** Full mode keeps the original source in its existing prompt field. */
  source_ranges: Array<{ offset: number; length: number; section_ids: number[]; content: string }>
  literal_matches: Array<{ name: string; section_ids: number[]; raw_match_section_ids: number[] }>
  /** Full-read model hypotheses, retained verbatim for semantic identity review. */
  identity_hypotheses?: readonly Character[]
  global_background?: Overview & { interpretation_only: true }
  coverage: { complete_source: boolean; total_length: number; selected_length: number; total_sections: number; selected_sections: number }
}

const normalize = (name: string) => name.normalize('NFKC').trim()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function literalCount(text: string, name: string): number {
  let count = 0
  for (let offset = 0; offset < text.length;) {
    const found = text.indexOf(name, offset)
    if (found < 0) break
    count++; offset = found + 1
  }
  return count
}

function expandSections(selected: Set<number>, sections: ScriptSourceSection[]): number[] {
  const episodes = new Set([...selected].map(id => sections[id]!.episode_number).filter((value): value is number => value !== null))
  sections.forEach((section, id) => { if (section.episode_number !== null && episodes.has(section.episode_number)) selected.add(id) })
  const neighbors = new Set(selected)
  for (const id of selected) for (const adjacent of [id - 1, id + 1]) {
    if (adjacent >= 0 && adjacent < sections.length) neighbors.add(adjacent)
  }
  // Include full continuity chains around the selected episodes and neighbors.
  // Do not recursively add another arbitrary neighbor at every iteration.
  for (const id of neighbors) {
    for (let before = id; before > 0 && sections[before]!.continues_previous; before--) neighbors.add(before - 1)
    for (let after = id + 1; after < sections.length && sections[after]!.continues_previous; after++) neighbors.add(after)
  }
  return [...neighbors].sort((left, right) => left - right)
}

function rangesFor(ids: number[], sections: ScriptSourceSection[], content: string): ScriptCharacterSourceContext['source_ranges'] {
  const ranges: ScriptCharacterSourceContext['source_ranges'] = []
  for (const id of ids) {
    const section = sections[id]!, previous = ranges.at(-1)
    if (previous && previous.offset + previous.length === section.offset) {
      previous.length += section.length; previous.section_ids.push(id)
    } else ranges.push({ offset: section.offset, length: section.length, section_ids: [id], content: '' })
  }
  return ranges.map(range => ({ ...range, content: content.slice(range.offset, range.offset + range.length) }))
}

/** A deterministic evidence pack for later character batches only. Full
 * discovery, global overview and final independent audit remain full-source.
 * A literal match locates a spelling; it never proves identity or completeness
 * of a character interpretation. The complete directory stays in the caller's
 * prompt as location/background clues rather than replacing exact source. */
export function buildScriptCharacterSourceContext(state: Pick<ScriptSourceAnalysis, 'source_version' | 'sections'>,
  source: Source, options: ScriptCharacterSourceContextOptions): ScriptCharacterSourceContext {
  const sourceVersion = scriptSourceVersion(source)
  const contextHash = hash(['script-character-context-v4', sourceVersion, state.source_version, state.sections, options])
  const base = { source_version: sourceVersion, analysis_source_version: state.source_version, context_hash: contextHash }
  const full = (reason: string): ScriptCharacterSourceContext => ({ ...base, mode: 'full', reason,
    known_names: [...options.targetNames], selected_section_ids: state.sections.map((_, id) => id), source_ranges: [], literal_matches: [],
    coverage: { complete_source: true, total_length: source.content.length, selected_length: source.content.length,
      total_sections: state.sections.length, selected_sections: state.sections.length } })
  if (options.enabled === false) return full('disabled')
  if (options.includeAdditionalCharacters) return full('full_discovery_required')
  if (state.source_version !== sourceVersion) return full('analysis_version_mismatch')
  if (!options.seedCharacters?.length) return full('full_discovery_missing')
  if (!options.overview?.summary.trim() || !options.overview.ending.summary.trim() ||
    !options.overview.ending.section_ids.length || options.overview.ending.section_ids.some(id => !state.sections[id])) return full('global_overview_missing')
  try { validateSourceCoverage(source.content, state.sections) } catch { return full('invalid_source_map') }
  if (!state.sections.length || !options.targetNames.length) return full('no_target_names')
  const targets = [...new Map(options.targetNames.map(name => [normalize(name), name])).entries()]
  if (targets.some(([name]) => !name)) return full('empty_character_name')
  const sectionText = state.sections.map(section => source.content.slice(section.offset, section.offset + section.length).normalize('NFKC'))
  const fullText = source.content.normalize('NFKC')
  const known = new Map<string, string>(targets)
  // Even when the final scene omits all character names, keep its original
  // words available to verify final states rather than relying on the summary.
  const selected = new Set<number>(options.overview.ending.section_ids)
  const matches = new Map<string, ScriptCharacterSourceContext['literal_matches'][number]>()
  const seedIdentities = new Map<string, Character>()
  for (const character of options.seedCharacters) {
    const identity = [...new Set([character.name, ...character.aliases].map(normalize))].sort()
    // Identical repeated representations are harmless; overlapping but
    // different identities need a full read rather than an implicit union.
    // Equal spellings alone do not establish equal people: retain different
    // descriptions independently so uncertainty in a later entry is not lost.
    const key = JSON.stringify([identity, normalize(character.description)])
    const previous = seedIdentities.get(key)
    seedIdentities.set(key, previous ? { ...previous,
      section_ids: [...new Set([...previous.section_ids, ...character.section_ids])] } : character)
  }
  const usedSeed = new Set<Character>()
  for (const [key, display] of known) {
    if (!key) return full('empty_character_name')
    const raw = sectionText.flatMap((text, id) => text.includes(key) ? [id] : [])
    const directory = state.sections.flatMap((section, id) => section.characters.some(character => normalize(character.name) === key) ? [id] : [])
    // Summary/event/thread mentions may locate a pronoun-only consequence or
    // distant payoff omitted from the character list. They select the exact
    // source for inspection; they do not establish a name or identity match.
    const hints = state.sections.flatMap((section, id) =>
      [section.summary, ...section.events.map(event => event.summary), ...(section.open_threads || [])]
        .some(text => normalize(text).includes(key)) ? [id] : [])
    // Normalization can compose characters over a boundary; compare counts on
    // both forms so no matching name occurrence silently falls between ranges.
    if (literalCount(fullText, key) !== sectionText.reduce((count, text) => count + literalCount(text, key), 0)) return full('cross_section_literal_match')
    if (!raw.length) return full('name_without_source_evidence')
    const identities = [...seedIdentities.values()].filter(character => [character.name, ...character.aliases].some(name => normalize(name) === key))
    if (identities.length > 1) return full('ambiguous_seed_identity')
    // A directory entry is only a location clue. If the complete-manuscript
    // discovery did not establish a corresponding hypothesis, read the full
    // original rather than treating absence of uncertainty words as certainty.
    if (!identities.length) return full('unknown_seed_identity')
    const related = identities[0]
    if (related && !usedSeed.has(related)) {
      usedSeed.add(related)
      if (!related.section_ids.length || related.section_ids.some(id => !Number.isInteger(id) || !state.sections[id])) return full('invalid_seed_evidence')
      for (const name of [related.name, ...related.aliases]) {
        const aliasKey = normalize(name)
        // The seed proposes a relationship after reading the full source; its
        // spellings still require raw evidence in its cited sections. This
        // gate does not claim to prove that the identity proposal is true.
        if (!aliasKey || !related.section_ids.some(id => sectionText[id]!.includes(aliasKey))) return full('alias_without_source_evidence')
        known.set(aliasKey, name)
      }
      related.section_ids.forEach(id => selected.add(id))
    }
    const ids = [...new Set([...raw, ...directory, ...hints])].sort((left, right) => left - right)
    matches.set(key, { name: display, section_ids: ids, raw_match_section_ids: raw })
    ids.forEach(id => selected.add(id))
  }
  const ids = expandSections(selected, state.sections)
  const ranges = rangesFor(ids, state.sections, source.content)
  const selectedLength = ranges.reduce((sum, range) => sum + range.length, 0)
  const limit = options.maxSelectedCharacters ?? 24_000
  if (!Number.isFinite(limit) || limit <= 0 || selectedLength > limit || selectedLength >= source.content.length * 0.75) return full('selected_scope_too_large')
  return { ...base, mode: 'targeted', reason: 'character_evidence_scope', known_names: [...known.values()], selected_section_ids: ids,
    source_ranges: ranges, literal_matches: [...matches.values()], identity_hypotheses: [...usedSeed],
    global_background: { ...options.overview, interpretation_only: true },
    coverage: { complete_source: false, total_length: source.content.length, selected_length: selectedLength,
      total_sections: state.sections.length, selected_sections: ids.length } }
}
