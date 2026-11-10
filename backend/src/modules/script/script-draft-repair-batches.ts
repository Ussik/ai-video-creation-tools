import { z } from 'zod'
import { createHash } from 'node:crypto'
import { draftRepairOutput } from './script-draft-resolution.js'
import type { DraftRepairOutput } from './script-draft-repair-generation.js'
import type { GenerationSteps } from './script-generation-steps.js'

/** The ledger contains operations against one immutable snapshot, never applied
 * intermediate text. Acceptance is private; the caller commits only the final
 * aggregate after its ordinary exact-edit and business validation. */
export function createRepairBatchLedger(issueIds: readonly string[], identity: unknown, steps?: GenerationSteps) {
  const decision = z.object({ issue_id: z.enum(issueIds as [string, ...string[]]), decision: draftRepairOutput.shape.decisions.element }).strict()
  const shape = { decisions: z.array(decision).max(issueIds.length), summary: draftRepairOutput.shape.summary,
    edits: draftRepairOutput.shape.edits, source_edits: draftRepairOutput.shape.source_edits }
  const batchSchema = z.object({ ...shape, complete: z.boolean() }).strict()
  const stateSchema = z.object(shape).strict()
  const input = { version: 1, identity, issue_ids: issueIds }
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const id = 'repair:tools:batches'
  let state = stateSchema.parse({ decisions: [], summary: '候选稿补丁尚未全部提交', edits: [], source_edits: [] })
  const previous = steps?.checkpoint.steps[id]
  if (previous?.input_hash === inputHash) state = stateSchema.parse(previous.value)
  const assertDecisions = (value: z.infer<typeof stateSchema>) => {
    if (new Set(value.decisions.map(item => item.issue_id)).size !== value.decisions.length) throw new Error('修订批次重复提交了同一问题决定')
  }
  assertDecisions(state)
  const mergeUnique = <T>(current: T[], incoming: T[]): T[] => [...new Map([...current, ...incoming].map(item => [JSON.stringify(item), item])).values()]
  const aggregate = (value = state): DraftRepairOutput => ({ summary: value.summary,
    decisions: issueIds.map(id => value.decisions.find(item => item.issue_id === id)?.decision || ''), edits: value.edits, source_edits: value.source_edits })
  return {
    batchSchema,
    snapshot: () => structuredClone(state),
    aggregate,
    accept(value: unknown, validatePatch: (patch: DraftRepairOutput) => void, validateFinal: (patch: DraftRepairOutput) => DraftRepairOutput) {
      const batch = batchSchema.parse(value)
      assertDecisions(batch)
      for (const decision of batch.decisions) {
        const retained = state.decisions.find(item => item.issue_id === decision.issue_id)
        if (retained && retained.decision !== decision.decision) throw new Error('已验证的问题决定不可在后续批次重新选择或改写')
      }
      const next = stateSchema.parse({ summary: batch.summary, decisions: mergeUnique(state.decisions, batch.decisions),
        edits: mergeUnique(state.edits, batch.edits), source_edits: mergeUnique(state.source_edits, batch.source_edits) })
      assertDecisions(next)
      const patch = aggregate(next)
      // Even an incomplete aggregate must satisfy read, unique match and
      // non-overlap checks. Decision-only batches have no textual side effect.
      if (patch.edits.length || patch.source_edits.length) validatePatch(patch)
      let final: DraftRepairOutput | undefined
      if (batch.complete) {
        if (next.decisions.length !== issueIds.length) throw new Error('修订批次仍有问题没有具体决定，不能声明全部完成')
        final = validateFinal(patch)
      }
      const added = next.decisions.length + next.edits.length + next.source_edits.length - state.decisions.length - state.edits.length - state.source_edits.length
      if (!added && !final) throw new Error('修订批次没有增加完整决定或有效操作')
      state = next
      steps?.retain(id, '保留已验证的完整修订批次', input, state, value => { const checked = stateSchema.parse(value); assertDecisions(checked); return checked })
      return { final, accepted_decisions: state.decisions.length, accepted_edits: state.edits.length + state.source_edits.length,
        remaining_issue_ids: issueIds.filter(id => !state.decisions.some(item => item.issue_id === id)) }
    },
  }
}
