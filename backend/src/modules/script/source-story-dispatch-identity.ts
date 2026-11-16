import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import type { OutputContract } from '../generation/model-output.js'

export type InitialSourceStoryRequest = { task_key: string; candidate_hash: string; request_key: string }
const initialStory = new AsyncLocalStorage<InitialSourceStoryRequest>()

/** Code-owned proof for one logical task's initial format round. Neither
 * prompt text, a correction response nor a sibling's permit can create it. */
export function withInitialSourceStoryRequest<T>(binding: Pick<InitialSourceStoryRequest, 'task_key' | 'candidate_hash'>,
  modelId: string, prompt: string, contract: OutputContract, work: () => T): T {
  const request = Object.freeze({ ...binding,
    request_key: createHash('sha256').update(canonicalAiValue([modelId, prompt, contract])).digest('hex') })
  return initialStory.run(request, work)
}

export const currentInitialSourceStoryRequest = () => initialStory.getStore()

export type InitialSourceQualityRequest = Omit<InitialSourceStoryRequest, 'task_key'> & {
  task_key: 'quality:initial' | 'quality:page'
}
const initialQuality = new AsyncLocalStorage<InitialSourceQualityRequest>()

/** Each first review/page request has its own exact identity. Corrections and
 * quality repairs never acquire this independent ordinary-request proof. */
export function withInitialSourceQualityRequest<T>(binding: Pick<InitialSourceQualityRequest, 'task_key' | 'candidate_hash'>,
  modelId: string, prompt: string, contract: OutputContract, work: () => T): T {
  const request = Object.freeze({ ...binding,
    request_key: createHash('sha256').update(canonicalAiValue([modelId, prompt, contract])).digest('hex') })
  return initialQuality.run(request, work)
}

export const currentInitialSourceQualityRequest = () => initialQuality.getStore()

export type DerivedSourceCorrectionRequest = InitialSourceStoryRequest & {
  base_input_hash: string
  initial_request_key: string
  initial_response_hash: string
  correction_input_hash: string
}
const derivedCorrection = new AsyncLocalStorage<DerivedSourceCorrectionRequest>()

export function sourceDispatchRequestKey(modelId: string, prompt: string, contract: OutputContract): string {
  return createHash('sha256').update(canonicalAiValue([modelId, prompt, contract])).digest('hex')
}

/** The live ordinary grant and exact completed initial ledger still decide
 * authority. This proof identifies one frozen correction, never a fresh quota. */
export function withDerivedSourceCorrectionRequest<T>(binding: Omit<DerivedSourceCorrectionRequest, 'request_key'>,
  modelId: string, prompt: string, contract: OutputContract, work: () => T): T {
  return derivedCorrection.run(Object.freeze({ ...binding, request_key: sourceDispatchRequestKey(modelId, prompt, contract) }), work)
}

export const currentDerivedSourceCorrectionRequest = () => derivedCorrection.getStore()
