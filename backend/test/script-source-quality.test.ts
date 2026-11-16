import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-quality-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceIndex } = await import('../src/modules/script/script-source-documents.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const marker = '【原稿分析核对资料】\n'
const signal = () => new AbortController().signal
function stateFor(content: string): ScriptSourceAnalysis {
  const end = content.lastIndexOf('尾声'), boundaries = end > 0 ? [0, end] : [0]
  return { id: 'quality-fixture', source_version: 'source-v1', model_id: 'text', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    error: null, updated_at: 'now', sections: boundaries.map((offset, id) => ({ offset, length: (boundaries[id + 1] ?? content.length) - offset,
      title: `章${id}`, episode_number: null, summary: id ? '尾声归还信物' : '开场约定', characters: [], events: [] })),
    story: { summary: '人物完成约定。', characters: [], timeline: [], threads: [], ending: { summary: '信物归还。', section_ids: [boundaries.length - 1] }, uncertainties: [] } }
}
const reviewed = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
  complete_source: boolean; units: Array<{ id: number; text: string }>; sections: Array<{ id: number; title: string }>; story: unknown
}

test('independent review receives every source character through the final evidence and accepts exactly all section IDs in any order', async () => {
  const content = `开场约定。\n${'中部事件保持因果。\n'.repeat(1400)}\n尾声：沈月归还唯一信物，😀结局完成。\n`, state = stateFor(content)
  let calls = 0, saves = 0
  await reviewSourceQuality({ filename: '完整剧本.txt', content }, state, async prompt => {
    calls++; const input = reviewed(prompt)
    assert.equal(input.complete_source, true)
    assert.equal(input.units.map(unit => unit.text).join(''), content)
    assert.match(input.units.at(-1)!.text, /沈月归还唯一信物.*结局完成/)
    assert.deepEqual(input.sections.map(section => section.id), [0, 1])
    assert.deepEqual(input.story, state.story)
    return JSON.stringify({ checked_section_ids: [1, 0], findings: [] })
  }, () => { saves++ }, signal())
  assert.equal(calls, 1); assert.equal(saves, 1)
  assert.equal(state.quality?.status, 'passed')
  assert.equal(state.quality?.input_hash, sourceQualityInputHash(state))
})

test('source review asks for Chinese explanations without translating original English names or evidence IDs', async () => {
  const content = '开场 John 使用口令 “world”。尾声 John 归还信物。', state = stateFor(content)
  const finding = { kind: 'unsupported', explanation: '人物资料误读了 John 使用口令的目的。', unit_ids: [0] }
  let calls = 0
  await assert.rejects(reviewSourceQuality({ filename: '剧本.txt', content }, state, async prompt => {
    calls++
    const input = reviewed(prompt)
    assert.match(prompt, /explanation 使用简体中文/)
    assert.match(prompt, /中文栏目名说明问题/)
    assert.match(prompt, /证据内容保持原值，不翻译或改写/)
    assert.equal(input.units.map(unit => unit.text).join(''), content)
    assert.ok(input.units.some(unit => unit.id === finding.unit_ids[0] && unit.text.includes('John')))
    return JSON.stringify({ checked_section_ids: [0, 1], findings: [finding] })
  }, () => {}, signal()), /人物资料误读了 John 使用口令的目的/)
  assert.equal(calls, 1)
  assert.deepEqual(state.quality?.findings, [finding], 'language guidance preserves the structured evidence and stored explanation')
})

test('coverage IDs cannot omit, duplicate or invent sections even when the remaining response is valid', async t => {
  for (const checked of [[0], [0, 0, 1], [0, 1, 999]]) await t.test(JSON.stringify(checked), async () => {
    const content = '开场约定。尾声归还信物。', state = stateFor(content)
    let calls = 0, saves = 0
    await assert.rejects(reviewSourceQuality({ filename: '剧本.txt', content }, state, async () => {
      calls++; return JSON.stringify({ checked_section_ids: checked, findings: [] })
    }, () => { saves++ }, signal()), /覆盖全部真实章节/)
    assert.equal(calls, 2, 'one bounded correction cannot publish invalid coverage')
    assert.equal(saves, 0); assert.equal(state.quality, undefined)
  })
})

test('findings reject nonexistent, whitespace-only and repeated evidence IDs before becoming durable issues', async t => {
  const content = '开场约定。\n \t\n尾声归还信物。'
  const units = scriptSourcePassages(content).flatMap(passage => passage.units)
  const blank = units.find(unit => !unit.text.trim())!, real = units.find(unit => unit.text.includes('尾声'))!
  assert.ok(blank); assert.ok(real)
  for (const evidence of [[999999], [blank.id], [real.id, real.id]]) await t.test(JSON.stringify(evidence), async () => {
    const state = stateFor(content); let calls = 0, saves = 0
    await assert.rejects(reviewSourceQuality({ filename: '剧本.txt', content }, state, async () => {
      calls++; return JSON.stringify({ checked_section_ids: [0, 1], findings: [{ kind: 'omission', explanation: '遗漏结局', unit_ids: evidence }] })
    }, () => { saves++ }, signal()), /真实且非空的原文句段/)
    assert.equal(calls, 2); assert.equal(saves, 0); assert.equal(state.quality, undefined)
  })
})

test('quality issue messages preserve sentence endings and add punctuation only when missing', async t => {
  const cases = [
    ['遗漏责任轻重的判断', '遗漏责任轻重的判断。'],
    ['遗漏责任轻重的判断。', '遗漏责任轻重的判断。'],
    ['遗漏责任轻重的判断！', '遗漏责任轻重的判断！'],
    ['遗漏责任轻重的判断？', '遗漏责任轻重的判断？'],
    ['Missing the cause.', 'Missing the cause.'],
    ['Missing the cause!', 'Missing the cause!'],
    ['Missing the cause?', 'Missing the cause?'],
    ['遗漏了“责任轻重的判断。”', '遗漏了“责任轻重的判断。”'],
    ['遗漏了「责任轻重的判断！」', '遗漏了「责任轻重的判断！」'],
    ['遗漏了（责任轻重的判断。）', '遗漏了（责任轻重的判断。）'],
    ['Missing the "cause?"', 'Missing the "cause?"'],
    ['遗漏了“责任轻重的判断”', '遗漏了“责任轻重的判断”。'],
  ] as const
  for (const [explanation, completedSentence] of cases) await t.test(explanation, async () => {
    const content = '开场约定。尾声归还信物。', state = stateFor(content)
    const finding = { kind: 'omission', explanation, unit_ids: [0] }
    let saves = 0
    await assert.rejects(reviewSourceQuality({ filename: '剧本.txt', content }, state, async () =>
      JSON.stringify({ checked_section_ids: [0, 1], findings: [finding] }), () => { saves++ }, signal()), error => {
      assert.equal((error as Error).message,
        `剧本资料核对发现 1 项遗漏或误读：${completedSentence}可继续修补这些问题并重新核对，原稿和已完成分析已保留。`)
      assert.equal((error as Error & { statusCode: number }).statusCode, 422)
      return true
    })
    assert.equal(saves, 1)
    assert.deepEqual(state.quality?.findings, [finding], 'display punctuation does not alter the stored finding')
  })
})

test('passed reviews reuse only unchanged source/map/story hashes while transient progress does not invalidate them', async () => {
  const content = '开场约定。尾声归还信物。', state = stateFor(content)
  let calls = 0, saves = 0
  const generate = async () => { calls++; return JSON.stringify({ checked_section_ids: [0, 1], findings: [] }) }
  const review = () => reviewSourceQuality({ filename: '剧本.txt', content }, state, generate, () => { saves++ }, signal())
  await review(); const first = state.quality!.input_hash
  state.updated_at = 'later'; state.progress = { stage: 'validating', message: '复核进度更新' }
  await review(); assert.equal(calls, 1); assert.equal(sourceQualityInputHash(state), first)
  state.source_version = 'source-v2'; await review(); assert.equal(calls, 2)
  assert.notEqual(state.quality!.input_hash, first)
  state.sections[1]!.summary = '修正尾声身份与归还原因'; await review(); assert.equal(calls, 3)
  state.story!.summary = '修正全剧因果'; await review(); assert.equal(calls, 4)
  assert.equal(saves, 4)
  state.quality!.status = 'issues'
  state.quality!.findings = [{ kind: 'causality', explanation: '尚有因果问题', unit_ids: [0] }]
  await review(); assert.equal(calls, 5, 'issues cannot use the passed-result cache')
  assert.equal(state.quality!.status, 'passed'); assert.deepEqual(state.quality!.findings, [])
})

async function terminal(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(id)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('analysis did not finish')
}

test('ordinary source analysis does not automatically invoke the explicit quality-review or repair tools', async () => {
  const content = '开场林舟许下约定。\n尾声沈月归还信物。', stamp = now(), projectId = newId()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '无审核门槛', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', projectId, '剧本.txt', content, stamp)
  const prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt); assert.doesNotMatch(prompt, /【原稿分析核对资料】|【原稿分析定点修补资料】/)
    return sourceAnalysisFixture(prompt)!
  })
  try {
    analyzer.start(projectId, 'model'); const ready = await terminal(projectId)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(ready.quality, undefined)
    assert.equal(prompts.length, 2); assert.ok(scriptSourceIndex(projectId)!.story_map?.length)
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(projectId)!.content, content)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(projectId)!.count, 0)
  } finally { await analyzer.close() }
})
