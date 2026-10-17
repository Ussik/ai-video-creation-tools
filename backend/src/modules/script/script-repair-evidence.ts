import { z } from 'zod'
import { revisionHash, type resolvePassageEdits } from './script-revision.js'
import { scriptSourcePassages } from './script-source-map.js'
import type { DraftPassageChanges } from './script-draft-resolution.js'

type Changes = ReturnType<typeof resolvePassageEdits>
export type RepairRange = { start: number; end: number }
type Material = RepairRange & { kind: 'candidate' | 'source'; key: string; content: string }

/** Carry old evidence positions through accepted edits, including a finding
 * inside an already rewritten paragraph. Never search for a paraphrased quote. */
export function remapRepairRange(range: RepairRange, changes: Changes): RepairRange {
  const sorted = [...changes].sort((a, b) => a.start - b.start)
  const locate = (position: number, end: boolean) => {
    let delta = 0
    for (const edit of sorted) {
      if (position <= edit.start) break
      if (position < edit.end) return edit.start + delta + (end ? edit.replace.length : 0)
      delta += edit.replace.length - (edit.end - edit.start)
    }
    return position + delta
  }
  return { start: locate(range.start, false), end: locate(range.end, true) }
}

/** IDs bind model choices to exact, currently supplied text. Overlapping read
 * windows are merged before numbering; a range cannot cross an unread gap. */
export function scriptRepairEvidence(material: Material[], version: string) {
  const scopes: Material[] = []
  for (const item of [...material].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key) || a.start - b.start)) {
    let start = Math.max(0, item.start), end = Math.min(item.content.length, item.end)
    if (item.content.charCodeAt(start) >= 0xdc00 && item.content.charCodeAt(start) <= 0xdfff) start--
    if (item.content.charCodeAt(end) >= 0xdc00 && item.content.charCodeAt(end) <= 0xdfff) end++
    if (start >= end) continue
    const previous = scopes.at(-1)
    if (previous && previous.kind === item.kind && previous.key === item.key && start <= previous.end) previous.end = Math.max(previous.end, end)
    else scopes.push({ ...item, start, end })
  }
  const passages = scopes.map((scope, scopeId) => ({
    kind: scope.kind, source_key: scope.key,
    units: scriptSourcePassages(scope.content.slice(scope.start, scope.end)).flatMap(passage => passage.units).map(unit => {
      const start = scope.start + unit.offset, end = start + unit.text.length
      return { id: `E${revisionHash([version, scope.kind, scope.key, start, end, unit.text]).slice(0, 12)}`, text: unit.text, start, end, scope: scopeId }
    }),
  }))
  const entries = passages.flatMap(passage => passage.units.map(unit => ({ ...unit, kind: passage.kind, key: passage.source_key })))
  if (!entries.length) throw new Error('没有可用于补齐的候选稿或文稿原文')
  const id = z.enum(entries.map(entry => entry.id) as [string, ...string[]])
  const schema = z.object({ summary: z.string().trim().min(1).max(3000), decision: z.string().trim().min(1).max(2000).optional(), status: z.enum(['repaired', 'already_resolved']),
    edits: z.array(z.object({ start_id: id, end_id: id, replace: z.string().max(100000), reason: z.string().trim().min(1).max(2000) }).strict()).max(200),
  }).strict().refine(value => value.status === 'repaired' ? value.edits.length > 0 : value.edits.length === 0,
    '修订须提交修改；已由前项解决时只能返回空 edits 并说明依据')
  const resolve = (value: z.infer<typeof schema>) => {
    const candidates: DraftPassageChanges = [], source: Changes = []
    for (const [index, edit] of value.edits.entries()) {
      const first = entries.find(entry => entry.id === edit.start_id), last = entries.find(entry => entry.id === edit.end_id)
      if (!first || !last || first.scope !== last.scope || first.start > last.start) throw new Error(`edits.${index}：起止编号必须属于同一份已提供的连续原文，且顺序正确`)
      const scope = scopes[first.scope]!
      const find = scope.content.slice(first.start, last.end)
      if (find === edit.replace) throw new Error(`edits.${index}：修改前后完全相同，未补齐问题`)
      const change = { find, replace: edit.replace, reason: edit.reason, start: first.start, end: last.end }
      if (first.kind === 'source') source.push(change)
      else {
        let target = candidates.find(item => item.source_key === first.key)
        if (!target) { target = { source_key: first.key, changes: [] }; candidates.push(target) }
        target.changes.push(change)
      }
    }
    return { candidates, source }
  }
  return { schema, resolve, passages: passages.map(({ kind, source_key, units }) => ({ kind, source_key, units: units.map(({ id, text }) => ({ id, text })) })) }
}
