import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages, sourceWorkPlan } from '../src/modules/script/script-source-map.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-quality-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
assert.ok(db.name.startsWith(testData), 'quality recovery tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const mapMarker = '【原文片段】\n', storyMarker = '【全剧整合资料】\n'
const reviewMarker = '【原稿分析核对资料】\n', repairMarker = '【原稿分析定点修补资料】\n'
type Unit = { id: number; text: string }
type RepairInput = { complete_source: boolean; units: Unit[]; story: ScriptSourceStory; finding: { explanation: string }; finding_index: number }
const inputFor = <T>(prompt: string, marker: string): T => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const signal = () => new AbortController().signal
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const limits = { reading: 1000, repairing: 1000, synthesis: 1000 }
const facts = ['杜铮被细线控制手腕，不能据此断言他自愿施法。', '尾声仍亮着真正的神牌，人们自愿向灯火下跪。']

function document(label: string): ScriptSourceDocument {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, label, stamp, stamp)
  return { project_id: id, filename: `${label}.txt`, content: `第十七集\n${facts[0]}\n第五十五集\n${facts[1]}\n`, updated_at: stamp }
}
function installSource(source: ScriptSourceDocument) {
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', source.project_id, source.filename, source.content, source.updated_at)
}
function checkpoint(projectId: string): ScriptSourceAnalysis {
  const row = db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal'").get(projectId) as { payload: string }
  return JSON.parse(row.payload)
}
function reviewReply(prompt: string, issues: boolean) {
  const input = inputFor<{ units: Unit[]; sections: Array<{ id: number }> }>(prompt, reviewMarker)
  return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: issues ? facts.map((fact, index) => ({
    kind: index ? 'omission' : 'causality', explanation: fact,
    unit_ids: [input.units.find(unit => unit.text.includes(fact))!.id],
  })) : [] })
}
function repairReply(prompt: string, suffix?: string) {
  const input = inputFor<RepairInput>(prompt, repairMarker)
  return JSON.stringify({ status: 'patched', reason: '将原文中的事实补入全剧理解。', changes: [{ target: 'story.summary', section_id: null,
    operation: 'replace', index: null, expected: input.story.summary, value: `${input.story.summary}；${suffix || input.finding.explanation}` }] })
}
async function terminal(projectId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = scriptSourceAnalysis(projectId)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await tick()
  }
  throw new Error('quality recovery analysis did not finish')
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('private quality repair saves each finding, resumes the interrupted finding, and retries only the final review after its transport failure', async () => {
  const source = document('逐问题修补恢复'), repaired: number[] = []
  let maps = 0, stories = 0, reviews = 0, failSecondRepair = true, failFinalReview = true
  const generate = async (prompt: string) => {
    if (prompt.includes(repairMarker)) {
      const input = inputFor<RepairInput>(prompt, repairMarker)
      assert.equal(input.complete_source, true)
      assert.equal(input.units.map(unit => unit.text).join(''), source.content)
      repaired.push(input.finding_index)
      if (input.finding_index === 1 && failSecondRepair) throw new Error('第二项修补连接中断')
      return repairReply(prompt)
    }
    if (prompt.includes(reviewMarker)) {
      reviews++
      if (reviews === 2 && failFinalReview) throw new Error('修补后的全文复核连接中断')
      return reviewReply(prompt, reviews === 1)
    }
    if (prompt.includes(mapMarker)) maps++
    if (prompt.includes(storyMarker)) stories++
    return sourceAnalysisFixture(prompt)!
  }
  await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /核对发现 2 项遗漏或误读/)
  const baseline = checkpoint(source.project_id)
  await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /第二项修补连接中断/)
  const interrupted = checkpoint(source.project_id)
  assert.equal(interrupted.quality_repair!.completed_findings, 1)
  assert.deepEqual(interrupted.sections, baseline.sections)
  assert.ok(interrupted.story!.summary.includes(facts[0]!))
  assert.equal(interrupted.story!.summary.includes(facts[1]!), false)
  assert.equal(reviews, 1, 'an unfinished finding repair cannot enter the final independent review')

  failSecondRepair = false
  await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /修补后的全文复核连接中断/)
  const awaitingReview = checkpoint(source.project_id)
  assert.equal(awaitingReview.quality_repair!.completed_findings, 2)
  assert.ok(awaitingReview.story!.summary.includes(facts[1]!))
  failFinalReview = false
  const ready = await analyzeSourceSnapshot(source, 'model', generate, signal())
  assert.equal(ready.status, 'ready'); assert.equal(ready.quality!.status, 'passed')
  assert.equal(ready.quality_repair, undefined)
  assert.deepEqual(ready.sections, baseline.sections)
  assert.deepEqual(ready.story, awaitingReview.story)
  assert.deepEqual(repaired, [0, 1, 1], 'the first completed finding is never regenerated')
  assert.deepEqual([maps, stories, reviews], [1, 1, 3], 'no directory or story synthesis is repeated during repair or review recovery')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_documents WHERE project_id=?').get(source.project_id)!.count, 0)
})

test('a later independent review starts a new finding-repair round without reusing the old completed counter or rebuilding the analysis', async () => {
  const source = document('新一轮核对问题'), repaired: string[] = []
  let maps = 0, stories = 0, reviews = 0
  const generate = async (prompt: string) => {
    if (prompt.includes(repairMarker)) {
      const input = inputFor<RepairInput>(prompt, repairMarker)
      assert.equal(input.finding_index, 0, 'each review begins a new finding index sequence')
      repaired.push(input.finding.explanation)
      return repairReply(prompt)
    }
    if (prompt.includes(reviewMarker)) {
      reviews++
      const input = inputFor<{ units: Unit[]; sections: Array<{ id: number }> }>(prompt, reviewMarker)
      const fact = facts[reviews - 1]
      return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: fact ? [{ kind: 'omission',
        explanation: fact, unit_ids: [input.units.find(unit => unit.text.includes(fact))!.id] }] : [] })
    }
    if (prompt.includes(mapMarker)) maps++
    if (prompt.includes(storyMarker)) stories++
    return sourceAnalysisFixture(prompt)!
  }
  await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /核对发现 1 项遗漏或误读/)
  const initial = checkpoint(source.project_id)
  await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /核对发现 1 项遗漏或误读/)
  const later = checkpoint(source.project_id)
  assert.notEqual(later.quality!.input_hash, initial.quality!.input_hash)
  assert.equal(later.quality_repair, undefined, 'the new review removes the completed counter bound to the old findings')
  assert.deepEqual(later.quality!.findings.map(finding => finding.explanation), [facts[1]])
  assert.ok(later.story!.summary.includes(facts[0]!))
  assert.equal(later.story!.summary.includes(facts[1]!), false)
  const ready = await analyzeSourceSnapshot(source, 'model', generate, signal())
  assert.equal(ready.status, 'ready'); assert.equal(ready.quality!.status, 'passed')
  assert.ok(facts.every(fact => ready.story!.summary.includes(fact)))
  assert.deepEqual(ready.sections, initial.sections)
  assert.deepEqual(repaired, facts)
  assert.deepEqual([maps, stories, reviews], [1, 1, 3])
})

test('an explicitly unsafe targeted repair performs one evidence-guided rebuild and stops if its independent review still finds issues', async t => {
  for (const stillHasIssues of [false, true]) await t.test(stillHasIssues ? 'new_issues_stop' : 'rebuild_passes', async () => {
    const source = document(`不可定点修补-${stillHasIssues}`)
    let maps = 0, stories = 0, repairs = 0, reviews = 0
    const generate = async (prompt: string) => {
      if (prompt.includes(repairMarker)) {
        repairs++
        return JSON.stringify({ status: 'requires_full_rebuild', reason: '误读涉及章节边界，不能安全修改单个分析条目。', changes: [] })
      }
      if (prompt.includes(reviewMarker)) return reviewReply(prompt, ++reviews === 1 || stillHasIssues)
      if (prompt.includes(mapMarker)) {
        maps++
        if (maps === 2) assert.ok(facts.every(fact => prompt.includes(fact)), 'the controlled rebuild retains the quality evidence')
        const value = JSON.parse(sourceAnalysisFixture(prompt)!)
        value.sections[0].summary = `第 ${maps} 次目录：依据原文区分控制与自愿行为。`
        return JSON.stringify(value)
      }
      if (prompt.includes(storyMarker)) stories++
      return sourceAnalysisFixture(prompt)!
    }
    await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /核对发现 2 项遗漏或误读/)
    if (stillHasIssues) {
      await assert.rejects(analyzeSourceSnapshot(source, 'model', generate, signal()), /核对发现 2 项遗漏或误读/)
      assert.equal(checkpoint(source.project_id).quality!.status, 'issues')
    } else {
      const ready = await analyzeSourceSnapshot(source, 'model', generate, signal())
      assert.equal(ready.status, 'ready'); assert.equal(ready.quality!.status, 'passed')
    }
    const saved = checkpoint(source.project_id)
    assert.equal(saved.quality_rebuild_for, undefined)
    assert.equal(saved.quality_repair, undefined)
    assert.deepEqual([maps, stories, repairs, reviews], [2, 2, 1, 2], 'a fallback is bounded to one full rebuild rather than an automatic repair/rebuild loop')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_documents WHERE project_id=?').get(source.project_id)!.count, 0)
  })
})

test('a controlled fallback rebuild interrupted on its second page resumes saved replacement pages without repeating the repair decision', async () => {
  const source = document('受控重建中断续跑')
  source.content += Array.from({ length: 24 }, (_, index) => `第${index + 60}集\n${'人们沿着旧街寻找仍然亮着的灯火。'.repeat(70)}\n`).join('')
  installSource(source)
  const plan = sourceWorkPlan(scriptSourcePassages(source.content)), originalPages: number[] = [], rebuiltPages: number[] = []
  assert.ok(plan.length > 1, 'the real fallback exercises a multi-page replacement directory')
  let repairs = 0, reviews = 0, interruptSecondPage = true
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => {
    if (prompt.includes(repairMarker)) {
      repairs++
      return JSON.stringify({ status: 'requires_full_rebuild', reason: '需要重新区分章节边界与对应事实。', changes: [] })
    }
    if (prompt.includes(reviewMarker)) return reviewReply(prompt, ++reviews === 1)
    if (prompt.includes(mapMarker)) {
      const { output_window: window } = inputFor<{ output_window: { page: number } }>(prompt, mapMarker)
      const pages = repairs ? rebuiltPages : originalPages
      pages.push(window.page)
      if (repairs && window.page === 2 && interruptSecondPage) throw new Error('受控重建第二页连接中断')
      const value = JSON.parse(sourceAnalysisFixture(prompt)!)
      value.sections[0].summary = `${repairs ? '依据核对证据重建' : '初始目录'}第 ${window.page} 页。`
      return JSON.stringify(value)
    }
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(source.project_id, 'model')
    const initial = await terminal(source.project_id)
    assert.equal(initial.status, 'failed'); assert.equal(initial.quality!.status, 'issues')
    analyzer.start(source.project_id, 'model')
    const interrupted = await terminal(source.project_id)
    assert.equal(interrupted.status, 'failed'); assert.match(interrupted.error!, /受控重建第二页连接中断/)
    assert.equal(interrupted.completed_chunks, 1)
    assert.equal(interrupted.quality_rebuild_for, initial.quality!.input_hash)
    assert.equal(interrupted.quality_repair, undefined)
    assert.equal(repairs, 1); assert.equal(reviews, 1, 'an incomplete fallback cannot enter the independent review')
    assert.notDeepEqual(interrupted.sections, initial.sections.slice(0, interrupted.sections.length))
    const replacementPage = structuredClone(interrupted.sections)
    interruptSecondPage = false
    const continuing = analyzer.start(source.project_id, 'model')
    assert.deepEqual(continuing.sections, replacementPage)
    const ready = await terminal(source.project_id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.quality!.status, 'passed'); assert.equal(ready.quality_rebuild_for, undefined)
    assert.deepEqual(ready.sections.slice(0, replacementPage.length), replacementPage)
    assert.deepEqual(originalPages, plan.map((_, index) => index + 1))
    assert.deepEqual(rebuiltPages, [1, 2, ...plan.slice(1).map((_, index) => index + 2)])
    assert.equal(repairs, 1, 'retry resumes the existing replacement directory without repeating the unsafe-repair decision')
    assert.equal(reviews, 2)
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(source.project_id)!.content, source.content)
  } finally { await analyzer.close() }
})

test('pausing an active quality repair preserves completed findings and ignores a late cancelled response after resume', async () => {
  const source = document('修补暂停并继续'); installSource(source)
  const entered = deferred(), release = deferred(), repaired: number[] = []
  let maps = 0, stories = 0, reviews = 0, secondAttempts = 0, interruptedSignal: AbortSignal | undefined
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, _contract, requestSignal) => {
    if (prompt.includes(repairMarker)) {
      const input = inputFor<RepairInput>(prompt, repairMarker)
      repaired.push(input.finding_index)
      if (input.finding_index === 1 && ++secondAttempts === 1) {
        interruptedSignal = requestSignal; entered.resolve(); await release.promise
        return repairReply(prompt, '已取消请求返回的过期理解')
      }
      return repairReply(prompt)
    }
    if (prompt.includes(reviewMarker)) return reviewReply(prompt, ++reviews === 1)
    if (prompt.includes(mapMarker)) maps++
    if (prompt.includes(storyMarker)) stories++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(source.project_id, 'model')
    const initial = await terminal(source.project_id)
    assert.equal(initial.status, 'failed')
    const retry = analyzer.start(source.project_id, 'model'); await entered.promise
    const before = scriptSourceAnalysis(source.project_id)!
    assert.equal(before.quality_repair!.completed_findings, 1)
    const published = scriptSourceDocument(source.project_id)!.analysis!
    assert.equal(published.quality_repair, undefined, 'public snapshots omit private repair checkpoints')
    assert.equal(published.work, undefined); assert.equal(published.story_work, undefined)
    assert.equal(published.resume!.available, true)
    assert.match(published.resume!.message, /已修补 1\/2 项问题/)

    const paused = analyzer.pause(source.project_id, retry.id)
    assert.equal(paused.status, 'paused'); assert.equal(interruptedSignal!.aborted, true)
    assert.deepEqual(paused.story, before.story); assert.deepEqual(paused.quality_repair, before.quality_repair)
    const resumed = analyzer.start(source.project_id, 'model')
    const ready = await terminal(source.project_id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.id, resumed.id)
    assert.ok(facts.every(fact => ready.story!.summary.includes(fact)))
    assert.equal(ready.story!.summary.includes('过期理解'), false)
    assert.deepEqual(ready.sections, initial.sections)
    release.resolve(); await tick(); await tick()
    assert.deepEqual(scriptSourceAnalysis(source.project_id)!.story, ready.story, 'the cancelled repair cannot overwrite newer progress')
    assert.deepEqual(repaired, [0, 1, 1])
    assert.deepEqual([maps, stories, reviews], [1, 1, 2])
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(source.project_id)!.content, source.content)
  } finally { release.resolve(); await analyzer.close() }
})

test('partial quality repairs are never reused after the source, model or execution configuration changes', async t => {
  for (const changed of ['source', 'model', 'configuration'] as const) await t.test(changed, async () => {
    const source = document(`修补隔离-${changed}`), configuration = { provider: 'fixture', version: 1 }
    let reviews = 0
    const failAfterFirstRepair = async (prompt: string) => {
      if (prompt.includes(repairMarker)) {
        if (inputFor<RepairInput>(prompt, repairMarker).finding_index === 1) throw new Error('暂停于第二项修补')
        return repairReply(prompt)
      }
      if (prompt.includes(reviewMarker)) return reviewReply(prompt, ++reviews === 1)
      return sourceAnalysisFixture(prompt)!
    }
    await assert.rejects(analyzeSourceSnapshot(source, 'model', failAfterFirstRepair, signal(), configuration), /核对发现/)
    await assert.rejects(analyzeSourceSnapshot(source, 'model', failAfterFirstRepair, signal(), configuration), /暂停于第二项修补/)
    assert.equal(checkpoint(source.project_id).quality_repair!.completed_findings, 1)
    const nextSource = changed === 'source' ? { ...source, content: `${source.content}新稿补充：灯火来自新的祭坛。\n` } : source
    const calls: string[] = []
    const result = await analyzeSourceSnapshot(nextSource, changed === 'model' ? 'other-model' : 'model', async prompt => {
      assert.equal(prompt.includes(repairMarker), false, 'an incompatible repair baseline cannot become a new-model patch input')
      calls.push(prompt.includes(mapMarker) ? 'map' : prompt.includes(storyMarker) ? 'story' : 'review')
      return sourceAnalysisFixture(prompt)!
    }, signal(), changed === 'configuration' ? { ...configuration, version: 2 } : configuration)
    assert.equal(result.status, 'ready')
    assert.equal(result.quality_repair, undefined)
    assert.deepEqual(calls, ['map', 'story', 'review'])
    assert.equal(result.story!.summary.includes(facts[0]!), false, 'old partial patch text is absent from the fresh synthesis')
  })
})
