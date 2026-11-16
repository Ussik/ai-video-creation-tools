import { createHash } from 'node:crypto'
import type { GenerationSteps } from './script-generation-steps.js'
import { scriptDraftReviewDimensionPrompts } from './script-draft-review-recovery.js'

const inputHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function draftReviewMigrationRequired(cause?: unknown) {
  return Object.assign(new Error('旧版审读仍有未完成的私有响应或分页状态；原检查点已保留，不能自动改用新协议重新购买审读。请先完成原恢复链。', { cause }), {
    code: 'script_draft_review_protocol_migration_required', statusCode: 409, retryable: false,
  })
}

/** A protocol change is not a reason to discard paid work. Only an exact old
 * input and a revalidated completed business result can acquire the new hash.
 * Unfinished quoted reports stay on their original evidence recovery path. */
export async function migrateDraftReviewCoordinates<T>(options: {
  legacyPrompt: string; prompt: string; legacySteps?: GenerationSteps; steps?: GenerationSteps;
  taskLabel?: string; parentId?: string; validate: (value: unknown) => T; validateCombined: (value: unknown) => T;
  legacyReview: () => Promise<T>; legacyResponseSchema?: unknown;
}): Promise<{ result: T } | undefined> {
  const { legacySteps, steps, legacyPrompt, prompt, parentId } = options
  if (!legacySteps || !steps) return
  const oldEntries = legacySteps.checkpoint.steps
  const currentWhole = steps.checkpoint.steps['review:whole']
  if (currentWhole?.input_hash === inputHash({ version: 3, prompt })) {
    const recovery = steps.checkpoint.steps['review:recovery']
    // A complete aggregate cannot bypass its independently retained children.
    // Focused recovery revalidates every dimension before recombining them.
    if (recovery?.input_hash === inputHash({ version: 1, prompt }) && recovery.value === 'dimensions') return
    try { return { result: options.validateCombined(currentWhole.value) } }
    catch { /* Ordinary current-protocol recovery revalidates its cache below. */ }
  }
  const exact = (id: string, input: unknown) => {
    const entry = oldEntries[id]
    return entry?.input_hash === inputHash(input) ? entry : undefined
  }
  const retainWhole = (value: unknown) => steps.retain('review:whole', '复用已完成的原协议整体审读',
    { version: 3, prompt }, value, options.validateCombined, parentId)
  const complete = options.taskLabel && exact('result', { version: 1, prompt: legacyPrompt }) ||
    exact('review:whole', { version: 3, prompt: legacyPrompt })
  if (complete) {
    try { return { result: retainWhole(complete.value) } }
    catch (cause) { throw draftReviewMigrationRequired(cause) }
  }
  const oldDimensions = scriptDraftReviewDimensionPrompts(legacyPrompt)
  const dimensions = scriptDraftReviewDimensionPrompts(prompt)
  const oldPrompts = [legacyPrompt, ...oldDimensions.map(dimension => dimension.prompt)]
  // Factory responses live outside logical task prefixes. Reconstruct their
  // exact original binding through the read-only API; never scan all response
  // IDs or interpret a response from a changed task/model/context as this one.
  const privateScopes = [
    { id: 'review:whole', input: { version: 3, prompt: legacyPrompt }, prompt: legacyPrompt },
    ...oldDimensions.map(dimension => ({ id: `review:dimension:${dimension.id}`,
      input: { version: 1, prompt: dimension.prompt }, prompt: dimension.prompt })),
  ]
  if (options.legacyResponseSchema && privateScopes.some(scope => {
    if (exact(scope.id, scope.input)) return false
    const response = legacySteps.readStructuredResponse?.(scope.id, scope.input,
      'script_draft_completeness', scope.prompt, options.legacyResponseSchema)
    return response && (response.raw !== undefined || response.original_raw !== undefined || response.correction ||
      response.initial_started || response.correction_started)
  })) {
    // Valid complete raw bytes can finish locally under the exact old schema.
    // Unknown delivery and exhausted corrections retain their old boundary;
    // the callback is forbidden from purchasing a fresh quoted review.
    return { result: retainWhole(await options.legacyReview()) }
  }
  const report = (text: string) => `review:response:${createHash('sha256').update(text).digest('hex')}`
  const hasProvisional = oldPrompts.some(text => exact(report(text), { version: 1, prompt: text }))
  const hasPrivateState = oldPrompts.some(text => Object.keys(oldEntries).some(id =>
    id.startsWith(`${report(text)}:`)))
  if (hasProvisional) {
    // The supplied callback forbids a new legacy semantic review. It may only
    // read exact completed caches or locate/reassess an exact retained report.
    return { result: retainWhole(await options.legacyReview()) }
  }
  const completedDimensions = oldDimensions.flatMap((old, index) => {
    const id = `review:dimension:${old.id}`
    const entry = exact(id, { version: 1, prompt: old.prompt })
    if (!entry) return []
    try { return [{ id, label: old.label, prompt: dimensions[index]!.prompt, value: options.validate(entry.value) }] }
    catch (cause) { throw draftReviewMigrationRequired(cause) }
  })
  if (hasPrivateState) {
    // Closed quote seeds/page states have their own report completeness and
    // semantic history. Do not guess coordinates or erase them on upgrade.
    throw draftReviewMigrationRequired()
  }
  for (const item of completedDimensions) {
    const input = { version: 1, prompt: item.prompt }
    if (steps.checkpoint.steps[item.id]?.input_hash !== inputHash(input)) {
      steps.retain(item.id, item.label, input, item.value, options.validate, parentId)
    }
  }
  // Strategy facts do not complete a semantic check. Copy them only under
  // their precise old inputs, so an exhausted request is not replayed.
  for (const pair of [
    { id: 'review:whole', old: { version: 3, prompt: legacyPrompt }, current: { version: 3, prompt } },
    ...oldDimensions.map((old, index) => ({ id: `review:dimension:${old.id}`,
      old: { version: 1, prompt: old.prompt }, current: { version: 1, prompt: dimensions[index]!.prompt } })),
  ]) {
    for (const kind of ['reasoning', 'paging'] as const) {
      const id = `review:${kind}:${pair.id}`
      const currentInput = { version: 1, input: pair.current }
      if (steps.checkpoint.steps[id]?.input_hash === inputHash(currentInput)) continue
      const saved = exact(id, { version: 1, input: pair.old })
      if (!saved) continue
      const valid = kind === 'paging' ? saved.value === 'paged' || saved.value === 'paged_answer'
        : !!saved.value && typeof saved.value === 'object' && 'mode' in saved.value &&
          ['answer', 'blocked'].includes(String(saved.value.mode))
      if (!valid) throw draftReviewMigrationRequired()
      steps.retain(id, '保留原审读恢复策略', currentInput, saved.value, value => value, parentId)
    }
  }
  const strategy = exact('review:recovery', { version: 1, prompt: legacyPrompt })
  if (strategy?.value === 'dimensions' && steps.checkpoint.steps['review:recovery']?.input_hash !== inputHash({ version: 1, prompt })) steps.retain('review:recovery', '继续已选择的独立分项审读',
    { version: 1, prompt }, 'dimensions', value => {
      if (value !== 'dimensions') throw draftReviewMigrationRequired()
      return value
    }, parentId)
}
