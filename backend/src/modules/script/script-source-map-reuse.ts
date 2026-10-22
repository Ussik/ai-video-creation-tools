import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { scriptSourceVersion } from './script-source-identity.js'
import { scriptSourcePassages, sourceAnalysisPipelineVersion, sourceWorkPlan, validateSourceCoverage } from './script-source-map.js'
import { hasPassedSourceQuality } from './script-source-quality.js'
import { validateSourceStory } from './script-source-story.js'

type Source = { filename: string; content: string }
export type ScriptSourceMapReusePage = {
  offset: number; length: number; depth: 0
  /** Provisional directory candidates; a fresh full-source review is required. */
  reuse_sections?: ScriptSourceSection[]
  base_section_ids?: number[]
}
export type ScriptSourceMapReuseOptions = {
  enabled?: boolean
  maxChangedCharacters?: number
  maxChangedRatio?: number
}
export type ScriptSourceMapReusePlan = {
  mode: 'full' | 'incremental'
  reason: string
  base_source_version: string
  source_version: string
  input_hash: string
  change: { old_offset: number; old_length: number; new_offset: number; new_length: number } | null
  invalidated_old_section_ids: number[]
  pages: ScriptSourceMapReusePage[]
  reused_characters: number
  rebuilt_characters: number
}

const lowSurrogate = (value: number) => value >= 0xdc00 && value <= 0xdfff
const highSurrogate = (value: number) => value >= 0xd800 && value <= 0xdbff
const splitsSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length &&
  highSurrogate(text.charCodeAt(offset - 1)) && lowSurrogate(text.charCodeAt(offset))

/** One conservative envelope, not an approximate diff: distant edits include
 * the complete intervening text. Coordinates remain raw UTF-16 source offsets. */
function changedEnvelope(before: string, after: string): NonNullable<ScriptSourceMapReusePlan['change']> {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (splitsSurrogate(before, prefix) || splitsSurrogate(after, prefix)) prefix--
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  while (splitsSurrogate(before, before.length - suffix) || splitsSurrogate(after, after.length - suffix)) suffix--
  return { old_offset: prefix, old_length: before.length - prefix - suffix, new_offset: prefix, new_length: after.length - prefix - suffix }
}

function invalidatedSections(sections: ScriptSourceSection[], change: NonNullable<ScriptSourceMapReusePlan['change']>): Set<number> {
  const start = change.old_offset, end = start + change.old_length
  const affected = new Set(sections.flatMap((section, id) => {
    const stop = section.offset + section.length
    return change.old_length ? section.offset < end && stop > start ? [id] : [] : section.offset <= start && stop >= start ? [id] : []
  }))
  const closeEpisodesAndContinuations = () => {
    let previous = -1
    while (previous !== affected.size) {
      previous = affected.size
      const episodes = new Set([...affected].map(id => sections[id]!.episode_number).filter((episode): episode is number => episode !== null))
      sections.forEach((section, id) => { if (section.episode_number !== null && episodes.has(section.episode_number)) affected.add(id) })
      for (const id of affected) {
        for (let before = id; before > 0 && sections[before]!.continues_previous; before--) affected.add(before - 1)
        for (let after = id + 1; after < sections.length && sections[after]!.continues_previous; after++) affected.add(after)
      }
    }
  }
  closeEpisodesAndContinuations()
  // Expand arbitrary adjacency once. Recursively expanding neighbors would
  // eventually invalidate every section regardless of the actual edit.
  for (const id of [...affected]) for (const adjacent of [id - 1, id + 1]) {
    if (adjacent >= 0 && adjacent < sections.length) affected.add(adjacent)
  }
  closeEpisodesAndContinuations()
  return affected
}

function exactSectionsForPage(sections: ScriptSourceSection[], offset: number, length: number): number[] | null {
  const first = sections.findIndex(section => section.offset === offset)
  if (first < 0) return null
  const stop = offset + length, ids: number[] = []
  for (let id = first; id < sections.length; id++) {
    const section = sections[id]!
    if (section.offset >= stop || section.offset + section.length > stop) return null
    ids.push(id)
    if (section.offset + section.length === stop) return ids
  }
  return null
}

function remapSection(section: ScriptSourceSection, delta: number, content: string): ScriptSourceSection | null {
  const value = structuredClone(section)
  value.offset += delta
  delete value.unit_id
  // Independently copy evidence objects: fixtures or in-memory callers may
  // share one quote between a person and an event, and applying the shift
  // twice through that shared object would corrupt the new coordinates.
  value.characters = value.characters.map(item => ({ ...item, evidence: { ...item.evidence, offset: item.evidence.offset + delta } }))
  value.events = value.events.map(item => ({ ...item, evidence: { ...item.evidence, offset: item.evidence.offset + delta } }))
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset + value.length > content.length) return null
  for (const item of [...value.characters, ...value.events]) {
    const { offset, quote } = item.evidence
    if (!Number.isSafeInteger(offset) || offset < value.offset || offset + quote.length > value.offset + value.length ||
      !quote.trim() || content.slice(offset, offset + quote.length) !== quote) return null
  }
  return value
}

/** Reuses only exact directory ranges from a separately reviewed base version.
 * Semantic summaries may still depend on changed distant text: these are
 * provisional candidates, never a new story or passed quality result. The
 * caller must rebuild global understanding and independently review all new
 * source text, and fall back to a complete map rebuild for substantive issues. */
export function planScriptSourceMapReuse(previous: Source, previousAnalysis: ScriptSourceAnalysis, current: Source,
  options: ScriptSourceMapReuseOptions = {}): ScriptSourceMapReusePlan {
  const baseVersion = scriptSourceVersion(previous), sourceVersion = scriptSourceVersion(current)
  const pages: ScriptSourceMapReusePage[] = sourceWorkPlan(scriptSourcePassages(current.content)).map(page => ({ ...page, depth: 0 }))
  const inputHash = createHash('sha256').update(JSON.stringify(['source-map-reuse-v1', baseVersion, sourceVersion,
    previousAnalysis.source_version, previousAnalysis.pipeline_version, previousAnalysis.sections, previousAnalysis.quality, options])).digest('hex')
  let change: ScriptSourceMapReusePlan['change'] = null
  let invalidated: number[] = []
  const full = (reason: string): ScriptSourceMapReusePlan => ({ mode: 'full', reason, base_source_version: baseVersion, source_version: sourceVersion,
    input_hash: inputHash, change, invalidated_old_section_ids: invalidated, pages,
    reused_characters: 0, rebuilt_characters: current.content.length })
  if (options.enabled === false) return full('disabled')
  if (previous.filename !== current.filename) return full('filename_changed')
  if (!previous.content.length || !current.content.length) return full('empty_source')
  if (previous.content === current.content) return full('unchanged_source')
  if (previousAnalysis.source_version !== baseVersion) return full('base_version_mismatch')
  if (previousAnalysis.pipeline_version !== sourceAnalysisPipelineVersion && previousAnalysis.pipeline_version !== 5) return full('unsupported_pipeline')
  if (previousAnalysis.status !== 'ready' || previousAnalysis.phase !== 'ready' ||
    !Number.isSafeInteger(previousAnalysis.total_chunks) || previousAnalysis.total_chunks <= 0 ||
    previousAnalysis.completed_chunks !== previousAnalysis.total_chunks || previousAnalysis.completed_characters !== previous.content.length) return full('base_analysis_incomplete')
  try {
    if (!previousAnalysis.sections.length || previousAnalysis.sections.some(section =>
      !Number.isSafeInteger(section.offset) || !Number.isSafeInteger(section.length) ||
      [...section.characters, ...section.events].some(item => !Number.isSafeInteger(item.evidence.offset)))) return full('invalid_base_map')
    validateSourceCoverage(previous.content, previousAnalysis.sections)
    if (!hasPassedSourceQuality(previousAnalysis)) return full('base_quality_unverified')
    validateSourceStory(previousAnalysis, previousAnalysis.story)
  } catch { return full('invalid_base_map') }
  change = changedEnvelope(previous.content, current.content)
  const changedCharacters = Math.max(change.old_length, change.new_length)
  const maxChangedCharacters = options.maxChangedCharacters ?? 8_000, maxChangedRatio = options.maxChangedRatio ?? 0.2
  if (!Number.isFinite(maxChangedCharacters) || maxChangedCharacters < 0 || !Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) return full('invalid_reuse_policy')
  if (changedCharacters > maxChangedCharacters || changedCharacters > Math.min(previous.content.length, current.content.length) * maxChangedRatio) return full('change_scope_too_large')
  const dirty = invalidatedSections(previousAnalysis.sections, change)
  invalidated = [...dirty].sort((left, right) => left - right)
  const delta = current.content.length - previous.content.length
  const reusable = pages.map(page => {
    const stop = page.offset + page.length
    const oldOffset = stop <= change!.new_offset ? page.offset : page.offset >= change!.new_offset + change!.new_length ? page.offset - delta : null
    if (oldOffset === null || oldOffset < 0 || oldOffset + page.length > previous.content.length) return page
    if (previous.content.slice(oldOffset, oldOffset + page.length) !== current.content.slice(page.offset, stop)) return page
    const ids = exactSectionsForPage(previousAnalysis.sections, oldOffset, page.length)
    if (!ids || ids.some(id => dirty.has(id))) return page
    const sections = ids.map(id => remapSection(previousAnalysis.sections[id]!, page.offset - oldOffset, current.content))
    if (sections.some(section => !section)) return page
    return { ...page, reuse_sections: sections as ScriptSourceSection[], base_section_ids: ids }
  })
  const reused = reusable.reduce((sum, page) => sum + (page.reuse_sections ? page.length : 0), 0)
  if (!reused) return full('no_reusable_pages')
  return { mode: 'incremental', reason: 'unchanged_reviewed_map_ranges', base_source_version: baseVersion, source_version: sourceVersion,
    input_hash: inputHash, change, invalidated_old_section_ids: invalidated, pages: reusable,
    reused_characters: reused, rebuilt_characters: current.content.length - reused }
}

const orderedIds = (value: unknown): value is number[] => Array.isArray(value) && Array.from(value).every((id, index) =>
  Number.isSafeInteger(id) && id >= 0 && (!index || id > value[index - 1]!))
const equalIds = (left: number[], right: number[]) => left.length === right.length && left.every((id, index) => id === right[index])
const sectionContents = (section: ScriptSourceSection) => [section.offset, section.length, section.title, section.episode_number, section.summary,
  section.open_threads || [], section.characters.map(item => [item.name, item.description, item.evidence.offset, item.evidence.quote]),
  section.events.map(item => [item.summary, item.evidence.offset, item.evidence.quote])]

/** Validate the consumed candidate ledger independently of stored work pages.
 * A partial saved map must be a contiguous completed-page prefix, and every
 * reused page in that prefix must match its newly reconstructed candidate.
 * Exact source quote validation for generated pages remains the caller's
 * current-version coverage check; this function never trusts a ledger alone. */
export function validScriptSourceMapReuseState(state: ScriptSourceAnalysis, plan: ScriptSourceMapReusePlan): boolean {
  try {
    const reuse = state.revision_reuse
    if (plan.mode !== 'incremental' || !reuse || reuse.status !== 'pending' ||
      reuse.input_hash !== plan.input_hash || reuse.base_source_version !== plan.base_source_version ||
      reuse.source_version !== plan.source_version || state.source_version !== plan.source_version ||
      !orderedIds(reuse.planned_pages) || !orderedIds(reuse.reused_pages) || !orderedIds(reuse.reused_section_ids) ||
      !Number.isSafeInteger(reuse.reused_characters) || reuse.reused_characters < 0 ||
      !Number.isSafeInteger(state.completed_chunks) || state.completed_chunks < 0 || state.completed_chunks > plan.pages.length ||
      state.total_chunks !== plan.pages.length || !Array.isArray(state.sections)) return false
    let planEnd = 0
    for (const page of plan.pages) {
      if (!Number.isSafeInteger(page.offset) || page.offset !== planEnd || !Number.isSafeInteger(page.length) || page.length <= 0 || page.depth !== 0) return false
      planEnd += page.length
    }
    const plannedPages = plan.pages.flatMap((page, index) => page.reuse_sections?.length ? [index] : [])
    if (!plannedPages.length || !equalIds(reuse.planned_pages, plannedPages)) return false
    const reusedPages = plannedPages.filter(index => index < state.completed_chunks)
    if (!equalIds(reuse.reused_pages, reusedPages)) return false
    const prefixEnd = state.completed_chunks ? plan.pages[state.completed_chunks - 1]!.offset + plan.pages[state.completed_chunks - 1]!.length : 0
    if (state.completed_characters !== prefixEnd) return false
    let sectionEnd = 0
    for (const section of state.sections) {
      if (!Number.isSafeInteger(section.offset) || section.offset !== sectionEnd || !Number.isSafeInteger(section.length) || section.length <= 0 ||
        typeof section.title !== 'string' || !section.title.trim() || typeof section.summary !== 'string' || !section.summary.trim() ||
        !(section.episode_number === null || Number.isSafeInteger(section.episode_number) && section.episode_number > 0) ||
        section.continues_previous !== undefined && typeof section.continues_previous !== 'boolean' ||
        !Array.isArray(section.characters) || !Array.isArray(section.events) ||
        section.open_threads !== undefined && (!Array.isArray(section.open_threads) || section.open_threads.some(thread => typeof thread !== 'string'))) return false
      sectionEnd += section.length
      for (const item of [...section.characters, ...section.events]) {
        const evidence = item.evidence
        if (!evidence || !Number.isSafeInteger(evidence.offset) || typeof evidence.quote !== 'string' || !evidence.quote.trim() ||
          evidence.offset < section.offset || evidence.offset + evidence.quote.length > sectionEnd) return false
      }
      if (section.characters.some(item => typeof item.name !== 'string' || typeof item.description !== 'string') ||
        section.events.some(item => typeof item.summary !== 'string')) return false
    }
    if (sectionEnd !== prefixEnd) return false
    const reusedSectionIds: number[] = []
    let sectionIndex = 0, reusedCharacters = 0
    for (let pageIndex = 0; pageIndex < state.completed_chunks; pageIndex++) {
      const page = plan.pages[pageIndex]!, stop = page.offset + page.length, firstSection = sectionIndex
      if (state.sections[firstSection]?.offset !== page.offset) return false
      while (state.sections[sectionIndex] && state.sections[sectionIndex]!.offset < stop) {
        const section = state.sections[sectionIndex]!
        if (section.offset + section.length > stop) return false
        sectionIndex++
      }
      if (state.sections[sectionIndex - 1]!.offset + state.sections[sectionIndex - 1]!.length !== stop) return false
      if (!page.reuse_sections?.length) continue
      if (sectionIndex - firstSection !== page.reuse_sections.length) return false
      for (let localIndex = 0; localIndex < page.reuse_sections.length; localIndex++) {
        const id = firstSection + localIndex, actual = state.sections[id]!, expected = page.reuse_sections[localIndex]!, previous = state.sections[id - 1]
        const continued = !!previous && !!expected.continues_previous && previous.offset + previous.length === expected.offset &&
          !(previous.episode_number && expected.episode_number && previous.episode_number !== expected.episode_number)
        if (!!actual.continues_previous !== continued || JSON.stringify(sectionContents(actual)) !== JSON.stringify(sectionContents(expected))) return false
        reusedSectionIds.push(id)
      }
      reusedCharacters += page.length
    }
    return sectionIndex === state.sections.length && reuse.reused_characters === reusedCharacters && equalIds(reuse.reused_section_ids, reusedSectionIds)
  } catch { return false }
}
