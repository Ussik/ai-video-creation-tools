import { sourcePositionIndex } from '@video-studio/shared/script/script-source-position-index'
import { sourceKnowledgeSchema, assessSourceKnowledge } from './script-source-knowledge.js'
import { z } from 'zod'
import type { ScriptSourceSection } from '@video-studio/shared/script/script-source-document'

export type SourceUnit = { id: number; offset: number; text: string }
export type SourcePassage = { id: number; offset: number; content: string; units: SourceUnit[] }
export type SourceWork = { offset: number; length: number; depth: number; result?: unknown }
export const sourceAnalysisPipelineVersion = 6

/** Stable sentence/line IDs are the only coordinates the model writes. Every
 * character belongs to one unit, including whitespace and surrogate pairs. */
export function scriptSourcePassages(content: string): SourcePassage[] {
  const passages: SourcePassage[] = []
  const headings = [...content.matchAll(/^[ \t]{0,8}(?:#{1,2}[ \t]+|第[一二三四五六七八九十百千万零两〇\d]+[集场幕章回]|(?:INT|EXT)[. \t])/gm)].map(match => match.index)
  let headingIndex = 0, unitId = 0
  for (let offset = 0; offset < content.length;) {
    while (headings[headingIndex] !== undefined && headings[headingIndex]! <= offset) headingIndex++
    let end = Math.min(content.length, offset + 1200)
    if (headings[headingIndex] !== undefined && headings[headingIndex]! < end) end = headings[headingIndex]!
    else if (end < content.length) {
      const newline = content.lastIndexOf('\n', end - 1)
      if (newline >= offset + 600) end = newline + 1
      if (content.charCodeAt(end) >= 0xdc00 && content.charCodeAt(end) <= 0xdfff) end--
    }
    const units: SourceUnit[] = []
    for (let at = offset; at < end;) {
      let next = Math.min(end, at + 200)
      const boundary = /[\n。！？!?](?:[”’」』）)]*)/.exec(content.slice(at, next))
      if (boundary) next = at + boundary.index + boundary[0].length
      if (content.charCodeAt(next) >= 0xdc00 && content.charCodeAt(next) <= 0xdfff) next--
      units.push({ id: unitId++, offset: at, text: content.slice(at, next) }); at = next
    }
    passages.push({ id: passages.length, offset, content: content.slice(offset, end), units }); offset = end
  }
  return passages
}

const sourceOutputPageTarget = 8000
const sourceOutputPageMaximum = 12000
const sourceSinglePageLimit = 16000
const sourceHeadingStart = /^[ \t]{0,8}(?:#{1,2}[ \t]+|第[一二三四五六七八九十百千万零两〇\d]+[集场幕章回]|(?:INT|EXT)[. \t])/

/** These ranges bound the directory output, not the source context supplied to
 * the model. Every page still reads the whole manuscript. Prefer semantic
 * headings near the target; long uninterrupted scenes use passage boundaries.
 * All boundaries retain the original stable evidence units. */
export function sourceWorkPlan(passages: SourcePassage[], dense = false): SourceWork[] {
  const length = passages.at(-1) ? passages.at(-1)!.offset + passages.at(-1)!.content.length : 0
  if (!length) return []
  const target = dense ? 3000 : sourceOutputPageTarget, maximum = dense ? 4500 : sourceOutputPageMaximum
  if (length <= (dense ? 4500 : sourceSinglePageLimit)) return [{ offset: 0, length, depth: 0 }]
  const stableStarts = new Set(passages.flatMap(passage => passage.units.map(unit => unit.offset)))
  const headings = dense ? sourcePositionIndex(passages.map(p => p.content).join('')).entries.map(entry => entry.offset).filter(offset => stableStarts.has(offset))
    : passages.filter(passage => sourceHeadingStart.test(passage.content)).map(passage => passage.offset)
  const boundaries = passages.map(passage => passage.offset)
  const units = passages.flatMap(passage => passage.units.map(unit => unit.offset))
  const work: SourceWork[] = []
  let offset = 0
  while (offset < length) {
    if (length - offset <= maximum) {
      work.push({ offset, length: length - offset, depth: 0 }); break
    }
    const nearest = (positions: number[]) => positions.filter(position =>
      position >= offset + target / 2 && position <= offset + maximum)
      .sort((a, b) => Math.abs(a - offset - target) - Math.abs(b - offset - target) || b - a)[0]
    const end = nearest(headings) ?? nearest(boundaries) ?? nearest(units)
    if (end === undefined) throw new Error('剧本目录分页未找到完整句段边界，不能截断原文')
    work.push({ offset, length: end - offset, depth: 0 }); offset = end
  }
  return work
}

export function workPassages(passages: SourcePassage[], work: SourceWork): SourcePassage[] {
  const end = work.offset + work.length
  return passages.flatMap(passage => {
    // Directory pages and local evidence repairs validate their exact ranges;
    // the source context sent for understanding still contains the full text.
    const units = passage.units.flatMap(unit => {
      const start = Math.max(unit.offset, work.offset), stop = Math.min(unit.offset + unit.text.length, end)
      return start < stop ? [{ ...unit, offset: start, text: unit.text.slice(start - unit.offset, stop - unit.offset) }] : []
    })
    return units.length ? [{ ...passage, offset: units[0]!.offset, content: units.map(unit => unit.text).join(''), units }] : []
  })
}

/** Keep every character on the wire without wasting IDs on blank lines.
 * Evidence still resolves against the original stable units; only trailing
 * whitespace is attached to the previous displayed unit. */
export function sourcePromptUnits(units: SourceUnit[]): Array<Pick<SourceUnit, 'id' | 'text'>> {
  const compact: Array<Pick<SourceUnit, 'id' | 'text'>> = []
  for (const unit of units) {
    if (!unit.text.trim() && compact.length) compact.at(-1)!.text += unit.text
    else compact.push({ id: unit.id, text: unit.text })
  }
  return compact
}

const evidence = z.object({ unit_id: z.number().int().min(0) }).strict()
export const legacySourceMapSectionSchema = z.object({
  start_unit: z.number().int().min(0), title: z.string().trim().min(1).max(120), episode_number: z.number().int().min(1).max(10000).nullable(),
  summary: z.string().trim().min(1).max(1200),
  characters: z.array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(160), evidence }).strict()).max(24),
  events: z.array(z.object({ summary: z.string().trim().min(1).max(160), evidence }).strict()).max(24),
  continues_previous: z.boolean().default(false), open_threads: z.array(z.string().trim().min(1).max(200)).max(24).default([]),
}).strict()
export const legacySourceMapSchema = z.object({ sections: z.array(legacySourceMapSectionSchema).min(1).max(1000) }).strict()
// Fact storage has no display-card length/count ceiling. Output pagination and
// bounded provider requests control work size; presentation can clip visually.
// Characters can reference identity from earlier chapters via occurrence_unit_id
export const characterEvidenceSchema = evidence.extend({
  occurrence_unit_id: z.number().int().min(0).optional(),
  supporting_unit_ids: z.array(z.number().int().min(0)).optional(),
}).strict()
// Events must occur within the current section, so no occurrence_unit_id
export const eventEvidenceSchema = evidence.extend({
  supporting_unit_ids: z.array(z.number().int().min(0)).optional(),
}).strict()
// Legacy: unified schema for backward compatibility
export const sourceMapEvidenceSchema = evidence.extend({
  occurrence_unit_id: z.number().int().min(0).optional(),
  supporting_unit_ids: z.array(z.number().int().min(0)).optional(),
}).strict()
export const sourceMapSectionSchema = legacySourceMapSectionSchema.extend({
  knowledge: sourceKnowledgeSchema.optional(),
  characters: z.array(z.object({ name: legacySourceMapSectionSchema.shape.characters.element.shape.name,
    description: z.string().trim().min(1), evidence: characterEvidenceSchema }).strict()),
  events: z.array(z.object({ summary: z.string().trim().min(1), evidence: eventEvidenceSchema }).strict()),
  open_threads: z.array(z.string().trim().min(1)).default([]),
})
export const sourceMapSchema = z.object({ sections: z.array(sourceMapSectionSchema).min(1).max(1000) }).strict()
export type SourceMapResult = z.infer<typeof sourceMapSchema>
export type EvidenceProblem = { section: number; kind: 'characters' | 'events'; index: number; message: string }

/** Remove only redundant evidence references. The primary reference always
 * wins, and the first occurrence of each supporting reference is retained. */
export function canonicalizeSourceMapEvidence(result: SourceMapResult): SourceMapResult {
  const canonicalEvidence = <T extends { unit_id: number; supporting_unit_ids?: number[] }>(evidence: T): T => {
    const seen = new Set<number>([evidence.unit_id])
    const supporting_unit_ids = (evidence.supporting_unit_ids || []).filter(unitId => {
      if (seen.has(unitId)) return false
      seen.add(unitId)
      return true
    })
    if (supporting_unit_ids.length) return { ...evidence, supporting_unit_ids }
    const { supporting_unit_ids: _removed, ...withoutSupporting } = evidence
    return withoutSupporting as T
  }
  return {
    ...result,
    sections: result.sections.map(section => ({
      ...section,
      characters: section.characters.map(character => ({ ...character, evidence: canonicalEvidence(character.evidence) })),
      events: section.events.map(event => ({ ...event, evidence: canonicalEvidence(event.evidence) })),
    })),
  }
}

export type SourceBoundaryProblem = {
  kind: 'missing_first' | 'out_of_window' | 'not_increasing'
  section_index: number
  path: string
  actual: number
  expected_first?: number
  previous_start?: number
  next_start?: number
}

/** Code-owned diagnostics keep the exact failed boundary, rather than asking
 * the model to infer it from a generic coverage error. */
export function sourceMapBoundaryProblems(result: SourceMapResult, passages: SourcePassage[]): SourceBoundaryProblem[] {
  const units = passages.flatMap(passage => passage.units)
  if (!units.length) throw new Error('当前原文范围没有可用unit，不能建立章节目录')
  const ids = new Set(units.map(unit => unit.id)), first = units[0]!.id
  const problems: SourceBoundaryProblem[] = []
  for (const [index, section] of result.sections.entries()) {
    const actual = section.start_unit, previous = result.sections[index - 1]?.start_unit, next = result.sections[index + 1]?.start_unit
    const base = { section_index: index, path: `sections.${index}.start_unit`, actual,
      ...(previous !== undefined ? { previous_start: previous } : {}), ...(next !== undefined ? { next_start: next } : {}) }
    if (!ids.has(actual)) problems.push({ ...base, kind: 'out_of_window' })
    if (index === 0 && actual !== first) problems.push({ ...base, kind: 'missing_first', expected_first: first })
    if (index > 0 && previous !== undefined && ids.has(actual) && ids.has(previous) && actual <= previous) problems.push({ ...base, kind: 'not_increasing' })
  }
  return problems
}

/** Auto-fix common boundary alignment issues before throwing errors.
 * Based on industry best practice: constraint post-processing instead of strict validation.
 * Reference: "LLMs struggle to enforce external constraints" - use external logic to enforce them. */
function autoFixBoundaryProblems(result: SourceMapResult, passages: SourcePassage[], problems: SourceBoundaryProblem[]): SourceMapResult | null {
  const fixed = structuredClone(result)
  const units = passages.flatMap(p => p.units)
  const unitIds = new Set(units.map(u => u.id))
  const first = units[0]!.id

  for (const problem of problems) {
    const section = fixed.sections[problem.section_index]
    if (!section) return null

    if (problem.kind === 'missing_first' && problem.section_index === 0) {
      // Auto-fix: First section doesn't start at window first_unit
      // This is the most common issue - just adjust to window start
      section.start_unit = first
    } else if (problem.kind === 'not_increasing') {
      // Auto-fix: Section start_unit not increasing
      // Find next valid unit after previous section
      const prevSection = fixed.sections[problem.section_index - 1]
      if (!prevSection) return null

      const nextUnit = units.find(u => u.id > prevSection.start_unit)
      if (nextUnit && unitIds.has(nextUnit.id)) {
        section.start_unit = nextUnit.id
      } else {
        return null // Cannot auto-fix: no valid next unit
      }
    } else if (problem.kind === 'out_of_window') {
      // Cannot auto-fix: unit ID not in current window
      // This requires regeneration or window adjustment
      return null
    }
  }

  return fixed
}

export function sourceSectionRanges(result: SourceMapResult, passages: SourcePassage[]): SourceWork[] {
  const units = passages.flatMap(passage => passage.units)
  let problems = sourceMapBoundaryProblems(result, passages)

  // Try auto-fix before throwing error (industry best practice: constraint post-processing)
  if (problems.length) {
    const fixed = autoFixBoundaryProblems(result, passages, problems)
    if (fixed) {
      // Verify fix was successful
      const newProblems = sourceMapBoundaryProblems(fixed, passages)
      if (newProblems.length === 0) {
        // Auto-fix succeeded, use fixed result
        result = fixed
        problems = []
      } else {
        // Auto-fix didn't resolve all issues, proceed to throw
        problems = newProblems
      }
    }
    // If auto-fix failed or problems remain, throw original error
  }

  if (problems.length) {
    const outside = problems.find(problem => problem.kind === 'out_of_window')
    const detail = problems.map(problem => `${problem.path}=${problem.actual}: ${problem.kind}` +
      (problem.expected_first !== undefined ? `，要求首unit=${problem.expected_first}` : '') +
      (problem.previous_start !== undefined ? `，前一边界=${problem.previous_start}` : '') +
      (problem.next_start !== undefined ? `，后一边界=${problem.next_start}` : '')).join('；')
    throw Object.assign(new Error((outside ? `${outside.path}=${outside.actual} 不属于当前原文范围；` : '') +
      '章节边界必须从所给原文第一个unit开始并递增，不能遗漏、重复或重叠；' + detail), {
      code: 'source_map_boundary_invalid', sourceBoundaryProblems: problems,
    })
  }
  const end = units.at(-1)!.offset + units.at(-1)!.text.length
  const byId = new Map(units.map(unit => [unit.id, unit]))
  const positions = result.sections.map(section => byId.get(section.start_unit)!.offset)
  return positions.map((offset, index) => ({ offset, length: (positions[index + 1] ?? end) - offset, depth: 0 }))
}

export function resolveSourceSections(result: SourceMapResult, passages: SourcePassage[], allPassages = passages) {
  result = canonicalizeSourceMapEvidence(result)
  const ranges = sourceSectionRanges(result, passages), units = new Map(allPassages.flatMap(passage => passage.units).map(unit => [unit.id, unit]))
  const problems: EvidenceProblem[] = []
  const sections: ScriptSourceSection[] = result.sections.map((section, sectionIndex) => {
    const range = ranges[sectionIndex]!
    function locate(reference: z.infer<typeof characterEvidenceSchema> | z.infer<typeof eventEvidenceSchema>, kind: EvidenceProblem['kind'], index: number) {
      const problem = (message: string, trace?: { unit_id: number; should_be_in?: number }) => {
        if (problems.some(problem => problem.section === sectionIndex && problem.kind === kind && problem.index === index)) return
        problems.push({ section: sectionIndex, kind, index, message: `sections.${sectionIndex}.${kind}.${index}.evidence: ${message}`, ...(trace ? { boundary_trace: trace } : {}) })
      }
      const unit = units.get(reference.unit_id)
      const inside = (value: SourceUnit | undefined) => !!value?.text.trim() && value.offset >= range.offset && value.offset + value.text.length <= range.offset + range.length

      // Semantic check: summary/overview sections can reference adjacent section content
      // Industry best practice: "semantic checks that catch errors a schema alone can never see"
      const isSummarySection = /梗概|概述|简介|总览|导读|篇章|章节/.test(section.title)
      const isAdjacentUnit = (value: SourceUnit | undefined) => {
        if (!value) return false
        // Allow referencing content from the next section for summary sections
        const nextRange = ranges[sectionIndex + 1]
        if (!nextRange) return false
        return value.offset >= nextRange.offset && value.offset + value.text.length <= nextRange.offset + nextRange.length
      }
      const insideOrAdjacent = (value: SourceUnit | undefined) => inside(value) || (isSummarySection && isAdjacentUnit(value))

      const charRef = reference as z.infer<typeof characterEvidenceSchema>
      const present = charRef.occurrence_unit_id === undefined ? unit : units.get(charRef.occurrence_unit_id)
      if (!unit?.text.trim()) problem(`unit_id=${reference.unit_id} 必须引用真实非空原文`)
      if (kind === 'events' && !insideOrAdjacent(unit)) {
        // Detect boundary mismatch: find which section this unit actually belongs to
        const actualSectionIndex = result.sections.findIndex((s, idx) => {
          const r = ranges[idx]!
          const nextR = ranges[idx + 1]
          const end = nextR ? nextR.offset : range.offset + range.length + 10000
          return unit && unit.offset >= r.offset && unit.offset < end
        })
        problem(
          `unit_id=${reference.unit_id} 不属于「${section.title}」正文范围；事件发生依据不能由跨章背景替代` +
          (actualSectionIndex >= 0 && actualSectionIndex !== sectionIndex
            ? `。该unit实际属于章节${actualSectionIndex}「${result.sections[actualSectionIndex]?.title}」，可能是目录边界切分错误`
            : ''),
          actualSectionIndex >= 0 && actualSectionIndex !== sectionIndex
            ? { unit_id: reference.unit_id, should_be_in: actualSectionIndex }
            : undefined
        )
      }
      if (kind === 'characters' && !insideOrAdjacent(present)) problem(`人物须有本章出场依据；unit_id=${reference.unit_id}，occurrence_unit_id=${charRef.occurrence_unit_id ?? '未给出'}`)
      const supportIds = reference.supporting_unit_ids || []
      if (new Set(supportIds).size !== supportIds.length || supportIds.includes(reference.unit_id)) problem('辅助证据不能重复或重复主证据')
      const supports = supportIds.flatMap(id => {
        const cited = units.get(id)
        if (!cited?.text.trim()) { problem(`辅助unit_id=${id}必须引用真实非空原文`); return [] }
        return [{ offset: cited.offset, quote: cited.text }]
      })
      const quote = unit ? { offset: unit.offset, quote: unit.text } : { offset: -1, quote: '' }
      return { ...quote,
        ...(kind === 'characters' && charRef.occurrence_unit_id !== undefined && present ? { occurrence: { offset: present.offset, quote: present.text } } : {}),
        ...(supportIds.length ? { supporting: supports } : {}),
      }
    }
    const knowledge = assessSourceKnowledge(section.knowledge, allPassages.flatMap(passage => passage.units), range)
    return { offset: range.offset, length: range.length, title: section.title, episode_number: section.episode_number, summary: section.summary,
      continues_previous: section.continues_previous, open_threads: section.open_threads,
      ...(section.knowledge === undefined ? {} : { knowledge: knowledge.accepted, ...(knowledge.pending.length ? { knowledge_pending: knowledge.pending } : {}) }),
      characters: section.characters.map((character, index) => ({ ...character, evidence: locate(character.evidence, 'characters', index) })),
      events: section.events.map((event, index) => ({ ...event, evidence: locate(event.evidence, 'events', index) })) }
  })
  return { sections, problems, ranges }
}

export function validateSourceCoverage(content: string, sections: ScriptSourceSection[], completeSource = content) {
  let offset = 0
  for (const section of sections) {
    // Auxiliary annotation issues are retained separately and never veto the map.
    // Readers reassess legacy annotations before exposing accepted claims.
    if (section.offset !== offset || section.length <= 0) throw new Error('剧本地图未完整连续覆盖当前有效稿，不能发布')
    offset += section.length
    const exact = (evidence: { offset: number; quote: string }) => Number.isSafeInteger(evidence.offset) && evidence.offset >= 0 &&
      !!evidence.quote.trim() && completeSource.slice(evidence.offset, evidence.offset + evidence.quote.length) === evidence.quote
    const inside = (evidence: { offset: number; quote: string }) => evidence.offset >= section.offset && evidence.offset + evidence.quote.length <= offset
    for (const kind of ['characters', 'events'] as const) for (const item of section[kind]) {
      const evidence = item.evidence
      if (!exact(evidence) || !(kind === 'characters' ? inside(evidence.occurrence || evidence) : inside(evidence)) ||
        evidence.occurrence && (kind !== 'characters' || !exact(evidence.occurrence)) ||
        evidence.supporting?.some(support => !exact(support) || support.offset === evidence.offset && support.quote === evidence.quote) ||
        evidence.supporting && new Set(evidence.supporting.map(support => `${support.offset}:${support.quote}`)).size !== evidence.supporting.length) {
        throw new Error(`「${section.title}」原文证据校验失败，不能发布`)
      }
    }
  }
  if (offset !== content.length) throw new Error('剧本地图存在未分析的原文，不能发布')
}
