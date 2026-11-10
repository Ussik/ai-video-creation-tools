import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createScriptRequestUsage, TextRequestBudgetError } from '../src/infrastructure/providers/text-request-usage.js'
import { reviewScriptDraftCompleteness } from '../src/modules/script/script-draft-completeness.js'
import { recoverScriptDraftReview } from '../src/modules/script/script-draft-review-recovery.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { ReviewPaginationStalledError } from '../src/modules/script/script-review-pagination.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const expected = [...scriptStageArtifacts.outline]
const clear = () => ({ facts: [], checked_artifacts: expected, findings: [] })
const resultText = (contract?: OutputContract) => JSON.stringify(contract?.name.endsWith('_page') ? { items: [], complete: true } : clear())
const exhausted = (partialText = '', reasoning = 65_536) => new TextOutputLimitError(partialText, 'max_output_tokens', {
  input_tokens: 92_838, output_tokens: 65_536, reasoning_tokens: reasoning,
})
const dimension = (prompt: string) => /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
const reasoningId = (scope = 'whole') => `review:reasoning:review:${scope === 'whole' ? scope : `dimension:${scope}`}`
const outputLimited = (issue: unknown) => {
  assert.ok(issue instanceof TextOutputLimitError || issue instanceof ReviewPaginationStalledError)
  return true
}

/** This fixture never imports database modules or reads any workspace data. */
function fixture() {
  let saved: GenerationCheckpoint = { steps: {} }
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
    artifacts: expected.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `第${index + 1}份候选正文完整保留。角色有确定目标，结局撤掉神位。` })) }
  const context = { uploaded_script: { filename: '原稿.md', content: '原稿明确十七个位置已满，结局撤掉神位。' },
    creator_messages: [{ role: 'user', text: '保留原稿的主线与结局。' }] }
  return { draft, context, snapshot: () => structuredClone(saved), restore: (checkpoint: GenerationCheckpoint) => { saved = structuredClone(checkpoint) },
    steps: (signal?: AbortSignal) => createGenerationSteps({ checkpoint: saved, signal,
      save: checkpoint => { saved = structuredClone(checkpoint) } }) }
}

test('pure reasoning exhaustion switches one whole review to answer policy and persists it before dispatch', async () => {
  const f = fixture(), policies: unknown[] = [], sent: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    policies.push(contract?.request_policy); sent.push(prompt)
    assert.equal(contract?.name, 'script_draft_completeness')
    for (const artifact of f.draft.artifacts) assert.ok(prompt.includes(artifact.content), 'answer mode still reads every full candidate document')
    assert.ok(prompt.includes(f.context.uploaded_script.content))
    if (policies.length === 1) throw exhausted()
    assert.equal((f.snapshot().steps[reasoningId()]?.value as { mode?: string })?.mode, 'answer',
      'the mode change is durable before another request can be dispatched')
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(policies, ['script_review', 'script_review_answer'])
  assert.equal(sent.length, 2)
  assert.ok(f.snapshot().steps['review:whole'])
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('validated whole result is reusable without a paid call'),
    { context: f.context, steps: f.steps(), answerModeSupported: true })
})

test('normal whole output limit retains dimension recovery and only an exhausted dimension changes policy', async () => {
  const f = fixture(), calls: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt), policy = contract?.request_policy
    calls.push([scope, policy])
    if (scope === 'whole') throw exhausted('{"findings":[]}', 60_000)
    if (scope === 'consistency' && policy === 'script_review') throw exhausted()
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(calls, [['whole', 'script_review'], ['settings', 'script_review'],
    ['consistency', 'script_review'], ['consistency', 'script_review_answer'], ['requirements', 'script_review']])
  for (const scope of ['settings', 'consistency', 'requirements']) assert.ok(f.snapshot().steps[`review:dimension:${scope}`])
  assert.equal((f.snapshot().steps[reasoningId('consistency')]?.value as { mode?: string })?.mode, 'answer')
  assert.equal(f.snapshot().steps[reasoningId()], undefined, 'ordinary truncation does not acquire an answer marker')
})

test('an empty exhausted whole answer switches to focused complete-work checks instead of becoming permanently blocked', async () => {
  const f = fixture(), calls: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push([scope, contract?.request_policy])
    if (scope === 'whole') throw exhausted()
    for (const artifact of f.draft.artifacts) assert.ok(prompt.includes(artifact.content))
    assert.ok(prompt.includes(f.context.uploaded_script.content))
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(calls, [['whole', 'script_review'], ['whole', 'script_review_answer'],
    ['settings', 'script_review'], ['consistency', 'script_review'], ['requirements', 'script_review']])
  assert.equal(f.snapshot().steps['review:recovery']!.value, 'dimensions')
  assert.ok(f.snapshot().steps['review:whole'])
})

test('an unfinished answer stays resumable after repeated reasoning exhaustion and retains completed dimensions', async () => {
  const f = fixture(), calls: Array<[string, unknown]> = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push([scope, contract?.request_policy])
    if (scope === 'whole') throw exhausted('incomplete review', 65_000)
    if (scope === 'consistency') throw exhausted()
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
  assert.deepEqual(calls, [['whole', 'script_review'], ['settings', 'script_review'],
    ['consistency', 'script_review'], ['consistency', 'script_review_answer'],
    ...Array.from({ length: 4 }, () => ['consistency', 'script_review_answer'])])
  const saved = f.snapshot(), settings = saved.steps['review:dimension:settings']
  assert.ok(settings)
  assert.equal((saved.steps[reasoningId('consistency')]?.value as { mode?: string })?.mode, 'answer')
  assert.equal(saved.steps['review:dimension:consistency'], undefined)
  assert.equal(saved.steps['review:whole'], undefined, 'failed review cannot become a passed whole-work audit')
  const resumed: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push([dimension(prompt), contract?.request_policy]); return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(resumed, [['consistency', 'script_review_answer'], ['requirements', 'script_review']])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
  assert.ok(f.snapshot().steps['review:whole'])
})

test('unsupported providers preserve existing dimension recovery without injecting an answer policy', async () => {
  for (const configured of [undefined, false]) {
    const f = fixture(), calls: Array<[string, unknown]> = []
    await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      const scope = dimension(prompt); calls.push([scope, contract?.request_policy])
      if (scope === 'whole') throw exhausted()
      return resultText(contract)
    }, { context: f.context, steps: f.steps(), ...(configured === undefined ? {} : { answerModeSupported: configured }) })
    assert.deepEqual(calls.map(([scope]) => scope), ['whole', 'settings', 'consistency', 'requirements'])
    assert.equal(calls.some(([, policy]) => policy === 'script_review_answer'), false)
    assert.equal(Object.keys(f.snapshot().steps).some(id => id.startsWith('review:reasoning:')), false)
  }
})

test('truncated text, missing usage and mixed answer output cannot be misclassified as pure reasoning exhaustion', async t => {
  const failures = [exhausted(resultText()), exhausted('', 65_000), new TextOutputLimitError('', 'length'),
    new TextOutputLimitError('', 'length', { output_tokens: 0, reasoning_tokens: 0 })]
  for (const [index, failure] of failures.entries()) await t.test(`non-pure failure ${index + 1}`, async () => {
    const f = fixture(), calls: Array<[string, unknown]> = []
    await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      const scope = dimension(prompt); calls.push([scope, contract?.request_policy])
      if (scope === 'whole') throw failure
      return resultText(contract)
    }, { context: f.context, steps: f.steps(), answerModeSupported: true })
    assert.deepEqual(calls.map(([scope]) => scope), ['whole', 'settings', 'consistency', 'requirements'])
    assert.equal(calls.some(([, policy]) => policy === 'script_review_answer'), false)
    assert.equal(Object.keys(f.snapshot().steps).some(id => id.startsWith('review:reasoning:')), false)
  })
})

test('transport errors, budget rejection and cancellation do not trigger answer fallback', async t => {
  const network = new TextProviderError('upstream unavailable', true, 'connection_error')
  const budget = new TextRequestBudgetError('requests', createScriptRequestUsage(), { max_requests: 1 })
  for (const [name, failure] of [['network', network], ['budget', budget]] as const) await t.test(name, async () => {
    const f = fixture(), calls: unknown[] = []
    await assert.rejects(recoverScriptDraftReview('完整候选及创作要求', async (_prompt, mode) => {
      calls.push(mode); throw failure
    }, value => value, values => values, { steps: f.steps(), answerModeSupported: true }), issue => issue === failure)
    assert.deepEqual(calls, [undefined])
    assert.deepEqual(f.snapshot().steps, {})
  })
  await t.test('cancel', async () => {
    const f = fixture(), controller = new AbortController(), reason = new DOMException('创作者已停止', 'AbortError')
    let calls = 0
    await assert.rejects(recoverScriptDraftReview('完整候选及创作要求', async () => {
      calls++; controller.abort(reason); throw exhausted()
    }, value => value, values => values,
    { signal: controller.signal, steps: f.steps(controller.signal), answerModeSupported: true }), issue => issue === reason)
    assert.equal(calls, 1)
    assert.deepEqual(f.snapshot().steps, {})
  })
})

test('answer-mode transport interruption resumes the saved answer strategy instead of repeating pure reasoning', async () => {
  const f = fixture(), network = new TextProviderError('network interrupted', false, 'connection_error')
  const modes: unknown[] = []
  await assert.rejects(recoverScriptDraftReview('完整且未变化的稿件', async (_prompt, mode) => {
    modes.push(mode)
    if (!mode) throw exhausted()
    throw network
  }, value => value, values => values, { steps: f.steps(), answerModeSupported: true }), issue => issue === network)
  assert.deepEqual(modes, [undefined, 'answer'])
  assert.equal((f.snapshot().steps[reasoningId()]?.value as { mode?: string })?.mode, 'answer')
  const resumed: unknown[] = []
  const result = await recoverScriptDraftReview('完整且未变化的稿件', async (_prompt, mode) => {
    resumed.push(mode); return { checked: true }
  }, value => value, values => values, { steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(result, { checked: true })
  assert.deepEqual(resumed, ['answer'])
})

test('historical whole-review blocked checkpoints resume the selected answer strategy and migrate before dispatch', async () => {
  const f = fixture(), network = new TextProviderError('interrupted answer', false, 'connection_error')
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    if (contract?.request_policy === 'script_review') throw exhausted()
    throw network
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), issue => issue === network)
  const saved = f.snapshot()
  saved.steps[reasoningId()]!.value = { mode: 'blocked', reason: 'max_output_tokens' }
  f.restore(saved)
  const policies: unknown[] = []
  await reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    policies.push(contract?.request_policy)
    assert.equal((f.snapshot().steps[reasoningId()]!.value as { mode: string }).mode, 'answer')
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(policies, ['script_review_answer'])
  assert.ok(f.snapshot().steps['review:whole'])
})

test('historical blocked dimensions can continue while successful dimensions stay cached', async () => {
  const f = fixture()
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt)
    if (scope === 'whole') throw exhausted('partial', 60_000)
    if (scope === 'consistency') throw exhausted()
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
  const saved = f.snapshot(), settings = saved.steps['review:dimension:settings']
  saved.steps[reasoningId('consistency')]!.value = { mode: 'blocked', reason: 'length' }
  f.restore(saved)
  const calls: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push([dimension(prompt), contract?.request_policy])
    assert.equal((f.snapshot().steps[reasoningId('consistency')]!.value as { mode: string }).mode, 'answer')
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(calls, [['consistency', 'script_review_answer'], ['requirements', 'script_review']])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
})

test('continued empty focused answers propagate once per continuation without an automatic same-input retry loop', async () => {
  const f = fixture()
  let initial = 0
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => {
    initial++; assert.ok(initial <= 8); throw exhausted()
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
  assert.equal(initial, 8, 'whole and focused reasoning/answer, followed by four progressively smaller pages')
  let resumed = 0
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed++; assert.equal(resumed, 1)
    assert.equal(dimension(prompt), 'settings'); assert.equal(contract?.request_policy, 'script_review_answer')
    throw exhausted()
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
  assert.equal(resumed, 1)
  assert.equal(f.snapshot().steps['review:whole'], undefined)
  assert.equal((f.snapshot().steps[reasoningId('settings')]!.value as { mode: string }).mode, 'answer')
})

test('changed candidate or creator context invalidates the previous exhausted answer strategy', async t => {
  for (const changed of ['candidate', 'creator'] as const) await t.test(changed, async () => {
    const f = fixture()
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => { throw exhausted() },
      { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
    if (changed === 'candidate') f.draft.artifacts[0]!.content += '新增明确约束：不得扩大名单容量。'
    else f.context.creator_messages[0]!.text += '另按修订要求明确作者答案。'
    const policies: unknown[] = []
    await reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
      policies.push(contract?.request_policy); return resultText(contract)
    }, { context: f.context, steps: f.steps(), answerModeSupported: true })
    assert.deepEqual(policies, ['script_review'], 'new work must not inherit an old failure strategy')
  })
})

test('enabling answer support does not invalidate an existing successful whole-review cache', async () => {
  const f = fixture()
  await reviewScriptDraftCompleteness(f.draft, async () => resultText(), { context: f.context, steps: f.steps() })
  const saved = f.snapshot().steps['review:whole']
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('unchanged successful work has no additional generation'),
    { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(f.snapshot().steps['review:whole'], saved)
})

test('enabling answer support reuses successful settings and resumes only the unfinished dimensions', async () => {
  const f = fixture(), network = new TextProviderError('configuration unavailable', false, 'provider_error')
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt)
    if (scope === 'whole') throw exhausted('partial', 65_000)
    if (scope === 'consistency') throw network
    return resultText(contract)
  }, { context: f.context, steps: f.steps() }), issue => issue === network)
  const settings = f.snapshot().steps['review:dimension:settings'], calls: string[] = []
  assert.ok(settings)
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => { calls.push(dimension(prompt)); return resultText(contract) },
    { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(calls, ['consistency', 'requirements'])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
})

test('whole answer text truncated at its normal limit falls back to dimensions and continuation never reissues the whole request', async () => {
  const f = fixture(), interrupted = new TextProviderError('connection interrupted', false, 'connection_error')
  const calls: Array<[string, unknown]> = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt), policy = contract?.request_policy
    calls.push([scope, policy])
    if (scope === 'whole') throw policy === 'script_review' ? exhausted() : exhausted(resultText(), 60_000)
    if (scope === 'consistency') throw interrupted
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), issue => issue === interrupted)
  assert.deepEqual(calls, [['whole', 'script_review'], ['whole', 'script_review_answer'],
    ['settings', 'script_review'], ['consistency', 'script_review']])
  assert.equal(f.snapshot().steps['review:recovery']!.value, 'dimensions')
  assert.equal((f.snapshot().steps[reasoningId()]!.value as { mode: string }).mode, 'answer',
    'ordinary answer truncation with actual text does not permanently block a whole-work audit')
  assert.equal(f.snapshot().steps['review:whole'], undefined, 'even valid JSON from a truncated response cannot pass review')
  const settings = f.snapshot().steps['review:dimension:settings']
  assert.ok(settings)
  const resumed: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push([dimension(prompt), contract?.request_policy]); return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(resumed, [['consistency', 'script_review'], ['requirements', 'script_review']])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
  assert.ok(f.snapshot().steps['review:whole'])
})

test('ordinary answer truncation keeps the failed dimension resumable without rerunning successful checks', async () => {
  const f = fixture(), calls: Array<[string, unknown]> = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt), policy = contract?.request_policy
    calls.push([scope, policy])
    if (scope === 'whole') throw exhausted('partial review', 60_000)
    if (scope === 'consistency') throw policy === 'script_review' ? exhausted() : exhausted(resultText(), 60_000)
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), outputLimited)
  assert.deepEqual(calls, [['whole', 'script_review'], ['settings', 'script_review'],
    ['consistency', 'script_review'], ['consistency', 'script_review_answer'],
    ...Array.from({ length: 4 }, () => ['consistency', 'script_review_answer'])])
  assert.equal((f.snapshot().steps[reasoningId('consistency')]!.value as { mode: string }).mode, 'answer')
  const settings = f.snapshot().steps['review:dimension:settings'], resumed: Array<[string, unknown]> = []
  assert.ok(settings)
  assert.equal(f.snapshot().steps['review:whole'], undefined, 'truncated JSON must not count as successful review')
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push([dimension(prompt), contract?.request_policy]); return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(resumed, [['consistency', 'script_review_answer'], ['requirements', 'script_review']])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
})

test('ordinary focused truncation before any reasoning fallback retains its existing unblocked resume behavior', async () => {
  const f = fixture(), partial = exhausted('actual incomplete answer', 60_000), calls: Array<[string, unknown]> = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push([scope, contract?.request_policy])
    if (scope === 'whole') throw exhausted('ordinary partial', 60_000)
    if (scope === 'consistency') throw partial
    return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true }), issue => issue instanceof ReviewPaginationStalledError && issue.cause === partial)
  assert.deepEqual(calls, [['whole', 'script_review'], ['settings', 'script_review'], ['consistency', 'script_review'],
    ...Array.from({ length: 4 }, () => ['consistency', 'script_review'])])
  assert.equal(f.snapshot().steps[reasoningId('consistency')], undefined,
    'ordinary initial truncation neither injects answer mode nor blocks the original recovery behavior')
  const resumed: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push([dimension(prompt), contract?.request_policy]); return resultText(contract)
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(resumed, [['consistency', 'script_review'], ['requirements', 'script_review']])
})
