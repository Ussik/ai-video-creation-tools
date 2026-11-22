import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceStoryTask } from './script-source-story-plan.js'
type Result = Record<string, unknown>
type Item = { section_ids: number[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Referenced sections determine ownership and transfer.
 * - If ANY cited section belongs to this batch, keep it (supports cross-batch threads from expanded reads)
 * - Otherwise, if EVERY cited section belongs to exactly one sibling, transfer to that sibling
 * - Otherwise, it's ambiguous and requires local repair */
export function splitSourceStoryScope(task: SourceStoryTask, input: unknown, tasks: SourceStoryTask[], sectionCount: number) {
  if (task.kind === 'timeline' && task.scope_version !== 2 || !['timeline', 'threads', 'uncertainties'].includes(task.kind)) return { owned: input, transfers: [] }
  const field = task.kind, root = input as Result, items = root[field] as Item[]
  const own = new Set(task.section_ids), kept: Item[] = [], transfers: Array<{ id: string; from: string; to: string; field: string; item: unknown }> = []
  const invalid: number[] = []
  items.forEach((item, index) => {
    if (!Array.isArray(item.section_ids) || !item.section_ids.length || new Set(item.section_ids).size !== item.section_ids.length ||
      item.section_ids.some(id => !Number.isSafeInteger(id) || id < 0 || id >= sectionCount)) { invalid.push(index); return }
    const primary = (item as Item & { primary_section_id?: number }).primary_section_id
    if (field === 'timeline' && (primary === undefined || !item.section_ids.includes(primary))) { invalid.push(index); return }

    // NEW: Keep item if ANY section belongs to this batch (supports cross-batch threads)
    if (field === 'timeline' ? own.has(primary!) : item.section_ids.some(id => own.has(id))) {
      kept.push(structuredClone(item))
      return
    }

    // Try to transfer to a sibling that owns ALL sections
    const owners = tasks.filter(sibling => sibling.kind === task.kind && sibling.key !== task.key && item.section_ids.every(id => sibling.section_ids?.includes(id)))
    if (owners.length !== 1) { invalid.push(index); return }
    transfers.push({ id: hash([task.key, owners[0]!.key, field, item]), from: task.key, to: owners[0]!.key, field, item: structuredClone(item) })
  })
  if (invalid.length) throw Object.assign(new Error(`${field}有 ${invalid.length} 条引用尚不能归入本批或唯一兄弟批次，需局部核对`), {
    code: 'source_story_scope_ambiguous', sourceScopeIssue: { field, indices: invalid, allowed_section_ids: task.section_ids, items: invalid.map(idx => items[idx]) },
  })
  const owned = { ...structuredClone(root), [field]: kept }
  return { owned, transfers }
}

/** All changes enter the caller's next single analysis snapshot. Paid original
 * responses and successful sibling text remain untouched; append exact items
 * and retain provenance, including when the destination is already complete. */
export function retainSourceScopeTransfers(state: ScriptSourceAnalysis, task: SourceStoryTask, input: unknown, tasks: SourceStoryTask[]) {
  const plan = splitSourceStoryScope(task, input, tasks, state.sections.length), journal = state.story_scope_transfers ??= []
  const pending = plan.transfers.filter(transfer => !journal.some(saved => saved.id === transfer.id))
  const result = structuredClone(plan.owned) as Result
  if (task.kind === 'timeline' && task.scope_version === 2) result.covered_section_ids = [...task.section_ids!]
  const append = (value: Result, field: string, item: unknown) => {
    const items = value[field] as unknown[]
    if (!items.some(existing => hash(existing) === hash(item))) items.push(structuredClone(item))
  }
  for (const transfer of journal) if (transfer.to === task.key) append(result, transfer.field, transfer.item)
  for (const transfer of pending) {
    const target = state.story_work?.tasks.find(saved => saved.key === transfer.to)
    if (target?.result) append(target.result as Result, transfer.field, transfer.item)
    journal.push(transfer)
  }
  return result
}
