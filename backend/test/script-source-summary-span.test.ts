import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'

const document = { filename: 'span-fixture.txt', content: '第一集\n林舟守约。\n沈月归还信物。\n杜铮受到细线操控。\n' }
const units = scriptSourcePassages(document.content).flatMap(passage => passage.units)
const unit = units.find(item => item.text.includes('林舟'))!
const marker = '【原稿分析定点修补资料】\n'
const signal = () => new AbortController().signal
function stateFor(summary = '林舟守约。沈月归还信物。', count = 1): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'span-fixture', source_version: 'same-source', model_id: 'same-model', status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: document.content.length, error: 'quality findings', updated_at: 'fixture',
    sections: [{ offset: 0, length: document.content.length, unit_id: 0, title: '第一集', episode_number: 1, summary: '林舟守约，沈月归还信物',
      characters: [{ name: '林舟', description: '守约的人', evidence: { offset: unit.offset, quote: unit.text } }], events: [], open_threads: [] }],
    story: { summary, characters: [{ name: '林舟', aliases: [], description: '守约的人', section_ids: [0] }],
      timeline: [{ summary: '林舟守约', section_ids: [0] }], threads: [], ending: { summary: '信物归还', section_ids: [0] }, uncertainties: [] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: Array.from({ length: count }, (_, index) =>
    ({ kind: 'causality' as const, explanation: `核对摘要第${index + 1}处表述`, unit_ids: [unit.id] })) }
  return state
}
const span = (state: ScriptSourceAnalysis, expected: string, value: string) => ({ target: 'story.summary', section_id: null,
  operation: 'replace_span', index: null, baseline_hash: sourceQualityInputHash(state), expected, value })
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '仅修补当前原文支持的表述', changes })
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const rejectedBody = (changes: unknown[], prompt: string, name?: string) => {
  if (!name?.endsWith('_local_repair')) return body(changes)
  const marker = '【局部纠正资料】\n', index = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)).change_index
  return JSON.stringify({ repairs: { [`change_${index}`]: changes[index] } })
}
async function expectRejected(state: ScriptSourceAnalysis, changes: unknown[], pattern?: RegExp) {
  const original = structuredClone(state)
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async (prompt, contract) => { calls++; return rejectedBody(changes, prompt, contract?.name) }, () => {}, signal()), pattern)
  assert.ok(calls <= 2)
  assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
  assert.deepEqual(state.quality, original.quality); assert.equal(state.quality_repair?.completed_findings, 0)
}

test('a long summary span preserves exact Chinese Unicode CRLF prefix suffix and unrelated analysis', async () => {
  const prefix = '前文'.repeat(900) + ' e\u0301；\r\n', expected = '沈月😀归还信物', value = '沈月😀归还旧信物'
  const suffix = '\n杜铮受到细线操控。' + '后文'.repeat(900)
  const state = stateFor(prefix + expected + suffix), original = structuredClone(state), hash = sourceQualityInputHash(state)
  let calls = 0
  await repairSourceQuality(document, state, async (prompt, contract) => {
    calls++
    const data = input(prompt)
    assert.equal(data.baseline_hash, hash); assert.equal(data.story.summary, original.story!.summary)
    assert.equal(data.units.map((item: { text: string }) => item.text).join(''), document.content)
    assert.match(prompt, /较长且只需修改一处时优先operation=replace_span/)
    assert.match(JSON.stringify(contract!.schema), /"const":"replace_span"/)
    return body([span(state, expected, value)])
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.story!.summary, prefix + value + suffix)
  assert.deepEqual(Buffer.from(state.story!.summary.slice(0, prefix.length)), Buffer.from(prefix))
  assert.deepEqual(Buffer.from(state.story!.summary.slice(prefix.length + value.length)), Buffer.from(suffix))
  assert.deepEqual(state.story, { ...original.story, summary: prefix + value + suffix })
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.quality, original.quality)
  assert.equal(state.quality!.status, 'issues', 'a precise edit still needs independent semantic review')
})

test('a valid span and unrelated list edit use one frozen analysis hash in either order', async t => {
  for (const order of ['span first', 'list first']) await t.test(order, async () => {
    const state = stateFor(), original = structuredClone(state)
    const changes = [span(state, '守约', '履约'), { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
      expected: state.story!.timeline[0], value: { summary: '林舟依约行事', section_ids: [0] } }]
    if (order === 'list first') changes.reverse()
    await repairSourceQuality(document, state, async () => body(changes), () => {}, signal())
    assert.equal(state.story!.summary, '林舟履约。沈月归还信物。')
    assert.deepEqual(state.story!.timeline, [{ summary: '林舟依约行事', section_ids: [0] }])
    assert.deepEqual(state.sections, original.sections); assert.equal(sourceQualityRepairProgress(state), 1)
  })
})

test('missing repeated overlapping and normalized-only matches cannot select a span', async t => {
  for (const item of [
    { name: 'missing', summary: '林舟守约', expected: '没有此处', value: '新表述', pattern: /不精确匹配/ },
    { name: 'repeated', summary: '林舟守约，林舟守约', expected: '林舟守约', value: '林舟履约', pattern: /唯一匹配/ },
    { name: 'overlapping', summary: 'aaa', expected: 'aa', value: 'bb', pattern: /唯一匹配/ },
    { name: 'no normalization', summary: '林舟 e\u0301 守约', expected: 'é', value: '新的', pattern: /不精确匹配/ },
    { name: 'no trim', summary: '林舟守约', expected: ' 林舟 ', value: '林舟', pattern: /不精确匹配/ },
  ]) await t.test(item.name, async () => {
    const state = stateFor(item.summary); await expectRejected(state, [span(state, item.expected, item.value)], item.pattern)
  })
})

test('invalid baseline hashes blank old spans no-op empty final and oversized final summaries reject', async t => {
  for (const name of ['wrong hash', 'empty expected', 'blank expected', 'no-op', 'empty result', 'oversized result'] as const) await t.test(name, async () => {
    const state = stateFor()
    const change = span(state, '守约', '履约')
    if (name === 'wrong hash') change.baseline_hash = '0'.repeat(64)
    if (name === 'empty expected') change.expected = ''
    if (name === 'blank expected') change.expected = '\t\r\n '
    if (name === 'no-op') change.value = change.expected
    if (name === 'empty result') { change.expected = state.story!.summary; change.value = '' }
    if (name === 'oversized result') change.value = '补'.repeat(6000)
    await expectRejected(state, [change])
  })
})

test('span deletion may leave a nonempty valid summary without normalization', async () => {
  const state = stateFor()
  await repairSourceQuality(document, state, async () => body([span(state, '林舟守约。', '')]), () => {}, signal())
  assert.equal(state.story!.summary, '沈月归还信物。'); assert.equal(sourceQualityRepairProgress(state), 1)
})

test('all UTF-16 inputs reject unpaired surrogates and split-emoji attempts', async t => {
  for (const place of ['baseline', 'expected high', 'expected low', 'value high', 'value low'] as const) await t.test(place, async () => {
    const state = stateFor(place === 'baseline' ? '林舟\ud800守约' : '林舟😀守约')
    const change = span(state, '守约', '履约')
    if (place === 'expected high') change.expected = '\ud83d'
    if (place === 'expected low') change.expected = '\ude00'
    if (place === 'value high') change.value = '\ud800'
    if (place === 'value low') change.value = '\udfff'
    await expectRejected(state, [change], /UTF-16|Unicode代理对/)
  })
})

test('span edits cannot depend on the old summary schema silently trimming requested bytes', async t => {
  for (const edge of ['leading', 'trailing']) await t.test(edge, async () => {
    const state = stateFor()
    const change = edge === 'leading' ? span(state, '林舟', ' 林舟') : span(state, '信物。', '信物。 ')
    await expectRejected(state, [change], /修剪或归一化/)
  })
})

test('two spans or mixed span and whole summary replacement reject atomically in either order', async t => {
  for (const mode of ['two spans', 'span then whole', 'whole then span']) await t.test(mode, async () => {
    const state = stateFor()
    const first = span(state, '守约', '履约')
    const other = mode === 'two spans' ? span(state, '信物', '旧信物') : { target: 'story.summary', section_id: null,
      operation: 'replace', index: null, expected: state.story!.summary, value: '林舟依约行事。沈月归还信物。' }
    const changes = mode === 'whole then span' ? [other, first] : [first, other]
    await expectRejected(state, changes, /只能有一个摘要片段修补/)
  })
})

test('existing whole-only sequential summary replacements remain compatible', async () => {
  const state = stateFor(), next = '林舟履约。沈月归还信物。', final = '林舟履约。沈月归还旧信物。'
  await repairSourceQuality(document, state, async () => body([
    { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: state.story!.summary, value: next },
    { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: next, value: final },
  ]), () => {}, signal())
  assert.equal(state.story!.summary, final); assert.equal(sourceQualityRepairProgress(state), 1)
})

test('an otherwise valid span rolls back with later invalid list edits or source evidence', async t => {
  for (const kind of ['stale expected', 'unknown section', 'unsupported evidence']) await t.test(kind, async () => {
    const state = stateFor()
    const invalid = kind === 'unsupported evidence'
      ? { target: 'section.characters', section_id: 0, operation: 'append', index: null, expected: null,
        value: { name: '林舟', description: '守约的人', evidence: { unit_id: 999 } } }
      : { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
        expected: kind === 'stale expected' ? { summary: '并非当前原值', section_ids: [0] } : state.story!.timeline[0],
        value: { summary: '林舟依约行事', section_ids: kind === 'unknown section' ? [999] : [0] } }
    await expectRejected(state, [span(state, '守约', '履约'), invalid])
  })
})

test('concurrent story or review-feedback drift cannot commit a span even when its old phrase still exists', async t => {
  for (const kind of ['story', 'feedback']) await t.test(kind, async () => {
    const state = stateFor(), original = structuredClone(state), change = span(state, '守约', '履约')
    await assert.rejects(repairSourceQuality(document, state, async () => {
      if (kind === 'story') state.story!.summary += '外部新增事实。'
      else state.review_feedback = { id: 'external-feedback', text: '新反馈', source_version: state.source_version,
        source_updated_at: 'changed', model_id: state.model_id, configuration_hash: 'new-config' }
      return body([change])
    }, () => {}, signal()), /修补期间发生变化/)
    assert.equal(state.quality_repair!.completed_findings, 0); assert.deepEqual(state.sections, original.sections)
    assert.equal(state.story!.summary, original.story!.summary + (kind === 'story' ? '外部新增事实。' : ''))
    if (kind === 'feedback') assert.equal(state.review_feedback!.id, 'external-feedback')
  })
})

test('resume after a known unsent request retains a committed span and supplies a fresh baseline hash only for the unfinished finding', async () => {
  const state = stateFor(undefined, 2), hashes: string[] = [], findings: number[] = []
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    const data = input(prompt); findings.push(data.finding_index); hashes.push(data.baseline_hash)
    if (data.finding_index === 1) throw Object.assign(new Error('fixture transport ended'), { delivery: 'not_sent' })
    return body([span(state, '守约', '履约')])
  }, () => {}, signal()), /fixture transport ended/)
  assert.equal(sourceQualityRepairProgress(state), 1)
  assert.notEqual(hashes[0], hashes[1]); assert.equal(hashes[1], sourceQualityInputHash(state))
  await repairSourceQuality(document, state, async prompt => {
    const data = input(prompt); findings.push(data.finding_index)
    assert.equal(data.baseline_hash, hashes[1]); assert.equal(data.story.summary, '林舟履约。沈月归还信物。')
    return body([span(state, '归还信物', '归还旧信物')])
  }, () => {}, signal())
  assert.deepEqual(findings, [0, 1, 1]); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.equal(state.story!.summary, '林舟履约。沈月归还旧信物。'); assert.equal(state.quality!.status, 'issues')
})

test('a late cancelled span response cannot commit any candidate edits', async () => {
  const state = stateFor(), original = structuredClone(state), controller = new AbortController()
  await assert.rejects(repairSourceQuality(document, state, async () => {
    controller.abort(new Error('fixture cancelled')); return body([span(state, '守约', '履约')])
  }, () => {}, controller.signal), /fixture cancelled/)
  assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
  assert.equal(state.quality_repair!.completed_findings, 0)
})

test('guard diagnostics identify fixed targets and expected value index or span paths without echoing text', async t => {
  for (const kind of ['whole copied wrong and no-op', 'whole no-op', 'list expected', 'list index', 'list no-op', 'span baseline', 'span expected', 'span value'] as const) await t.test(kind, async () => {
    const state = stateFor('原值SECRET需要保留。'), original = structuredClone(state)
    let change: unknown
    let path: string
    if (kind === 'whole copied wrong and no-op') {
      change = { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: '错误SECRET复制', value: '错误SECRET复制' }; path = 'expected'
    } else if (kind === 'whole no-op') {
      change = { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: state.story!.summary, value: state.story!.summary }; path = 'value'
    } else if (kind.startsWith('list')) {
      change = { target: 'story.timeline', section_id: null, operation: 'replace', index: kind === 'list index' ? 99 : 0,
        expected: kind === 'list expected' ? { summary: '错误SECRET复制', section_ids: [0] } : state.story!.timeline[0],
        value: kind === 'list no-op' ? state.story!.timeline[0] : { summary: '林舟依约行事', section_ids: [0] } }
      path = kind === 'list index' ? 'index' : kind === 'list expected' ? 'expected' : 'value'
    } else {
      change = { ...span(state, kind === 'span expected' ? '不在摘要SECRET' : '需要保留', kind === 'span value' ? '\ud800' : '继续保留'),
        ...(kind === 'span baseline' ? { baseline_hash: '0'.repeat(64) } : {}) }
      path = kind === 'span baseline' ? 'baseline_hash' : kind === 'span expected' ? 'expected' : 'value'
    }
    await assert.rejects(repairSourceQuality(document, state, async (prompt, contract) => rejectedBody([change], prompt, contract?.name), () => {}, signal()), error => {
      const message = (error as Error).message
      assert.ok(message.includes(`changes[0].${path}`)); assert.match(message, /target=story\.(summary|timeline)/)
      if (kind === 'whole copied wrong and no-op') { assert.match(message, /changes\[0\]\.value/); assert.match(message, /与expected相同/) }
      assert.doesNotMatch(message, /原值SECRET|错误SECRET|不在摘要SECRET/)
      return true
    })
    assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
    assert.equal(state.quality_repair!.completed_findings, 0)
  })
})
