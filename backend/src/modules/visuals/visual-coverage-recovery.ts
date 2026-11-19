import { createHash } from 'node:crypto'
import type { CanvasUnitRecovery } from '@video-studio/shared/api/contracts'
import type { StructuredOutputCheckpoint } from '../generation/model-output-checkpoints.js'
import { settledVisualResponse, visualProfileMaxAttempts, visualRetryToken } from './visual-profile-retry.js'
export const coverageRecoveryPolicy = 'coverage-recovery-v2'
export const coverageHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Entry = { input_hash?: string; value: any }
type Checkpoint = { steps: Record<string, Entry> }
export type CoverageAttempt = {
  policy: typeof coverageRecoveryPolicy; context_hash: string; parent_hash: string; token: string;
  id: string; args: unknown; state: 'running' | 'failed' | 'complete' | 'blocked';
  model_request_count: number; local_validation_count: number;
  requests: Array<{ prompt_hash: string; schema_hash: string; state: 'started' | 'completed' | 'unknown' | 'not_sent' | 'failed' }>;
  seed_hash?: string; failure_code?: string;
}
const readResponse = (checkpoint: Checkpoint, id: string) => {
  const entries = Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('response:' + id + ':'))
  if (!entries.length) return undefined
  if (entries.length !== 1 || entries[0]![1].input_hash !== entries[0]![0].slice(('response:' + id + ':').length)) throw new Error('覆盖响应绑定不唯一或已损坏')
  const [slot, entry] = entries[0]!
  if (!settledVisualResponse(entry.value)) throw new Error('覆盖响应尚未完整交付')
  return { slot, response: entry.value as StructuredOutputCheckpoint & { raw: string } }
}
/** A v1 replay is proven from its code-owned chain, not raw equality alone:
 * v1 always seeded retry.raw from its predecessor; only a correction could
 * have called the model. Every original marker and response remains intact. */
export function coverageRecoveryState(checkpoint: Checkpoint, stepId: string) {
  let model_request_count = 0, local_validation_count = 0, legacy_replay_count = 0
  let source: ReturnType<typeof readResponse>, contextHash: string | undefined
  const inspected: Array<[string, Entry]> = []
  const attempts: CoverageAttempt[] = []
  try {
    source = readResponse(checkpoint, stepId)
    if (source) {
      model_request_count = 1 + Number(!!source.response.correction)
      local_validation_count = 1
      inspected.push([source.slot, checkpoint.steps[source.slot]!])
    }
    const failures = Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('retry-failed:' + stepId + ':'))
    const accounted = new Set<string>()
    let token = source ? coverageHash({ policy: 'coverage-retry-v1', stepId, original: source.response }) : undefined
    for (const [index, [key, marker]] of failures.entries()) {
      const spent = key.slice(('retry-failed:' + stepId + ':').length)
      if (!source || spent !== token || marker.value?.code !== 'model_business_validation' || marker.value?.delivery !== 'completed') throw new Error('历史覆盖修正链无法完整核对')
      const id = 'retry:' + stepId + ':' + spent, next = readResponse(checkpoint, id)
      if (!next || next.response.input_hash !== source.response.input_hash || next.response.original_raw !== next.response.raw
        || next.response.raw !== source.response.raw) throw new Error('历史覆盖回放来源不一致，不能减免次数')
      // A correction, even with identical text, is real usage and stays charged.
      model_request_count += Number(!!next.response.correction)
      legacy_replay_count++; local_validation_count++
      accounted.add(next.slot); inspected.push([key, marker], [next.slot, checkpoint.steps[next.slot]!])
      source = next; token = visualRetryToken(stepId, next.slot, next.response, index + 2)
    }
    if (Object.keys(checkpoint.steps).some(key => key.startsWith('response:retry:' + stepId + ':') && !accounted.has(key))) throw new Error('存在未核对的覆盖请求，不能沿用旧记录再次发送')
    for (const [key, entry] of Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('coverage-attempt-v2:' + stepId + ':'))) {
      const attempt = entry.value as CoverageAttempt
      const parentHash = coverageHash(inspected)
      if (attempt.policy !== coverageRecoveryPolicy || entry.input_hash !== coverageHash(attempt.args) || attempt.parent_hash !== parentHash
        || attempt.token !== key.slice(('coverage-attempt-v2:' + stepId + ':').length)
        || attempt.id !== 'coverage-v2:' + stepId + ':' + attempt.token
        || attempt.token !== coverageHash({ policy: coverageRecoveryPolicy, stepId, parent_hash: parentHash, context_hash: attempt.context_hash })
        || contextHash && contextHash !== attempt.context_hash || !Array.isArray(attempt.requests)
        || attempt.requests.some(request => !['started', 'completed', 'unknown', 'not_sent', 'failed'].includes(request.state))
        || attempt.model_request_count !== attempt.requests.filter(request => request.state !== 'not_sent').length
        || !Number.isSafeInteger(attempt.local_validation_count) || attempt.local_validation_count < 0) throw new Error('新版覆盖尝试记录不完整，不能重新请求')
      contextHash = attempt.context_hash; attempts.push(attempt)
      model_request_count += attempt.model_request_count; local_validation_count += attempt.local_validation_count
      const next = readResponse(checkpoint, attempt.id)
      inspected.push([key, entry])
      if (next) { source = next; inspected.push([next.slot, checkpoint.steps[next.slot]!]) }
      if (attempt.state === 'running' || attempt.requests.some(request => ['started', 'unknown'].includes(request.state))) throw new Error('覆盖请求交付尚未确认')
      if (!next && attempt.state !== 'failed') throw new Error('覆盖尝试没有完整响应，需核对现场')
    }
    const parent_hash = coverageHash(inspected)
    const last = attempts.at(-1)
    const recovery: CanvasUnitRecovery = last?.state === 'complete' ? { action: 'continue', model_call: 'none', reason: '用途决策已完整验证，继续读取已有结果。' }
      : last?.state === 'blocked' ? { action: 'inspect', model_call: 'none', reason: '已有候选无法建立安全局部目标，未消耗模型次数；请核对原答，不能重复回放。' }
      : model_request_count >= visualProfileMaxAttempts ? { action: 'none', model_call: 'none', reason: `本镜头已发生 ${model_request_count}/${visualProfileMaxAttempts} 次实际模型请求，达到上限；保留全部档案及原答。请查看该镜头失败证据，人工核对首帧或视频原文与用途；不会自动重试，也不需要重新生成成功档案。` }
      : { action: 'retry', model_call: 'required', reason: `补全本镜缺失或无效字段；实际模型请求 ${model_request_count}/${visualProfileMaxAttempts} 次，本地校验 ${local_validation_count} 次。保留成功档案和原答。` }
    return { model_request_count, local_validation_count, legacy_replay_count, parent_hash, source, attempts, context_hash: contextHash, recovery, blocked: false }
  } catch (error) {
    return { model_request_count, local_validation_count, legacy_replay_count, parent_hash: '', source, attempts, context_hash: contextHash,
      blocked: true, recovery: { action: 'inspect', model_call: 'unknown', reason: (error as Error).message } as CanvasUnitRecovery }
  }
}
export function coverageRecoveryToken(stepId: string, parent_hash: string, context_hash: string) {
  return coverageHash({ policy: coverageRecoveryPolicy, stepId, parent_hash, context_hash })
}
