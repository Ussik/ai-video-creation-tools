import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { sourceQualityInputHash, reviewSourceQuality } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'quality-disposition-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
initDb(); assert.ok(db.name.startsWith(testData))
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const content = '开场：林舟已在门前守约。\n尾声：信物已被归还。\n', source = { filename: '合成核对意见.txt', content }
const units = scriptSourcePassages(content).flatMap(passage => passage.units), unit = units.find(unit => unit.text.includes('信物'))!.id
const marker = '【原稿分析定点修补资料】\n', reviewMarker = '【原稿分析核对资料】\n'
const signal = () => new AbortController().signal
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const retainReason = '全剧概要已记载归还信物；对应原文“信物已被归还”，无需跨栏目重复。'
const retained = (state: ScriptSourceAnalysis, reason = retainReason) => ({ decision: 'retain_analysis', finding_hash: createHash('sha256').update(JSON.stringify(state.quality!.findings[Math.min(state.quality_repair?.completed_findings || 0, state.quality!.findings.length - 1)])).digest('hex'), reason, analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: unit }], changes: [] })
function fixture(count = 1): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'quality-withdrawal', source_version: 'synthetic', model_id: 'model', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now', sections: [{ offset: 0, length: content.length,
      title: '全部资料', episode_number: null, summary: '人物履行约定。', characters: [], events: [], open_threads: [] }],
    story: { summary: '林舟守约，尾声信物已归还。', characters: [], timeline: [], threads: [],
      ending: { summary: '信物归还。', section_ids: [0] }, uncertainties: [{ description: '原文未交代信物由何人制作，身份保持未知。', section_ids: [0] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: Array.from({ length: count }, (_, id) => ({
    kind: 'omission', explanation: `要求在指定栏目重复记载归还信物（${id}）。`, unit_ids: [unit],
  })) }
  return state
}

test('retain advances one bound finding without modifying analysis or falsely passing quality and retains its audit evidence', async () => {
  const state = fixture(), before = structuredClone(state), hash = sourceQualityInputHash(state)
  let calls = 0
  await repairSourceQuality(source, state, async prompt => {
    calls++
    assert.match(prompt, /不使用含糊的status\/withdrawn/)
    assert.match(prompt, /只是待独立复核的保留决定/)
    assert.deepEqual(input(prompt).finding, before.quality!.findings[0])
    return JSON.stringify(retained(state))
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(sourceQualityInputHash(state), hash)
  assert.deepEqual(state.sections, before.sections); assert.deepEqual(state.story, before.story); assert.deepEqual(state.quality, before.quality)
  assert.equal(state.quality!.status, 'issues')
  const disposition = state.quality_repair!.decisions![0]!
  assert.equal(disposition.finding_index, 0)
  assert.equal(disposition.finding_hash, createHash('sha256').update(JSON.stringify(before.quality!.findings[0])).digest('hex'))
  assert.equal(disposition.before_hash, hash); assert.equal(disposition.after_hash, hash); assert.deepEqual(disposition.source_refs.map(ref => ref.unit_id), [unit]); assert.ok(disposition.reason)
  await repairSourceQuality(source, structuredClone(state), async () => { throw new Error('withdrawn finding must not repeat after restart') }, () => {}, signal())
  const changed = structuredClone(state); changed.quality!.findings[0]!.explanation += 'different finding'
  assert.equal(sourceQualityRepairProgress(changed), null)
})

test('a retained finding survives next-finding failure and legacy patched replies preserve the audit record on continuation', async () => {
  const state = fixture(2), requests: number[] = []
  await assert.rejects(repairSourceQuality(source, state, async prompt => {
    const index = input(prompt).finding_index; requests.push(index)
    if (index === 1) throw Object.assign(new Error('next finding disconnected'), { delivery: 'not_sent' })
    return JSON.stringify(retained(state))
  }, () => {}, signal()), /next finding disconnected/)
  const saved = structuredClone(state), audit = structuredClone(saved.quality_repair!.decisions)
  assert.equal(sourceQualityRepairProgress(saved), 1)
  await repairSourceQuality(source, saved, async prompt => {
    const body = input(prompt); requests.push(body.finding_index)
    // Old patched envelope has no new unit_ids property and remains valid.
    return JSON.stringify({ status: 'patched', reason: '依据原文补充一处明确表述', changes: [{ target: 'story.summary', section_id: null,
      operation: 'replace', index: null, expected: body.story.summary, value: body.story.summary + ' 原文明确约定已经履行。' }] })
  }, () => {}, signal())
  assert.deepEqual(requests, [0, 1, 1]); assert.equal(sourceQualityRepairProgress(saved), 2)
  assert.deepEqual(saved.quality_repair!.decisions!.slice(0, 1), audit)
  assert.deepEqual(saved.story!.uncertainties, state.story!.uncertainties)
})

test('retain rejects missing or invalid evidence, empty reason and any accompanying mutation', async t => {
  const blank = scriptSourcePassages(content + '\n \t\n').flatMap(passage => passage.units).find(unit => !unit.text.trim())?.id
  const cases = [
    { label: 'missing evidence', value: { ...retained(fixture()), source_refs: undefined } },
    { label: 'empty evidence', value: { ...retained(fixture()), source_refs: [] } },
    { label: 'unknown evidence', value: { ...retained(fixture()), source_refs: [{ unit_id: 99999 }] } },
    { label: 'duplicate evidence', value: { ...retained(fixture()), source_refs: [{ unit_id: unit }, { unit_id: unit }] } },
    { label: 'empty reason', value: retained(fixture(), '   ') },
    { label: 'hidden edits', value: { ...retained(fixture()), changes: [{ target: 'story.summary', section_id: null, operation: 'replace', index: null,
      expected: fixture().story!.summary, value: '不允许夹带的改写' }] } },
    ...(blank === undefined ? [] : [{ label: 'blank or out-of-range evidence', value: { ...retained(fixture()), source_refs: [{ unit_id: blank }] } }]),
  ]
  for (const { label, value } of cases) await t.test(label, async () => {
    const state = fixture(), before = structuredClone(state)
    await assert.rejects(repairSourceQuality(source, state, async () => JSON.stringify(value), () => {}, signal()))
    assert.deepEqual(state.sections, before.sections); assert.deepEqual(state.story, before.story); assert.deepEqual(state.quality, before.quality)
    assert.equal(sourceQualityRepairProgress(state), 0); assert.equal(state.quality_repair!.withdrawals, undefined)
  })
})

test('cancellation and concurrent baseline changes cannot commit a retained finding', async t => {
  for (const mode of ['cancel', 'changed'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone(state.story), controller = new AbortController()
    await assert.rejects(repairSourceQuality(source, state, async () => {
      if (mode === 'cancel') controller.abort(new Error('paused'))
      else state.story!.summary += ' concurrently changed'
      return JSON.stringify(retained(state))
    }, () => {}, controller.signal), mode === 'cancel' ? /paused/ : /发生变化/)
    assert.equal(state.quality_repair!.completed_findings, 0); assert.equal(state.quality_repair!.withdrawals, undefined)
    if (mode === 'cancel') assert.deepEqual(state.story, original)
  })
})

test('retained-only repair makes a distinct full-review request through the real exact-request ledger and never regenerates completed analysis', async () => {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '诚实撤销集成', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, source.filename, content, stamp)
  const calls: string[] = [], reviewPrompts: string[] = []
  let reviews = 0, observed: ScriptSourceAnalysis | undefined, provisional: ScriptSourceAnalysis | undefined
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, contract) => {
    calls.push(contract!.name)
    if (prompt.includes(marker)) {
      const body = input(prompt)
      assert.equal(body.finding_index, 0)
      observed = scriptSourceAnalysis(id)!
      return JSON.stringify(retained(observed!))
    }
    if (prompt.includes(reviewMarker)) {
      reviewPrompts.push(prompt)
      const body = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
      if (++reviews === 1) {
        assert.equal(body.previous_review_notes, undefined)
        assert.equal(body.post_repair_audit_context, undefined)
        return JSON.stringify({ checked_section_ids: body.sections.map((section: { id: number }) => section.id), findings: [
          { kind: 'omission', explanation: '重复要求已经保留的事实。', unit_ids: [unit] },
        ] })
      }
      provisional = scriptSourceAnalysis(id)!
      assert.equal(provisional!.quality!.status, 'issues')
      assert.equal(provisional!.quality_repair!.completed_findings, 1)
      assert.equal(provisional!.quality_repair!.decisions!.length, 1)
      assert.deepEqual(provisional!.story, observed!.story)
      const notes = provisional!.quality_repair!.decisions
      const reviewHash = createHash('sha256').update(JSON.stringify([sourceQualityInputHash(provisional!), 'source-quality-decisions-v1', notes])).digest('hex')
      assert.equal(body.previous_review_notes, undefined)
      assert.deepEqual(body.post_repair_audit_context, { kind: 'independent_current_analysis', context_hash: reviewHash, analysis_is_current: true })
      assert.ok(!prompt.includes(observed!.quality!.findings[0]!.explanation))
      assert.ok(!prompt.includes(retainReason))
      assert.match(prompt, /不依据流程状态推断字段应被改写或删除/)
      return JSON.stringify({ checked_section_ids: body.sections.map((section: { id: number }) => section.id), findings: [] })
    }
    return sourceAnalysisFixture(prompt)!
  })
  try {
    analyzer.start(id, 'model')
    let ready: ScriptSourceAnalysis | undefined
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = scriptSourceAnalysis(id)!
      if (['ready', 'failed'].includes(current.status)) { ready = current; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(ready, 'the actual analyzer must complete rather than replaying the original finding forever')
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.quality!.status, 'passed'); assert.equal(reviews, 2)
    assert.deepEqual(ready.sections, observed!.sections); assert.deepEqual(ready.story, observed!.story)
    assert.deepEqual(calls, ['script_source_map', 'script_source_story', 'script_source_quality', 'script_source_quality_repair', 'script_source_quality'])
    assert.notEqual(reviewPrompts[0], reviewPrompts[1])
    const records = db.prepare("SELECT request_key,result FROM source_model_requests WHERE project_id=? AND state='completed'").all(id) as Array<{ request_key: string; result: string }>
    const reviewRecords = records.filter(row => { try { return 'checked_section_ids' in JSON.parse(row.result) } catch { return false } })
    assert.equal(reviewRecords.length, 2, 'both independent-review results are actually persisted under distinct exact identities')
    assert.equal(new Set(reviewRecords.map(row => row.request_key)).size, 2)
    assert.ok(reviewRecords.some(row => JSON.parse(row.result).findings.length === 1))
    assert.ok(reviewRecords.some(row => JSON.parse(row.result).findings.length === 0))
    assert.equal(provisional!.quality!.findings.length, 1, 'original review remains unchanged until the separate recheck completes')
    assert.equal(ready.quality_repair, undefined)
  } finally { await analyzer.close() }
})

test('partial or mismatched decision checkpoints cannot supply post-repair audit context', async t => {
  const repaired = fixture()
  await repairSourceQuality(source, repaired, async () => JSON.stringify(retained(repaired)), () => {}, signal())
  const cases: Array<{ label: string; change: (state: ScriptSourceAnalysis) => void }> = [
    { label: 'incomplete repair', change: state => { state.quality_repair!.completed_findings = 0 } },
    { label: 'different review', change: state => { state.quality_repair!.review_hash = 'stale-review' } },
    { label: 'different findings', change: state => { state.quality_repair!.findings_hash = 'stale-findings' } },
    { label: 'different analysis', change: state => { state.quality_repair!.current_hash = 'stale-analysis' } },
    { label: 'different finding evidence', change: state => { state.quality_repair!.decisions![0]!.finding_hash = 'stale-finding' } },
    { label: 'invalid source evidence', change: state => { state.quality_repair!.decisions![0]!.source_refs = [{ unit_id: 99999, text_hash: 'f'.repeat(64) }] } },
    { label: 'duplicate finding dispositions', change: state => { state.quality_repair!.decisions!.push(structuredClone(state.quality_repair!.decisions![0]!)) } },
    { label: 'invalid audit baseline', change: state => { state.quality_repair!.decisions![0]!.before_hash = 'missing-baseline' } },
  ]
  for (const entry of cases) await t.test(entry.label, async () => {
    const state = structuredClone(repaired); entry.change(state)
    await reviewSourceQuality(source, state, async prompt => {
      const body = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
      assert.equal(body.previous_review_notes, undefined)
      assert.equal(body.post_repair_audit_context, undefined)
      assert.doesNotMatch(prompt, /previous_review_notes/)
      assert.ok(!prompt.includes(retainReason))
      return JSON.stringify({ checked_section_ids: [0], findings: [] })
    }, () => {}, signal())
  })
})

test('review pages retain private decision identity and expose only program-owned independent context', async () => {
  const state = fixture()
  await repairSourceQuality(source, state, async () => JSON.stringify(retained(state)), () => {}, signal())
  const originalHash = sourceQualityInputHash(state)
  const notes = state.quality_repair!.decisions
  const reviewHash = createHash('sha256').update(JSON.stringify([originalHash, 'source-quality-decisions-v1', notes])).digest('hex')
  state.quality_work = { input_hash: originalHash, checkpoint: { steps: { 'source-quality:pages': { input_hash: 'old-audit', value: { items: [], complete: true } } } } }
  const started: string[] = []
  await assert.rejects(reviewSourceQuality(source, state, async (prompt, contract) => {
    started.push(contract!.name)
    const body = JSON.parse(prompt.split('\n【核对输出分页】')[0]!.slice(prompt.indexOf(reviewMarker) + reviewMarker.length))
    assert.equal(body.previous_review_notes, undefined)
    assert.deepEqual(body.post_repair_audit_context, { kind: 'independent_current_analysis', context_hash: reviewHash, analysis_is_current: true })
    assert.ok(!prompt.includes(retainReason))
    if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('{"findings":[', 'length')
    throw new Error('notes audit page disconnected')
  }, () => {}, signal()), /notes audit page disconnected/)
  assert.deepEqual(started, ['script_source_quality', 'script_source_quality_page'])
  assert.equal(state.quality_work!.input_hash, reviewHash, 'the unchanged private hash formula still excludes first-review pages')
  const resumed: string[] = []
  await reviewSourceQuality(source, structuredClone(state), async (prompt, contract) => {
    resumed.push(contract!.name)
    const body = JSON.parse(prompt.split('\n【核对输出分页】')[0]!.slice(prompt.indexOf(reviewMarker) + reviewMarker.length))
    assert.equal(body.previous_review_notes, undefined)
    assert.deepEqual(body.post_repair_audit_context, { kind: 'independent_current_analysis', context_hash: reviewHash, analysis_is_current: true })
    assert.ok(!prompt.includes(retainReason))
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true })
  }, () => {}, signal())
  assert.deepEqual(resumed, ['script_source_quality_page'])
})
