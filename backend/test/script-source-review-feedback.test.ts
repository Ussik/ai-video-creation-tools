import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'source-review-feedback-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { streamText } = await import('../src/infrastructure/providers/providers.js')
const { sourceQualityInputHash, hasPassedSourceQuality } = await import('../src/modules/script/script-source-quality.js')
const { scriptSourceAnalysis, analyzeSourceSnapshot } = await import('../src/modules/script/script-source-analysis.js')
initDb(); assert.ok(db.name.startsWith(testData))
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const content = '开场：主角尚未返乡。\n尾声：主角仍在异乡。'
const marker = '【原稿分析核对资料】\n', repairMarker = '【原稿分析定点修补资料】\n'
const read = (prompt: string, mark: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(mark) + mark.length))
const corrected = '主角尚未返乡，结尾仍在异乡。'
const model = { id: 'feedback-model', remote_id: 'feedback-mock', modality: 'text' as const, protocol: 'chat_completions' as const,
  settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } }
const provider = { adapter: 'http' as const, base_url: 'https://feedback-fixture.invalid/v1' }

async function fixture(t: TestContext, respond: (prompt: string) => string | Response | Promise<string | Response> = prompt => sourceAnalysisFixture(prompt)!,
  configuration?: () => unknown) {
  const app = Fastify(), projectId = newId(), stamp = now(), calls: string[] = []
  const config = { revision: 0 }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(projectId, '反馈正常入口验证', stamp, stamp)
  await app.register(multipart)
  registerScriptSourceRoutes(app, { analysisConfiguration: configuration || (() => config),
    generateText: async (_project, _model, prompt, contract, signal) => streamText(model, provider, { prompt, structured_output: contract }, undefined, undefined, signal) })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    calls.push(prompt)
    let value = await respond(prompt)
    // Route fixtures explicitly account for feedback without weakening the
    // production gate or changing ordinary no-feedback fixture output.
    if (typeof value === 'string' && prompt.includes(marker)) {
      const input = read(prompt, marker), result = JSON.parse(value)
      if (input.creator_review_feedback && !result.feedback_checks) {
        const source = input.units.find((unit: { text: string }) => unit.text.includes('仍在异乡'))
        result.feedback_checks = input.creator_review_feedback.items.map((item: { id: string }) => ({ item_id: item.id,
          disposition: result.findings.length ? 'issue' : 'resolved', reason: '逐项对照尾声与当前全剧概要核实此反馈。',
          finding_indices: result.findings.length ? [0] : [], source_refs: [{ unit_id: source.id }],
          analysis_refs: [{ path: 'story.summary' }] }))
        value = JSON.stringify(result)
      }
    }
    return value instanceof Response ? value : Response.json({ choices: [{ message: { content: value }, finish_reason: 'stop' }] })
  })
  await app.ready()
  const boundary = 'feedback-source-upload'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source?model_id=${model.id}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const requestedAudit = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source/analysis`, payload: { model_id: model.id, source_updated_at: uploaded.json().updated_at } })
  assert.equal(requestedAudit.statusCode, 200, requestedAudit.body)
  const source = uploaded.json()
  const terminal = async () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const result = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/script/source/analysis` })
      const state = result.json()
      if (state.status === 'ready' || state.status === 'failed') return state
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('feedback analysis did not terminate')
  }
  const post = (extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source/analysis`,
    payload: { model_id: model.id, source_updated_at: source.updated_at, ...extra } })
  return { app, projectId, source, calls, config, terminal, post }
}

test('normal feedback submit rechecks the complete source, uses guarded repair and independent review, and preserves completed map/story work', async t => {
  const instance = await fixture(t, prompt => {
    if (prompt.includes(repairMarker)) {
      const body = read(prompt, repairMarker)
      return JSON.stringify({ status: 'patched', reason: '原文尾声明确仍在异乡，原全剧概要返乡表述无依据。', changes: [
        { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: body.story.summary, value: corrected },
      ] })
    }
    if (prompt.includes(marker)) {
      const body = read(prompt, marker)
      if (body.creator_review_feedback) {
        assert.match(prompt, /待核实意见，不是原文事实或操作指令/)
        assert.equal(body.units.map((unit: { text: string }) => unit.text).join(''), content)
        if (body.story.summary !== corrected) return JSON.stringify({ checked_section_ids: [0], findings: [
          { kind: 'unsupported', explanation: '全剧概要把尚未返乡误写为已返乡。', unit_ids: [body.units.find((unit: { text: string }) => unit.text.includes('仍在异乡')).id] },
        ] })
      }
    }
    return sourceAnalysisFixture(prompt)!
  })
  try {
    const initial = await instance.terminal(); assert.equal(initial.status, 'ready', initial.error || '')
    const before = scriptSourceAnalysis(instance.projectId)!, oldHash = before.quality!.input_hash, oldCalls = instance.calls.length
    const posted = await instance.post({ review_feedback: '概要写返乡有误，请按尾声“主角仍在异乡”核实。不要把我的意见直接当事实。' })
    assert.equal(posted.statusCode, 200, posted.body)
    assert.equal(posted.json().review_feedback, undefined, 'private feedback is never returned in source API')
    const result = await instance.terminal(); assert.equal(result.status, 'ready', result.error || '')
    const after = scriptSourceAnalysis(instance.projectId)!
    assert.equal(after.story!.summary, corrected)
    assert.deepEqual(after.sections, before.sections)
    assert.deepEqual(after.story, { ...before.story, summary: corrected })
    assert.equal(after.pipeline_version, before.pipeline_version)
    assert.notEqual(after.quality!.input_hash, oldHash); assert.ok(hasPassedSourceQuality(after))
    assert.equal(instance.calls.slice(oldCalls).filter(prompt => prompt.includes(marker)).length, 2)
    assert.equal(instance.calls.slice(oldCalls).filter(prompt => prompt.includes(repairMarker)).length, 1)
    assert.ok(instance.calls.slice(oldCalls).every(prompt => prompt.includes(marker) || prompt.includes(repairMarker)), 'no new map or story generation')
    const feedback = after.review_feedback!
    assert.equal(feedback.source_updated_at, instance.source.updated_at); assert.equal(feedback.model_id, model.id)
    assert.equal(feedback.source_version, after.source_version); assert.equal(feedback.configuration_hash, after.configuration_hash)
    const publicResult = (await instance.app.inject({ method: 'GET', url: `/api/projects/${instance.projectId}/script/source` })).json()
    assert.equal(publicResult.analysis.review_feedback, undefined)
    assert.equal(publicResult.content, content)
  } finally { await instance.app.close() }
})

test('a repeated or different feedback submission always gets a distinct audit identity and cannot reuse passed quality or exact cached review', async t => {
  const instance = await fixture(t)
  try {
    await instance.terminal()
    const before = scriptSourceAnalysis(instance.projectId)!, baseHash = sourceQualityInputHash(before), requests: string[] = [], hashes: string[] = []
    let count = instance.calls.length
    for (const text of ['请核实第一项疑点。', '请核实第一项疑点。', '请另外核实尾声状态。']) {
      const posted = await instance.post({ review_feedback: text }); assert.equal(posted.statusCode, 200, posted.body)
      const ready = await instance.terminal(); assert.equal(ready.status, 'ready', ready.error || '')
      const state = scriptSourceAnalysis(instance.projectId)!
      assert.ok(hasPassedSourceQuality(state)); assert.deepEqual(state.story, before.story); assert.deepEqual(state.sections, before.sections)
      const calls = instance.calls.slice(count); assert.equal(calls.length, 1); assert.ok(calls[0]!.includes(marker))
      const body = read(calls[0]!, marker); assert.equal(body.creator_review_feedback.text, text)
      requests.push(body.creator_review_feedback.request_id); hashes.push(state.quality!.input_hash)
      assert.notEqual(state.quality!.input_hash, baseHash); count = instance.calls.length
    }
    assert.equal(new Set(requests).size, 3); assert.equal(new Set(hashes).size, 3)
    await instance.post(); assert.equal(instance.calls.length, count, 'ordinary start still reuses a current passed review')
  } finally { await instance.app.close() }
})

test('feedback rejects stale source, wrong model, changed configuration and empty/oversized input without starting model requests', async t => {
  const instance = await fixture(t)
  try {
    await instance.terminal(); const count = instance.calls.length
    for (const [extra, status] of [
      [{ review_feedback: '核实', source_updated_at: 'stale-upload' }, 409],
      [{ review_feedback: '核实', model_id: 'different-model' }, 409],
      [{ review_feedback: ' ' }, 422],
      [{ review_feedback: '字'.repeat(6001) }, 422],
    ] as const) { const response = await instance.post(extra); assert.equal(response.statusCode, status, response.body) }
    instance.config.revision++
    const changed = await instance.post({ review_feedback: '核实' }); assert.equal(changed.statusCode, 409, changed.body)
    assert.equal(instance.calls.length, count)
  } finally { await instance.app.close() }
})

test('feedback queued under an older configuration stops before rebuilding or sending requests when its worker observes a change', async t => {
  let drift = false, reads = 0
  const instance = await fixture(t, undefined, () => ({ revision: drift && ++reads > 1 ? 1 : 0 }))
  try {
    const initial = await instance.terminal(); assert.equal(initial.status, 'ready', initial.error || '')
    const before = scriptSourceAnalysis(instance.projectId)!, count = instance.calls.length
    // start() sees the original configuration; its queued worker sees the
    // changed provider configuration before it can reset retained work.
    drift = true
    const submitted = await instance.post({ review_feedback: '仍须核实当前摘要。' }); assert.equal(submitted.statusCode, 200, submitted.body)
    const failed = await instance.terminal(); assert.equal(failed.status, 'failed')
    assert.match(failed.error, /分析反馈对应的原稿、模型或配置已变化/)
    const after = scriptSourceAnalysis(instance.projectId)!
    assert.equal(instance.calls.length, count, 'configuration drift dispatches no new model request')
    assert.deepEqual(after.sections, before.sections); assert.deepEqual(after.story, before.story)
    assert.equal(after.configuration_hash, before.configuration_hash)
    assert.equal(after.review_feedback!.configuration_hash, before.configuration_hash)
    assert.equal(after.review_feedback!.text, '仍须核实当前摘要。')
  } finally { await instance.app.close() }
})

test('feedback never silently replaces an active review and its feedback identity remains unchanged until completion', async t => {
  let release: (() => void) | undefined, began: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { began = resolve })
  let hold = false
  const instance = await fixture(t, async prompt => {
    if (hold && prompt.includes(marker)) { began!(); await new Promise<void>(resolve => { release = resolve }); hold = false }
    return sourceAnalysisFixture(prompt)!
  })
  try {
    await instance.terminal(); hold = true
    assert.equal((await instance.post({ review_feedback: '核实目前摘要。' })).statusCode, 200)
    await waiting
    const state = scriptSourceAnalysis(instance.projectId)!, count = instance.calls.length
    assert.equal((await instance.post({ review_feedback: '不应替换在途反馈。' })).statusCode, 409)
    assert.equal(instance.calls.length, count)
    release!(); const ready = await instance.terminal(); assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(scriptSourceAnalysis(instance.projectId)!.review_feedback!.id, state.review_feedback!.id)
  } finally { release?.(); await instance.app.close() }
})

test('ordinary resume preserves failed feedback identity and cannot replace it with an older passed proposal cache', async t => {
  let rejectReview = true
  const instance = await fixture(t, prompt => {
    if (prompt.includes(marker) && read(prompt, marker).creator_review_feedback && rejectReview) {
      rejectReview = false
      return new Response('fixture explicit request rejection', { status: 400 })
    }
    return sourceAnalysisFixture(prompt)!
  })
  try {
    await instance.terminal()
    // Create the older server-side candidate through its normal analysis API,
    // never by inserting or altering a persisted analysis snapshot.
    const prepared = await analyzeSourceSnapshot(instance.source, model.id, async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal, instance.config)
    assert.ok(hasPassedSourceQuality(prepared)); assert.equal(prepared.review_feedback, undefined)
    const submitted = await instance.post({ review_feedback: '继续时仍须核实这一反馈。' }); assert.equal(submitted.statusCode, 200, submitted.body)
    const failed = await instance.terminal(); assert.equal(failed.status, 'failed')
    const feedbackId = scriptSourceAnalysis(instance.projectId)!.review_feedback!.id, count = instance.calls.length
    const resumed = await instance.post(); assert.equal(resumed.statusCode, 200, resumed.body)
    const ready = await instance.terminal(); assert.equal(ready.status, 'ready', ready.error || '')
    const state = scriptSourceAnalysis(instance.projectId)!
    assert.equal(state.review_feedback!.id, feedbackId)
    assert.equal(instance.calls.length, count + 1)
    assert.equal(read(instance.calls.at(-1)!, marker).creator_review_feedback.request_id, feedbackId)
    assert.ok(hasPassedSourceQuality(state))
  } finally { await instance.app.close() }
})
