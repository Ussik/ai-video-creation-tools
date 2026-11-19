import { createHash } from 'node:crypto'
import type { CanvasUnitRecovery } from '@video-studio/shared/api/contracts'
import type { StructuredOutputCheckpoint } from '../generation/model-output-checkpoints.js'

export const visualProfileMaxAttempts = 4
export const visualProfileDeterministicFailure = (code?: string) => /^(?:visual_profile_locked_field_changed|visual_profile_correction_exhausted|visual_profile_legacy_candidate_preserved|model_(?:json_syntax|field_contract|business_validation)|structured_correction_exhausted)$/.test(code || '')
export function settledVisualResponse(value?: StructuredOutputCheckpoint): value is StructuredOutputCheckpoint & { raw: string; input_hash: string } {
  return !!value?.raw && !!value.input_hash && !(value.initial_started && value.initial_started.input_hash !== value.input_hash)
    && !(value.correction_started && (!value.correction || value.correction_started.input_hash !== value.correction.input_hash))
}
export function visualRetryToken(stepId: string, responseSlot: string, response: StructuredOutputCheckpoint, attempt: number) {
  return createHash('sha256').update(JSON.stringify({ policy: 'visual-object-retry-v2', stepId, responseSlot, response, attempt })).digest('hex')
}
/** Read-only upgrade for the original one-shot failure marker. A marker alone
 * never proves delivery: require one complete response in its exact slot. */
export function latestVisualRetry(checkpoint: { steps: Record<string, { value: unknown }> }, stepId: string) {
  const failures = Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('retry-failed:' + stepId + ':'))
  const entry = failures.at(-1)
  if (!entry) return
  const previousToken = entry[0].slice(('retry-failed:' + stepId + ':').length)
  if (!/^[a-f0-9]{64}$/.test(previousToken)) return
  const id = 'retry:' + stepId + ':' + previousToken
  const responses = Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('response:' + id + ':'))
  const response = responses[0]?.[1].value as StructuredOutputCheckpoint | undefined
  if (responses.length !== 1 || !settledVisualResponse(response) || !visualProfileDeterministicFailure((entry[1].value as { code?: string })?.code)) return
  // Insertion order is accepted only when every retained marker forms the
  // exact deterministic token chain. A partial or ambiguous history cannot
  // authorize a fresh request, including after a status-only upgrade.
  let previous: { slot: string; response: StructuredOutputCheckpoint; attempt: number } | undefined
  for (const [index, [key, marker]] of failures.entries()) {
    const spent = key.slice(('retry-failed:' + stepId + ':').length)
    const slots = Object.entries(checkpoint.steps).filter(([slot]) => slot.startsWith('response:retry:' + stepId + ':' + spent + ':'))
    const value = slots[0]?.[1].value as StructuredOutputCheckpoint | undefined
    if (!/^[a-f0-9]{64}$/.test(spent) || slots.length !== 1 || !settledVisualResponse(value)
      || !visualProfileDeterministicFailure((marker.value as { code?: string })?.code)
      || previous && spent !== visualRetryToken(stepId, previous.slot, previous.response, previous.attempt)) return
    previous = { slot: slots[0]![0], response: value, attempt: index + 2 }
  }
  const attempt = failures.length + 1
  const token = visualRetryToken(stepId, responses[0]![0], response, attempt)
  const nextId = 'retry:' + stepId + ':' + token
  const unmarked = Object.keys(checkpoint.steps).filter(key => key.startsWith('response:retry:' + stepId + ':')
    && !failures.some(([marker]) => key.startsWith('response:retry:' + stepId + ':' + marker.slice(('retry-failed:' + stepId + ':').length) + ':')))
  const recovery: CanvasUnitRecovery = unmarked.length
    ? { action: 'inspect', model_call: 'unknown', reason: '存在更新的尝试记录，其交付或校验结果尚未确认；保留记录，不能沿用较早失败再次发送。' }
    : checkpoint.steps[nextId]
    ? { action: 'inspect', model_call: 'none', reason: '最近尝试已保存结果，请读取已完成内容，不能再次发送。' }
    : attempt >= visualProfileMaxAttempts
    ? { action: 'none', model_call: 'none', reason: `本对象已完成 ${attempt}/${visualProfileMaxAttempts} 次尝试，候选仍不符合契约；可核对原答，或在任务剩余额度内明确重新整理全部参考。` }
    : { action: 'retry', model_call: 'required', token, reason: `上次回答已完整返回但契约校验失败；可明确发起第 ${attempt + 1}/${visualProfileMaxAttempts} 次尝试，仅修正失败字段。` }
  return { id, previousToken, response, responseSlot: responses[0]![0], attempt, token, recovery }
}
