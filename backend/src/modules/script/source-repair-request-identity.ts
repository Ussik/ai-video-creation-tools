import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { OutputContract, StructuredOutputCheckpoint } from '../generation/model-output.js'

// The producer owns this policy. Prompt text and model output cannot grant it.
export const sourceRepairReferencePolicy = 'source-quality-repair-ref-v1'
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
export type SourceRepairUpgradeBinding = { policy: typeof sourceRepairReferencePolicy; checkpoint_hash: string;
  finding_index: number; finding_hash: string; review_hash: string; findings_hash: string; current_hash: string }
export type SourceRepairContractUpgrade = { analysisBinding: string; binding: SourceRepairUpgradeBinding }
export function sourceRepairRequestCheckpoint(document: { filename: string; content: string }, state: ScriptSourceAnalysis,
  findingIndex: number): SourceRepairUpgradeBinding {
  return { policy: sourceRepairReferencePolicy,
    checkpoint_hash: digest({ source_version: state.source_version, model_id: state.model_id, configuration_hash: state.configuration_hash,
      document: { filename: document.filename, content: document.content }, sections: state.sections, story: state.story,
      review_feedback: state.review_feedback ?? null, quality: state.quality, quality_repair: state.quality_repair }),
    finding_index: findingIndex, finding_hash: digest(state.quality!.findings[findingIndex]),
    review_hash: state.quality!.input_hash, findings_hash: state.quality_repair!.findings_hash, current_hash: state.quality_repair!.current_hash }
}
export type SourceRepairBatchBinding = {
  policy: 'source-quality-repair-batch-v1'; batch_hash: string; review_hash: string; findings_hash: string; before_hash: string
  anchor: SourceRepairUpgradeBinding
  members: Array<{ finding_index: number; finding_hash: string; analysis_paths: string[] }>
}
export function sourceRepairBatchBinding(document: { filename: string; content: string }, state: ScriptSourceAnalysis,
  members: Array<{ finding_index: number; analysis_paths: string[] }>): SourceRepairBatchBinding {
  const first = members[0]
  if (!first || members.length < 2 || members.length > 3) throw new Error('质量处理小批次必须含二至三项明确问题')
  const anchor = sourceRepairRequestCheckpoint(document, state, first.finding_index)
  const value = { policy: 'source-quality-repair-batch-v1' as const, review_hash: anchor.review_hash,
    findings_hash: anchor.findings_hash, before_hash: anchor.current_hash, anchor,
    members: members.map(member => ({ ...member, analysis_paths: [...member.analysis_paths],
      finding_hash: digest(state.quality!.findings[member.finding_index]) })) }
  return { ...value, batch_hash: digest(value) }
}
export type InitialSourceRepairRequest = { binding: SourceRepairUpgradeBinding; requestKey: string; ordinary?: true; batch?: SourceRepairBatchBinding }
const initialRepair = new AsyncLocalStorage<InitialSourceRepairRequest>()
/** Called only around the producer's first format attempt, after its complete
 * prompt and contract exist. The recovery barrier checks the very same bytes. */
export function withInitialSourceRepairRequest<T>(binding: SourceRepairUpgradeBinding, modelId: string, prompt: string,
  contract: OutputContract, work: () => T, ordinary = false): T {
  return initialRepair.run(Object.freeze({ binding: Object.freeze(structuredClone(binding)), requestKey: digest([modelId, prompt, contract]),
    ...(ordinary ? { ordinary: true as const } : {}) }), work)
}
export const currentInitialSourceRepairRequest = () => initialRepair.getStore()

/** A batch is its own explicit request and journal. The anchor alone cannot
 * authorize it: dispatch also validates every frozen member and target. */
export function withInitialSourceRepairBatchRequest<T>(batch: SourceRepairBatchBinding, modelId: string, prompt: string,
  contract: OutputContract, work: () => T): T {
  if (contract.name !== 'script_source_quality_repair_batch') throw new Error('质量小批次请求契约不匹配')
  return initialRepair.run(Object.freeze({ binding: Object.freeze(structuredClone(batch.anchor)),
    batch: Object.freeze(structuredClone(batch)), requestKey: digest([modelId, prompt, contract]), ordinary: true }), work)
}

export type DerivedSourceRepairCorrectionRequest = {
  binding: SourceRepairUpgradeBinding
  base_input_hash: string
  initial_request_key: string
  initial_response_hash: string
  correction_input_hash: string
  request_key: string
}
const derivedRepairCorrection = new AsyncLocalStorage<DerivedSourceRepairCorrectionRequest>()
/** Identifies the one frozen format correction owned by this exact finding.
 * It cannot grant a repair, another finding or a second correction by itself. */
export function withDerivedSourceRepairCorrectionRequest<T>(binding: Omit<DerivedSourceRepairCorrectionRequest, 'request_key'>,
  modelId: string, prompt: string, contract: OutputContract, work: () => T): T {
  return derivedRepairCorrection.run(Object.freeze({ ...binding, binding: Object.freeze(structuredClone(binding.binding)),
    request_key: digest([modelId, prompt, contract]) }), work)
}
export const currentDerivedSourceRepairCorrectionRequest = () => derivedRepairCorrection.getStore()

type FrozenSourceCorrectionReadIdentity = {
  base_input_hash: string
  initial_request_key: string
  initial_response_hash: string
  correction_input_hash: string
  initial_run_id: string
  request_key: string
}
export type FrozenSourceCorrectionRead = FrozenSourceCorrectionReadIdentity &
  ({ kind: 'repair'; binding: SourceRepairUpgradeBinding } | { kind: 'quality'; candidate_hash: string })
const frozenCorrectionRead = new AsyncLocalStorage<FrozenSourceCorrectionRead>()
/** A local read of a spent-but-complete correction is bound to the producer's
 * actual frozen journal. It never clears a marker or grants a new dispatch. */
export function withFrozenSourceCorrectionRead<T>(binding: Omit<FrozenSourceCorrectionReadIdentity, 'request_key'> &
  ({ kind: 'repair'; binding: SourceRepairUpgradeBinding } | { kind: 'quality'; candidate_hash: string }),
  modelId: string, prompt: string, contract: OutputContract, work: () => T, checkpoint: StructuredOutputCheckpoint): T {
  const frozen = checkpoint.correction_request
  if (!frozen || checkpoint.input_hash !== binding.base_input_hash || checkpoint.raw === undefined ||
    checkpoint.raw !== checkpoint.original_raw || createHash('sha256').update(checkpoint.raw).digest('hex') !== binding.initial_response_hash ||
    checkpoint.initial_started || checkpoint.correction || frozen.base_input_hash !== binding.base_input_hash ||
    frozen.input_hash !== binding.correction_input_hash || frozen.input_hash !== createHash('sha256').update(JSON.stringify([prompt, contract])).digest('hex') ||
    frozen.prompt !== prompt || canonicalAiValue(frozen.contract) !== canonicalAiValue(contract) ||
    checkpoint.correction_started && checkpoint.correction_started.input_hash !== frozen.input_hash) {
    throw Object.assign(new Error('冻结纠正与当前检查点不匹配，已保留回答和请求保护，不能读取其他纠正结果'), {
      statusCode: 409, code: 'structured_checkpoint_identity_mismatch', failure_stage: 'recovery', delivery: 'not_sent', retryable: false,
    })
  }
  const request = { ...structuredClone(binding), request_key: digest([modelId, prompt, contract]) }
  if (request.kind === 'repair') Object.freeze(request.binding)
  return frozenCorrectionRead.run(Object.freeze(request), work)
}
export const currentFrozenSourceCorrectionRead = () => frozenCorrectionRead.getStore()
