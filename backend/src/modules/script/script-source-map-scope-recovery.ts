import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { resolveSourceSections, sourceMapSchema, sourceSectionRanges, workPassages, type SourcePassage } from './script-source-map.js'

function unsupported(detail: string): never {
  throw Object.assign(new Error('目录输出范围恢复未完成：' + detail + '；完整原候选已保留，未改写、删除或强行移动事实坐标。'), {
    statusCode: 422, code: 'source_map_scope_recovery_unsupported',
  })
}

/** A model can return a valid prefix of the next output window while reading
 * the full source. Move only proven whole sections to that adjacent window's
 * private continuation seed. A seed is never a completed page or coverage. */
export function recoverAdjacentSourceMapScope(state: ScriptSourceAnalysis, passages: SourcePassage[],
  nextPrompt: (currentSections: ScriptSourceSection[]) => string, persist: () => void): boolean {
  const index = state.completed_chunks, work = state.work?.[index]
  if (!work?.result) return false
  const original = sourceMapSchema.parse(work.result)
  const currentPassages = workPassages(passages, work)
  const currentUnits = currentPassages.flatMap(passage => passage.units)
  const currentIds = new Set(currentUnits.map(unit => unit.id))
  const globalUnits = passages.flatMap(passage => passage.units), globalIds = new Set(globalUnits.map(unit => unit.id))
  // Unknown or prior-page IDs can be coordinate typos handled by the original
  // boundary repair. Only genuine future coordinates establish scope overflow.
  const firstFutureUnit = globalUnits.find(unit => unit.offset >= work.offset + work.length)?.id ?? Infinity
  if (!original.sections.some(section => section.start_unit >= firstFutureUnit && globalIds.has(section.start_unit))) return false
  const next = state.work?.[index + 1]
  if (!next || work.offset + work.length !== next.offset) unsupported('没有连续的紧邻下一输出页，不能自动归位')
  if (state.revision_reuse?.status === 'pending' && state.revision_reuse.planned_pages.includes(index + 1)) {
    unsupported('下一页已有修订沿用候选，不能覆盖其来源')
  }
  if (next.result !== undefined || next.scope_recovery || next.boundary_repair || next.output_checkpoint &&
    (next.output_checkpoint.raw !== undefined || next.output_checkpoint.correction || next.output_checkpoint.pages || next.output_checkpoint.seed)) {
    unsupported('下一页已有待处理候选或续传断点，不能覆盖')
  }
  if (original.sections.some((section, sectionIndex) => !globalIds.has(section.start_unit) ||
    sectionIndex > 0 && section.start_unit <= original.sections[sectionIndex - 1]!.start_unit)) {
    unsupported('原候选起点并非全文真实且严格递增的坐标')
  }
  const split = original.sections.findIndex(section => !currentIds.has(section.start_unit))
  if (split < 1 || original.sections.slice(split).some(section => currentIds.has(section.start_unit))) unsupported('候选不是当前页加下一页的连续前缀')
  const nextPassages = workPassages(passages, next), nextUnits = nextPassages.flatMap(passage => passage.units)
  const nextIds = new Set(nextUnits.map(unit => unit.id))
  const currentResult = sourceMapSchema.parse({ sections: original.sections.slice(0, split) })
  const nextResult = sourceMapSchema.parse({ sections: original.sections.slice(split) })
  if (nextResult.sections[0]!.start_unit !== nextUnits[0]!.id || nextResult.sections.some(section => !nextIds.has(section.start_unit))) {
    unsupported('越窗章节未从紧邻下一页首句段开始，或跨入更远页')
  }
  // Exact section evidence must remain inside its assigned semantic section,
  // not merely somewhere on the same output page. No text is synthesized here.
  let resolvedCurrent: ReturnType<typeof resolveSourceSections>, resolvedNext: ReturnType<typeof resolveSourceSections>
  try {
    resolvedCurrent = resolveSourceSections(currentResult, currentPassages, passages)
    sourceSectionRanges(nextResult, nextPassages)
    resolvedNext = resolveSourceSections(nextResult, nextPassages, passages)
  } catch { unsupported('归位后的章节起点未通过完整连续边界校验') }
  if (resolvedCurrent.problems.length || resolvedNext.problems.length) unsupported('候选含跨页或跨章节证据，不能按坐标安全归位')
  const inputHash = createHash('sha256').update(nextPrompt(structuredClone(resolvedCurrent.sections))).digest('hex')
  const beforeWork = structuredClone(work), beforeNext = structuredClone(next)
  work.scope_recovery = { candidate: structuredClone(original), next_page: index + 1, next_input_hash: inputHash }
  work.result = currentResult
  delete work.output_checkpoint
  delete work.boundary_repair
  next.output_checkpoint = { ...(next.output_checkpoint || {}), seed: { input_hash: inputHash, sections: structuredClone(nextResult.sections) } }
  // Both halves enter one synchronous durable snapshot. A persistence failure
  // cannot leave only one half adopted by the current in-memory execution.
  try { persist() }
  catch (issue) { state.work![index] = beforeWork; state.work![index + 1] = beforeNext; throw issue }
  return true
}
