import assert from 'node:assert/strict'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceQualityProposalState } from '../src/modules/script/script-source-quality-repair.js'

/** Compare analysis, review, audit decisions and progress independently of raw
 * journals and terminal diagnostics. Stop behavior has its own assertions. */
export function repairBusinessSnapshot(state: ScriptSourceAnalysis) {
  const { quality_repair_output: _private, quality_repair_outputs: _archive,
    quality_repair_batch: _batch, quality_repair_batches: _batches, ...business } = structuredClone(state) as SourceQualityProposalState
  if (business.quality_repair) {
    delete business.quality_repair.stop_reason
    delete business.quality_repair.stop_message
  }
  return business
}

/** A private raw/intent save does not complete a finding. External state drift
 * is asserted separately by each fixture and cannot masquerade as progress. */
export function repairSaveRecorder(state: ScriptSourceAnalysis) {
  const snapshots: SourceQualityProposalState[] = []
  let completed = state.quality_repair?.completed_findings || 0, commits = 0
  return {
    record() {
      snapshots.push(structuredClone(state) as SourceQualityProposalState)
      const next = state.quality_repair?.completed_findings || 0
      if (next > completed) commits++
      completed = next
    },
    get commits() { return commits },
    get snapshots() { return snapshots },
    assertPrivateResponse() {
      assert.ok(snapshots.length > commits, 'private response checkpoints are persisted independently of completed findings')
      const last = snapshots.at(-1)
      const output = last?.quality_repair_output || last?.quality_repair_outputs?.at(-1)
      assert.ok(output, 'complete rejected or accepted proposal remains private and durable')
      assert.match(output.binding, /^[a-f0-9]{64}$/)
      assert.match(output.checkpoint.input_hash!, /^[a-f0-9]{64}$/)
      assert.equal(typeof output.checkpoint.raw, 'string')
    },
  }
}
