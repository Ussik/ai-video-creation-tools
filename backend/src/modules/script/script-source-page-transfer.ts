import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { reportModelResult } from '../generation/model-result-observation.js'
import { sourceMapSchema, resolveSourceSections, workPassages, type SourcePassage } from './script-source-map.js'

/** Only explicit Markdown headings/blank units can travel backward across the
 * boundary. All facts, prose, knowledge, references and IDs stay unchanged.
 * An untouched next page is mandatory; never invalidate its paid request. */
export function recoverSourceHeadingTail(state: ScriptSourceAnalysis, passages: SourcePassage[],
  nextPrompt: (sections: ScriptSourceSection[]) => string, persist: () => void): boolean {
  const page = state.completed_chunks, work = state.work?.[page], next = state.work?.[page + 1]
  if (!work?.result || !next || next.offset !== work.offset + work.length || next.result || next.boundary_repair || next.scope_recovery ||
    next.output_checkpoint && Object.keys(next.output_checkpoint).length || state.revision_reuse?.status === 'pending') return false
  const original = sourceMapSchema.parse(work.result)
  if (original.sections.length < 2) return false
  const tail = original.sections.at(-1)!, units = passages.flatMap(p => p.units)
  const start = units.find(u => u.id === tail.start_unit), boundary = next.offset, end = next.offset + next.length
  if (!start || start.offset <= work.offset || start.offset >= boundary) return false
  const headings = units.filter(u => u.offset >= start.offset && u.offset < boundary)
  if (!headings.length || headings.some(u => u.text.trim() && !/^#{1,6}\s+[^\n]{1,180}\s*$/.test(u.text.trim()))) return false
  const evidence = [...tail.events.map(e => e.evidence.unit_id), ...tail.characters.map(c => c.evidence.occurrence_unit_id ?? c.evidence.unit_id)]
  const nextIds = new Set(units.filter(u => u.offset >= boundary && u.offset + u.text.length <= end).map(u => u.id))
  if (!evidence.length || evidence.some(id => !nextIds.has(id))) return false
  const currentResult = sourceMapSchema.parse({ sections: original.sections.slice(0, -1) })
  const nextResult = sourceMapSchema.parse({ sections: [tail] })
  const currentWindow = { ...work, length: start.offset - work.offset }
  const nextWindow = { ...next, offset: start.offset, length: end - start.offset }
  const left = resolveSourceSections(currentResult, workPassages(passages, currentWindow), passages)
  const right = resolveSourceSections(nextResult, workPassages(passages, nextWindow), passages)
  if (left.problems.length || right.problems.length) return false
  const beforeWork = structuredClone(work), beforeNext = structuredClone(next), beforeJournal = structuredClone(state.map_page_transfers)
  work.length = currentWindow.length; work.result = currentResult
  // Keep the original paid answer even after completed work is pruned.
  state.map_page_transfers ??= []
  state.map_page_transfers.push({ page, from_offset: work.offset, original_boundary: boundary, boundary: start.offset, next_end: end,
    candidate: structuredClone(original) })
  next.offset = nextWindow.offset; next.length = nextWindow.length
  const inputHash = createHash('sha256').update(nextPrompt(left.sections)).digest('hex')
  next.output_checkpoint = { seed: { input_hash: inputHash, sections: structuredClone(nextResult.sections) } }
  try { persist() }
  catch (error) { state.work![page] = beforeWork; state.work![page + 1] = beforeNext; state.map_page_transfers = beforeJournal; throw error }
  reportModelResult({ phase: 'structure', status: 'valid', repaired: true, repair_type: 'local_reuse', reused_items: 1,
    request_category: 'local_reuse', recovery_action: 'boundary_transfer', recovery_attempts: state.map_page_transfers.length })
  return true
}

/** Replay the journal onto the original deterministic plan. A random custom
 * range is never enough to legitimize a checkpoint or reset an output task. */
export function sourceTransferredPlan(plan: Array<{ offset: number; length: number; depth: number }>,
  state: ScriptSourceAnalysis, passages: SourcePassage[]) {
  const result = structuredClone(plan), starts = new Set(passages.flatMap(p => p.units.map(u => u.offset)))
  for (const transfer of state.map_page_transfers || []) {
    const left = result[transfer.page], right = result[transfer.page + 1]
    if (!left || !right || left.offset !== transfer.from_offset || left.offset + left.length !== transfer.original_boundary ||
      right.offset !== transfer.original_boundary || right.offset + right.length !== transfer.next_end ||
      !starts.has(transfer.boundary) || transfer.boundary <= left.offset || transfer.boundary >= right.offset) {
      throw Object.assign(new Error('跨页承接记录与原分页身份不一致；已有结果保留，不能自动重建请求。'), {
        statusCode: 409, code: 'source_page_transfer_conflict', delivery: 'not_sent', retryable: false,
      })
    }
    left.length = transfer.boundary - left.offset
    right.offset = transfer.boundary; right.length = transfer.next_end - right.offset
  }
  return result
}
