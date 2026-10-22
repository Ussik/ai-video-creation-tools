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
export function sourceWorkPlan(passages: SourcePassage[]): SourceWork[] {
  const length = passages.at(-1) ? passages.at(-1)!.offset + passages.at(-1)!.content.length : 0
  if (!length) return []
  if (length <= sourceSinglePageLimit) return [{ offset: 0, length, depth: 0 }]
  const headings = passages.filter(passage => sourceHeadingStart.test(passage.content)).map(passage => passage.offset)
  const boundaries = passages.map(passage => passage.offset)
  const units = passages.flatMap(passage => passage.units.map(unit => unit.offset))
  const work: SourceWork[] = []
  let offset = 0
  while (offset < length) {
    if (length - offset <= sourceOutputPageMaximum) {
      work.push({ offset, length: length - offset, depth: 0 }); break
    }
    const nearest = (positions: number[]) => positions.filter(position =>
      position >= offset + sourceOutputPageTarget / 2 && position <= offset + sourceOutputPageMaximum)
      .sort((a, b) => Math.abs(a - offset - sourceOutputPageTarget) - Math.abs(b - offset - sourceOutputPageTarget) || b - a)[0]
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
export const sourceMapSectionSchema = z.object({
  start_unit: z.number().int().min(0), title: z.string().trim().min(1).max(120), episode_number: z.number().int().min(1).max(10000).nullable(),
  summary: z.string().trim().min(1).max(1200),
  characters: z.array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(160), evidence }).strict()).max(24),
  events: z.array(z.object({ summary: z.string().trim().min(1).max(160), evidence }).strict()).max(24),
  continues_previous: z.boolean().default(false), open_threads: z.array(z.string().trim().min(1).max(200)).max(24).default([]),
}).strict()
export const sourceMapSchema = z.object({ sections: z.array(sourceMapSectionSchema).min(1).max(1000) }).strict()
export type SourceMapResult = z.infer<typeof sourceMapSchema>
export type EvidenceProblem = { section: number; kind: 'characters' | 'events'; index: number; message: string }

export function sourceSectionRanges(result: SourceMapResult, passages: SourcePassage[]): SourceWork[] {
  const units = passages.flatMap(passage => passage.units), start = units[0]!.offset, end = units.at(-1)!.offset + units.at(-1)!.text.length
  const positions = result.sections.map((section, index) => {
    const unit = units.find(unit => unit.id === section.start_unit)
    if (!unit) throw new Error(`sections.${index}.start_unit=${section.start_unit} 不属于当前原文范围`)
    return unit.offset
  })
  if (positions[0] !== start || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) throw new Error('章节边界必须从所给原文第一个unit开始并递增，不能遗漏、重复或重叠')
  return positions.map((offset, index) => ({ offset, length: (positions[index + 1] ?? end) - offset, depth: 0 }))
}

export function resolveSourceSections(result: SourceMapResult, passages: SourcePassage[]) {
  const ranges = sourceSectionRanges(result, passages), units = new Map(passages.flatMap(passage => passage.units).map(unit => [unit.id, unit]))
  const problems: EvidenceProblem[] = []
  const sections: ScriptSourceSection[] = result.sections.map((section, sectionIndex) => {
    const range = ranges[sectionIndex]!
    function locate(reference: z.infer<typeof evidence>, kind: EvidenceProblem['kind'], index: number) {
      const unit = units.get(reference.unit_id)
      if (!unit || unit.offset < range.offset || unit.offset + unit.text.length > range.offset + range.length || !unit.text.trim()) {
        problems.push({ section: sectionIndex, kind, index, message: `sections.${sectionIndex}.${kind}.${index}.evidence.unit_id=${reference.unit_id} 不属于「${section.title}」正文范围` })
        return { offset: -1, quote: '' }
      }
      return { offset: unit.offset, quote: unit.text }
    }
    return { offset: range.offset, length: range.length, title: section.title, episode_number: section.episode_number, summary: section.summary,
      continues_previous: section.continues_previous, open_threads: section.open_threads,
      characters: section.characters.map((character, index) => ({ ...character, evidence: locate(character.evidence, 'characters', index) })),
      events: section.events.map((event, index) => ({ ...event, evidence: locate(event.evidence, 'events', index) })) }
  })
  return { sections, problems, ranges }
}

export function validateSourceCoverage(content: string, sections: ScriptSourceSection[]) {
  let offset = 0
  for (const section of sections) {
    if (section.offset !== offset || section.length <= 0) throw new Error('剧本地图未完整连续覆盖当前有效稿，不能发布')
    offset += section.length
    for (const item of [...section.characters, ...section.events]) {
      const evidence = item.evidence
      if (!evidence.quote.trim() || evidence.offset < section.offset || evidence.offset + evidence.quote.length > offset || content.slice(evidence.offset, evidence.offset + evidence.quote.length) !== evidence.quote) throw new Error(`「${section.title}」原文证据校验失败，不能发布`)
    }
  }
  if (offset !== content.length) throw new Error('剧本地图存在未分析的原文，不能发布')
}
