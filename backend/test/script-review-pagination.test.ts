import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generatePagedReviewItems, ReviewPaginationStalledError } from '../src/modules/script/script-review-pagination.js'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const itemSchema = z.object({ id: z.string(), quote: z.string() }).strict()
const source = '完整原稿：开场拿到铜钥匙，结尾归还铜钥匙。'
const item = (id: string) => ({ id, quote: '铜钥匙' })
const page = (items: unknown[], complete: boolean) => JSON.stringify({ items, complete })
function store() {
  let saved: GenerationCheckpoint = { steps: {} }
  return { steps: () => createGenerationSteps({ checkpoint: saved, save: state => { saved = structuredClone(state) } }),
    snapshot: () => structuredClone(saved) }
}
const base = { id: 'review:pages', name: 'test_review', itemSchema, prompt: source, maxItems: 10 }

test('report pages retain only closed valid items and resume without repeating finished output after a network error', async () => {
  const f = store(), interrupted = new TextProviderError('interrupted', false)
  let calls = 0
  await assert.rejects(generatePagedReviewItems({ ...base, steps: f.steps(), generate: async (prompt, contract) => {
    calls++; assert.ok(prompt.includes(source)); assert.equal(contract?.name, 'test_review_page')
    if (calls === 1) throw new TextOutputLimitError('{"items":[' + JSON.stringify(item('one')) + ',{"id":"partial', 'length')
    assert.ok(prompt.includes(JSON.stringify([item('one')]))); throw interrupted
  } }), issue => issue === interrupted)
  assert.deepEqual((f.snapshot().steps[base.id]!.value as { items: unknown[] }).items, [item('one')])
  const result = await generatePagedReviewItems({ ...base, steps: f.steps(), generate: async prompt => {
    assert.ok(prompt.includes(source)); assert.ok(prompt.includes(JSON.stringify([item('one')])));
    assert.ok(!prompt.includes('"id":"partial')); return page([item('two')], true)
  } })
  assert.deepEqual(result, [item('one'), item('two')])
  await generatePagedReviewItems({ ...base, steps: f.steps(), generate: async () => assert.fail('finished pages must be reusable') })
})

test('unchanged repeated output shrinks pages and stops without a false completion or an unbounded retry loop', async () => {
  const f = store(), sizes: number[] = []
  await assert.rejects(generatePagedReviewItems({ ...base, steps: f.steps(), initialItems: [item('one')], generate: async prompt => {
    sizes.push(Number(/本次最多返回 (\d+) 项/.exec(prompt)![1])); return page([item('one')], true)
  } }), ReviewPaginationStalledError)
  assert.deepEqual(sizes, [8, 4, 2, 1])
  assert.equal((f.snapshot().steps[base.id]!.value as { complete: boolean }).complete, false)
  assert.deepEqual(await generatePagedReviewItems({ ...base, steps: f.steps(), generate: async prompt => {
    assert.match(prompt, /本次最多返回 1 项/); return page([item('two')], true)
  } }), [item('one'), item('two')])
})

test('no-issue reports require an explicit complete page, while changed source invalidates a completed report', async () => {
  const f = store()
  assert.deepEqual(await generatePagedReviewItems({ ...base, steps: f.steps(), generate: async () => page([], true) }), [])
  let calls = 0
  const result = await generatePagedReviewItems({ ...base, prompt: source + '新增作者要求', steps: f.steps(), generate: async () => {
    calls++; return page([item('changed')], true)
  } })
  assert.equal(calls, 1); assert.deepEqual(result, [item('changed')])
})

test('invalid closed items, nested quoted examples and conflicting cumulative results never become accepted reports', async () => {
  const f = store()
  await assert.rejects(generatePagedReviewItems({ ...base, steps: f.steps(), generate: async () => {
    throw new TextOutputLimitError('{"items":[{"id":"invalid","quote":3},', 'length')
  } }))
  assert.deepEqual((f.snapshot().steps[base.id]!.value as { items: unknown[] }).items, [])
  let calls = 0
  await assert.rejects(generatePagedReviewItems({ ...base, generate: async () => {
    calls++; throw new TextOutputLimitError('{"example":{"items":[' + JSON.stringify(item('fake')) + ']}', 'length')
  } }), ReviewPaginationStalledError)
  assert.equal(calls, 4)
  await assert.rejects(generatePagedReviewItems({ ...base, initialItems: [item('same')], generate: async () => page([{ ...item('same'), quote: '变更' }], true),
    validateItems: items => { if (new Set(items.map(value => value.id)).size !== items.length) throw new Error('conflicting identity') },
  }), /conflicting identity/)
})

test('cancellation retains accepted items and dispatches no further page', async () => {
  const f = store(), controller = new AbortController(), reason = new Error('creator stopped')
  let calls = 0
  await assert.rejects(generatePagedReviewItems({ ...base, signal: controller.signal, steps: f.steps(), generate: async () => {
    if (++calls === 1) return page([item('one')], false)
    controller.abort(reason); throw reason
  } }), issue => issue === reason)
  assert.equal(calls, 2)
  assert.deepEqual((f.snapshot().steps[base.id]!.value as { items: unknown[] }).items, [item('one')])
})

test('an already cancelled resume leaves every saved page unchanged even when business validation checks the signal', async () => {
  const f = store(), interrupted = new TextProviderError('interrupted', false)
  let calls = 0
  await assert.rejects(generatePagedReviewItems({ ...base, steps: f.steps(), generate: async () => {
    if (++calls === 1) return page([item('saved')], false)
    throw interrupted
  } }), issue => issue === interrupted)
  const saved = f.snapshot(), controller = new AbortController(), reason = new Error('already cancelled')
  controller.abort(reason)
  await assert.rejects(generatePagedReviewItems({ ...base, steps: f.steps(), signal: controller.signal,
    validateItem: () => controller.signal.throwIfAborted(), generate: async () => assert.fail('cancelled resume must not dispatch'),
  }), issue => issue === reason)
  assert.deepEqual(f.snapshot(), saved)
})

test('closed strict-wire items restore optional nulls while required nulls remain invalid', async () => {
  const schema = itemSchema.extend({ note: z.string().optional() })
  let calls = 0
  const result = await generatePagedReviewItems({ ...base, itemSchema: schema, generate: async () => {
    if (++calls === 1) throw new TextOutputLimitError('{"result":{"items":[{"id":"one","quote":"铜钥匙","note":null},', 'length')
    return page([], true)
  } })
  assert.deepEqual(result, [item('one')])
  await assert.rejects(generatePagedReviewItems({ ...base, itemSchema: schema, generate: async () => {
    throw new TextOutputLimitError('{"items":[{"id":"one","quote":null,"note":null},', 'length')
  } }))
})

test('a focused stage audit exceeding output limits finishes as pages and retains every validated finding', async () => {
  const f = store(), types = [...scriptStageArtifacts.outline]
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [], artifacts: types.map(artifact_type => ({
    artifact_type, title: scriptArtifactLabels[artifact_type], content: '开场得到钥匙，结尾却没有归还。',
  })) }
  const finding = { source_key: types[0]!, kind: 'contradiction', severity: 'blocking', quote: '结尾却没有归还',
    explanation: '结尾与作者明确要求归还钥匙冲突。', suggestion: '落实归还的既定结局。' }
  const calls: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    const dimension = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
    calls.push(`${dimension}:${contract?.name}`)
    if (dimension === 'whole') throw new TextOutputLimitError('', 'length')
    if (dimension === 'settings') {
      if (contract?.name === 'script_draft_completeness') throw new TextOutputLimitError('', 'length')
      if (!prompt.includes(JSON.stringify([finding]))) return page([finding], false)
      return page([], true)
    }
    return JSON.stringify({ facts: [], findings: [], checked_artifacts: types })
  }, { context: { uploaded_script: { content: source } }, steps: f.steps() }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution); assert.equal(issue.findings.length, 1)
    assert.equal(issue.findings[0]!.quote, finding.quote); return true
  })
  assert.deepEqual(calls, ['whole:script_draft_completeness', 'settings:script_draft_completeness',
    'settings:script_draft_completeness_page', 'settings:script_draft_completeness_page',
    'consistency:script_draft_completeness', 'requirements:script_draft_completeness'])
})

test('blocking findings closed before whole-audit truncation survive three empty dimensions with their original severity', async t => {
  for (const persisted of [false, true]) await t.test(persisted ? 'persistent checkpoint' : 'current execution', async () => {
    const f = store(), types = [...scriptStageArtifacts.outline]
    const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [], artifacts: types.map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: '结尾没有归还钥匙。',
    })) }
    const blocking = { source_key: types[0]!, kind: 'contradiction', severity: 'blocking', quote: '没有归还钥匙',
      explanation: '违反归还钥匙的明确结局。', suggestion: '落实既定结局。' }
    const suggestion = { ...blocking, source_key: types[1]!, severity: 'suggestion', explanation: '可补充情绪层次。' }
    const notices: unknown[] = [], calls: string[] = []
    await assert.rejects(reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
      const dimension = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
      calls.push(dimension)
      if (dimension === 'whole') throw new TextOutputLimitError('{"findings":[' + JSON.stringify(blocking) + ',' + JSON.stringify(suggestion) + ',{"quote":"unfinished', 'length')
      return JSON.stringify({ facts: [], findings: [], checked_artifacts: types })
    }, { ...(persisted ? { steps: f.steps() } : {}), onSuggestions: findings => notices.push(...findings) }), issue => {
      assert.ok(issue instanceof ScriptDraftNeedsResolution)
      assert.equal(issue.findings.length, 1); assert.equal(issue.findings[0]!.explanation, blocking.explanation)
      return true
    })
    assert.deepEqual(calls, ['whole', 'settings', 'consistency', 'requirements'])
    assert.equal(notices.length, 1)
  })
})
