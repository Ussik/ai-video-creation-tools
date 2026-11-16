import { reportModelResult } from '../generation/model-result-observation.js'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { StructuredOutputCheckpoint } from '../generation/model-output.js'

/** Technical audit only; the original responses remain in their request ledger. */
export function archiveStorySyntax(state: ScriptSourceAnalysis, key: string, checkpoint: StructuredOutputCheckpoint | undefined) {
  if (checkpoint?.automatic_next) archiveStorySyntax(state, key, checkpoint.automatic_next)
  if (!checkpoint?.syntax_repair || !checkpoint.input_hash) return
  state.story_syntax_repairs ??= []
  if (!state.story_syntax_repairs.some(item => item.task_key === key && item.input_hash === checkpoint.input_hash &&
    item.syntax.original_hash === checkpoint.syntax_repair!.original_hash)) {
    reportModelResult({ phase: 'structure', status: 'valid', task_key: key, request_category: 'local_reuse', repair_type: 'syntax_insertions', reused_items: 1, correction_items: checkpoint.syntax_repair.escape_offsets.length })
    state.story_syntax_repairs.push({ task_key: key, input_hash: checkpoint.input_hash, syntax: structuredClone(checkpoint.syntax_repair) })
  }
}
