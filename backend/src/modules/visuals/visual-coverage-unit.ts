import { z } from 'zod'
import type { CanvasUnitFailure } from '@video-studio/shared/api/contracts'
import { generateStructuredOutput, outputContract, type StructuredGenerator } from '../generation/model-output.js'
import type { GenerationSteps } from '../script/script-generation-steps.js'
import type { StructuredOutputLocalPlanner } from '../generation/model-output-local-repair.js'
import { completeStructuredRoot } from '../generation/structured-output.js'
import { reportModelResult } from '../generation/model-result-observation.js'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import { TextRequestBudgetError } from '../../infrastructure/providers/text-request-usage.js'
import { TextInputScopeError } from '../../infrastructure/providers/text-input-scope.js'
import { currentStructuredDispatchIntent, isLocalModelAdmissionDenied, structuredDispatchMayHaveSent } from '../generation/model-request-admission.js'
import { visualProfileMaxAttempts } from './visual-profile-retry.js'
import { coverageHash as hash, coverageRecoveryPolicy, coverageRecoveryState, coverageRecoveryToken, type CoverageAttempt } from './visual-coverage-recovery.js'

export function visualCoverageBinding(input: { key: string; schema: z.ZodType; prompt: string; requestPrompt?: string }) {
  const schema = outputContract('visual_reference_coverage', input.schema).schema
  const identity = { policy: 'visual-coverage-unit-v1', prompt: input.prompt, schema }
  const stepId = 'unit:' + hash(identity) + ':' + input.key
  const requestPrompt = input.requestPrompt || input.prompt
  const context_hash = hash({ policy: coverageRecoveryPolicy, stepId, prompt: requestPrompt, schema })
  return { schema, identity, stepId, originalInput: { identity, key: input.key }, requestPrompt, context_hash }
}

export function assertCoverageResponseBinding(steps: GenerationSteps, binding: ReturnType<typeof visualCoverageBinding>, state: ReturnType<typeof coverageRecoveryState>) {
  const { stepId, originalInput, schema, requestPrompt, context_hash } = binding
  if (state.blocked || state.context_hash && state.context_hash !== context_hash) throw new Error('覆盖来源或请求状态未能完整核对')
  const original = steps.readStructuredResponse?.(stepId, originalInput, 'visual_reference_coverage', originalInput.identity.prompt, schema)
  if (!original && (state.legacy_replay_count || originalInput.key === '@visual-coverage' && state.source?.slot.startsWith('response:' + stepId + ':'))) {
    throw new Error('历史覆盖与当前精确输入不匹配')
  }
  for (const attempt of state.attempts) {
    const dispatch = (attempt.args as { dispatch_binding?: { prompt: string; schema: Record<string, unknown> } }).dispatch_binding
    if (!steps.readStructuredResponse?.(attempt.id, attempt.args, 'visual_reference_coverage', dispatch?.prompt || requestPrompt, dispatch?.schema || schema)) {
      throw new Error('用途补全响应未能精确绑定当前来源和契约')
    }
  }
}

export function coverageReplaySeed(state: ReturnType<typeof coverageRecoveryState>) {
  const response = state.source?.response
  return response?.local_repair?.candidate !== undefined ? JSON.stringify(response.local_repair.candidate) : response?.raw
}

/** Local validation never buys another model allowance. v1 bytes and fake
 * retry receipts stay immutable; explicit v2 actions append their own audit. */
export async function visualCoverageUnit<T>(input: {
  key: string; name: string; sceneIds: string[]; shotIds: string[]; schema: z.ZodType<T>; prompt: string; requestPrompt?: string;
  steps: GenerationSteps; generate: StructuredGenerator; signal?: AbortSignal; retryToken?: string;
  dispatchSchema?: z.ZodType; dispatchPrompt?: string;
  validate: (value: unknown) => T; planLocalRepair?: StructuredOutputLocalPlanner; seedRaw?: string; allowModelDispatch?: boolean; normalize?: (value: unknown) => unknown; trustedTerminalTransport?: boolean;
}): Promise<{ value: T } | { failure: CanvasUnitFailure }> {
  const binding = visualCoverageBinding(input)
  const { schema, identity, stepId, originalInput, requestPrompt, context_hash } = binding
  let state = coverageRecoveryState(input.steps.checkpoint, stepId)
  if (state.blocked && input.trustedTerminalTransport) {
    const checkpoint = structuredClone(input.steps.checkpoint)
    for (const [key, entry] of Object.entries(checkpoint.steps)) {
      const value = entry.value as any
      if (key.startsWith('response:' + stepId + ':') && value?.correction_started && !value.correction) delete value.correction_started
      if (key.startsWith('coverage-attempt-v2:' + stepId + ':')) {
        const attempt = entry.value as CoverageAttempt
        for (const request of attempt.requests) if (request.state === 'unknown') request.state = 'failed'
      }
    }
    state = coverageRecoveryState(checkpoint, stepId)
  }
  const token = coverageRecoveryToken(stepId, state.parent_hash, context_hash)
  const previous = state.attempts.at(-1)
  const dispatchPrompt = input.dispatchPrompt || requestPrompt
  const dispatchSchema = input.dispatchSchema ? outputContract('visual_reference_coverage', input.dispatchSchema).schema : schema
  let calls = 0
  const failure = (error?: unknown): { failure: CanvasUnitFailure } => {
    const now = coverageRecoveryState(input.steps.checkpoint, stepId)
    const recovery = { ...now.recovery }
    if (!now.blocked && recovery.action === 'retry') recovery.token = coverageRecoveryToken(stepId, now.parent_hash, context_hash)
    const errorCode = (error as any)?.code
    if (errorCode === 'visual_coverage_local_target_unavailable') Object.assign(recovery, { action: 'inspect', model_call: 'none', token: undefined, reason: (error as Error).message })
    if (!now.blocked && errorCode === 'visual_coverage_identity_ambiguous') Object.assign(recovery, { action: 'inspect', model_call: 'none', token: undefined, reason: (error as Error).message })
    const unit: CanvasUnitFailure = { unit_key: input.key, name: input.name, stage: 'coverage',
      code: now.blocked ? 'model_delivery_unknown' : errorCode || now.attempts.at(-1)?.failure_code || 'visual_coverage_conflict',
      message: error instanceof Error ? error.message : now.recovery.reason || '已有回答待补全，仅处理本镜用途。',
      retryable: false, recovery_type: 'blocked', checkpoint_source: now.source?.response.correction ? 'correction' : now.source ? 'original_raw' : 'none',
      is_new_model_call: calls > 0, attempt: now.model_request_count, model_request_count: now.model_request_count,
      local_validation_count: now.local_validation_count, recovery_version: coverageRecoveryPolicy,
      scene_ids: input.sceneIds, shot_ids: input.shotIds, recovery }
    input.steps.retain('visual-unit-failure:' + hash(identity) + ':' + input.key, '保留覆盖单元进度', originalInput, unit, value => value)
    reportModelResult({ phase: 'structure', status: 'invalid_contract', stage: 'visual_organization', unit_key: input.key,
      attempt: unit.attempt, model_request_count: unit.model_request_count, local_validation_count: unit.local_validation_count,
      checkpoint_source: unit.checkpoint_source, is_new_model_call: calls > 0, failure_code: unit.code, request_category: calls ? 'local_patch' : 'local_reuse' })
    return { failure: unit }
  }
  // A changed code version is not permission to bypass a delivery fence.
  if (state.blocked || state.context_hash && state.context_hash !== context_hash) return failure(Object.assign(new Error('覆盖来源或执行版本未能完整核对，不能重新发送。'), { code: 'visual_coverage_retry_unavailable' }))
  try {
    assertCoverageResponseBinding(input.steps, binding, state)
    // Validated IR is reused before any local or model attempt is opened.
    if (input.steps.checkpoint.steps[stepId]) {
      const saved = input.steps.checkpoint.steps[stepId]!
      if (saved.input_hash !== hash(originalInput)) throw new Error('已完成用途决策与当前输入不匹配')
      return { value: input.validate(saved.value) }
    }
    if (previous?.state === 'complete') {
      const saved = input.steps.checkpoint.steps[previous.id]
      if (!saved || saved.input_hash !== hash(previous.args)) throw new Error('已完成补全结果与当前输入不匹配')
      return { value: input.validate(saved.value) }
    }
  } catch (error) { return failure(Object.assign(error as Error, { code: 'visual_coverage_retry_unavailable' })) }
  if (input.retryToken && input.steps.checkpoint.steps['coverage-attempt-v2:' + stepId + ':' + input.retryToken]) return failure()
  if (input.retryToken && (state.recovery.action !== 'retry' || input.retryToken !== token)) return failure(Object.assign(new Error('用途补全入口已变化，请重新读取状态；未发出请求。'), { code: 'visual_coverage_retry_unavailable' }))
  const seed = coverageReplaySeed(state) || input.seedRaw
  // A purely structural upgrade can occasionally validate without a request.
  // It remains a local result, separate from the immutable paid response.
  if (seed) {
    const root = completeStructuredRoot(seed, { allowFenceExplanation: true })
    if (root) try {
      const value = input.validate(input.normalize?.(root.value) ?? root.value)
      input.steps.retain('coverage-local-v2:' + stepId + ':' + context_hash, '采用已验证本地用途决策',
        { context_hash, source_hash: hash(seed) }, value, input.validate)
      return { value }
    } catch (error) {
      if ((error as any)?.code === 'visual_coverage_identity_ambiguous') return failure(error)
    }
  }
  if (state.recovery.action === 'none' || state.recovery.action === 'inspect') return failure()
  if (!input.retryToken && (state.source || previous)) return failure()
  if (input.allowModelDispatch === false) return { failure: { unit_key: input.key, name: input.name, stage: 'coverage', code: 'visual_coverage_pending',
    message: '此镜头未在本次处理范围内，保留待处理，不调用模型。', retryable: false, recovery_type: 'none', checkpoint_source: 'none',
    is_new_model_call: false, attempt: 0, model_request_count: 0, local_validation_count: 0, scene_ids: input.sceneIds, shot_ids: input.shotIds,
    recovery: { action: 'continue', model_call: 'possible' } } }
  // Prove an executable fixed patch before creating a new attempt. A replay
  // that cannot advance is a local block, never another paid-model attempt.
  if (seed) {
    const root = completeStructuredRoot(seed, { allowFenceExplanation: true })
    const candidate = root ? input.normalize?.(root.value) ?? root.value : undefined
    if (candidate !== undefined) {
      try { return { value: input.validate(candidate) } } catch (error) {
        const issues = error instanceof z.ZodError ? error.issues : input.schema.safeParse(candidate).error?.issues || []
        if (!input.planLocalRepair?.(candidate, { issues, error })) return failure(Object.assign(new Error('现有用途回答无法建立安全补全目标，未发送模型请求；需核对对象键和保留原答。'), { code: 'visual_coverage_local_target_unavailable' }))
      }
    } else return failure(Object.assign(new Error('原答不是唯一完整JSON，无法安全补全；未发送模型请求。'), { code: 'visual_coverage_local_target_unavailable' }))
  }
  const id = 'coverage-v2:' + stepId + ':' + token
  const args = { policy: coverageRecoveryPolicy, identity, context_hash, parent_hash: state.parent_hash, seed_hash: seed ? hash(seed) : null,
    ...(input.dispatchSchema || input.dispatchPrompt ? { dispatch_binding: { prompt: dispatchPrompt, schema: dispatchSchema } } : {}) }
  const audit: CoverageAttempt = { policy: coverageRecoveryPolicy, context_hash, parent_hash: state.parent_hash, token, id, args,
    state: 'running', model_request_count: 0, local_validation_count: 0, requests: [], ...(seed ? { seed_hash: hash(seed) } : {}) }
  const auditId = 'coverage-attempt-v2:' + stepId + ':' + token
  const persist = () => input.steps.retain(auditId, '覆盖实际请求与本地校验账本', args, audit, value => value)
  // This is an additive migration receipt, never a reset/deletion of old use.
  if (state.legacy_replay_count && !input.steps.checkpoint.steps['coverage-migration-v2:' + stepId]) input.steps.retain('coverage-migration-v2:' + stepId, '记录历史本地回放核对',
    { stepId, context_hash, parent_hash: state.parent_hash }, { policy: coverageRecoveryPolicy, parent_hash: state.parent_hash,
      legacy_replay_count: state.legacy_replay_count, model_request_count: state.model_request_count, local_validation_count: state.local_validation_count }, value => value)
  persist()
  try {
    const value = await input.steps.run(id, input.name, args, () => generateStructuredOutput('visual_reference_coverage', input.schema,
      async (prompt, contract, context) => {
        if (seed && contract?.name === 'visual_reference_coverage') { audit.local_validation_count++; persist(); return seed }
        if (state.model_request_count + audit.model_request_count >= visualProfileMaxAttempts) throw Object.assign(new Error('实际模型请求已达限额'), { code: 'visual_coverage_model_limit' })
        const request: CoverageAttempt['requests'][number] = { prompt_hash: hash(prompt), schema_hash: hash(contract), state: 'started' }
        audit.requests.push(request); audit.model_request_count++; persist(); calls++
        try { const result = await input.generate(prompt, contract, context); request.state = 'completed'; audit.local_validation_count++; persist(); return result }
        catch (error) {
          const intent = currentStructuredDispatchIntent()
          const notSent = isLocalModelAdmissionDenied(error, intent) || !structuredDispatchMayHaveSent(intent) &&
            (error instanceof TextRequestBudgetError || error instanceof TextInputScopeError || error instanceof TextProviderError && error.delivery === 'not_sent')
          request.state = notSent ? 'not_sent' : 'unknown'
          if (request.state === 'not_sent') { audit.model_request_count--; calls-- }
          persist(); throw error
        }
      }, dispatchPrompt, { signal: input.signal, requestSchema: input.dispatchSchema, preserveInputIdentity: true, freezeCorrection: true, localRepairOnly: true,
        localSyntaxOnly: true, structuralRepair: false, maxAttempts: seed || state.model_request_count + 1 < visualProfileMaxAttempts ? 2 : 1,
        stopOnBusinessError: false, normalize: input.normalize, validate: input.validate, planLocalRepair: input.planLocalRepair }), input.validate)
    audit.state = 'complete'; persist()
    reportModelResult({ phase: 'structure', status: 'valid', stage: 'visual_organization', unit_key: input.key,
      attempt: state.model_request_count + audit.model_request_count, model_request_count: state.model_request_count + audit.model_request_count,
      local_validation_count: state.local_validation_count + audit.local_validation_count, is_new_model_call: calls > 0,
      request_category: calls ? 'local_patch' : 'local_reuse' })
    return { value }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    audit.state = audit.model_request_count > 0 ? 'failed' : 'blocked'; audit.failure_code = (error as any).code || 'model_delivery_unknown'; persist()
    return failure(error)
  }
}
