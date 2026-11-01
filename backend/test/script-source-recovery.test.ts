import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisDiagnosisFingerprint, sourceAnalysisProgressFingerprint, sourceAnalysisRebuildFingerprint, withSourceAnalysisRecovery } from '../src/modules/script/script-source-recovery.js'

const qualityIssue = () => Object.assign(new Error('分析遗漏原文的用尽条件'), { sourceQualityIssues: true })
const formatIssue = (name = 'script_source_quality_repair') => Object.assign(new Error('修补项格式不合法'), { structuredOutputContract: name })

test('analysis restores format and successive semantic issues inside the same execution before returning a result', async () => {
  const failures = [qualityIssue(), formatIssue(), qualityIssue()]
  const notices: string[] = [], completed = { directory: 1, story: 1, repairs: 0 }, savedRepairs: string[] = []
  let calls = 0
  const result = await withSourceAnalysisRecovery(async () => {
    const issue = failures[calls++]
    if (calls === 3) savedRepairs.push('已补充用尽条件，继续核对后续因果')
    if (issue) throw issue
    completed.repairs++
    return completed
  }, { signal: new AbortController().signal, progressFingerprint: () => savedRepairs,
    onRecovery: recovery => notices.push(recovery.message) })
  assert.deepEqual(result, { directory: 1, story: 1, repairs: 1 })
  assert.equal(calls, 4)
  assert.equal(notices.length, 3)
  assert.match(notices[0]!, /修补具体问题/)
  assert.match(notices[1]!, /输出格式/)
  assert.match(notices[2]!, /重新复核/)
})

test('quality and format recovery continue beyond old pipeline ceilings while durable work progresses', async t => {
  for (const [kind, failure] of [['quality', qualityIssue], ['format', formatIssue]] as const) {
    await t.test(kind, async () => {
      let calls = 0, notices = 0
      const sections: string[] = []
      const result = await withSourceAnalysisRecovery(async () => {
        if (++calls <= 12) { sections.push(`已完成且证据验证通过的目录 ${calls}`); throw failure() }
        return 'ready'
      }, {
        progressFingerprint: () => sections,
        signal: new AbortController().signal, onRecovery: recovery => { notices++; assert.match(recovery.message, /可随时停止/) },
      })
      assert.equal(result, 'ready')
      assert.equal(calls, 13)
      assert.equal(notices, 12)
    })
  }
})

test('analysis remains cancellable while automatic repairs make useful progress', async () => {
  const controller = new AbortController(), reason = new DOMException('用户停止', 'AbortError')
  let calls = 0, notices = 0
  const saved: string[] = []
  await assert.rejects(withSourceAnalysisRecovery(async () => { calls++; saved.push(`实际修补 ${calls}`); throw qualityIssue() }, {
    progressFingerprint: () => saved,
    signal: controller.signal, onRecovery: () => { if (++notices === 7) setImmediate(() => controller.abort(reason)) },
  }), issue => issue === reason)
  assert.equal(calls, 7)
  assert.equal(notices, 7)
})

test('identical saved work and diagnosis stop empty retries, retain the cause and allow an explicit new execution', async t => {
  for (const [kind, failure] of [['quality', qualityIssue], ['format', formatIssue]] as const) await t.test(kind, async () => {
    const checkpoint = { sections: ['已保存目录'], story: '已保存全剧信息' }, before = structuredClone(checkpoint)
    const issue = failure()
    let calls = 0, notices = 0
    await assert.rejects(withSourceAnalysisRecovery(async () => { calls++; throw issue }, {
      signal: new AbortController().signal, progressFingerprint: () => checkpoint, onRecovery: () => { notices++ },
    }), error => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { code: string }).code, 'script_source_analysis_stalled')
      assert.equal(error.cause, issue)
      assert.match(error.message, /相同已保存结果.*同一问题.*未取得新进展/)
      assert.match(error.message, /均已保留.*手动继续分析.*更换模型/)
      assert.ok(error.message.includes(issue.message))
      return true
    })
    assert.deepEqual(checkpoint, before)
    assert.equal(calls, 2); assert.equal(notices, 1)
    let resumed = 0
    assert.equal(await withSourceAnalysisRecovery(async () => { if (++resumed === 1) throw issue; return 'ready' }, {
      signal: new AbortController().signal, progressFingerprint: () => checkpoint, onRecovery: () => {},
    }), 'ready', 'an explicit resume can retry the retained unfinished step')
    assert.equal(resumed, 2)
  })
})

test('A to B to A analysis cycles stop even when the latest output changed', async () => {
  let content = '', calls = 0
  await assert.rejects(withSourceAnalysisRecovery(async () => {
    content = ['A', 'B', 'A'][calls++]!
    throw qualityIssue()
  }, { signal: new AbortController().signal, progressFingerprint: () => ({ sections: [content] }), onRecovery: () => {} }),
  /未取得新进展/)
  assert.equal(calls, 3)
})

const analysis = (): ScriptSourceAnalysis => ({ id: 'execution', source_version: 'source', model_id: 'model', pipeline_version: 6,
  status: 'running', completed_chunks: 0, total_chunks: 1, sections: [], error: null, updated_at: 'initial',
  work: [{ offset: 0, length: 10, depth: 0, result: { sections: [{ title: '保留中的目录' }] } }],
  story_work: { input_hash: 'input', tasks: [{ key: 'characters', result: { name: '林舟' } }] },
  quality: { input_hash: 'review', status: 'issues', findings: [{ kind: 'omission', explanation: '遗漏用尽条件', unit_ids: [1, 2] }] } })

test('production fingerprints ignore clocks, display text and bookkeeping while retaining semantic work and strategy changes', () => {
  const state = analysis(), original = sourceAnalysisProgressFingerprint(state), rebuild = sourceAnalysisRebuildFingerprint(state)
  state.id = 'new-execution'; state.updated_at = 'later'; state.started_at = 'later'; state.status = 'failed'; state.phase = 'synthesis'
  state.progress = { stage: 'repairing', message: '第 100 次尝试' }; state.error = '不同的显示错误'; state.queue_position = 3
  state.completed_chunks = 100; state.completed_characters = 100; state.total_chunks = 100; state.work![0]!.depth = 3
  state.quality_rebuild_for = 'review'
  state.quality_repair = { review_hash: 'review', findings_hash: 'findings', current_hash: 'current', completed_findings: 100 }
  state.story_work!.tasks[0]!.failure = { message: '重新尝试' }
  state.quality!.findings[0]!.unit_ids.reverse()
  state.quality!.findings[0]!.explanation = '同一原文证据的遗漏限制换一种表述'
  assert.equal(sourceAnalysisProgressFingerprint(state), original)
  assert.equal(sourceAnalysisRebuildFingerprint(state), rebuild)
  state.work![0]!.result = { sections: [{ title: '已经修正的目录' }] }
  assert.notEqual(sourceAnalysisProgressFingerprint(state), original)
  assert.equal(sourceAnalysisRebuildFingerprint(state), rebuild, 'a completed interpretation comparison ignores transient work logs')
  const beforeTask = sourceAnalysisProgressFingerprint(state)
  state.story_work!.tasks[0]!.context = { strategy: 'character-evidence-v1', input_hash: 'new-evidence' }
  assert.notEqual(sourceAnalysisProgressFingerprint(state), beforeTask, 'a real alternate evidence strategy receives an attempt')
})

test('raw malformed text and error wrapper changes cannot masquerade as saved analysis progress', async () => {
  let calls = 0
  await assert.rejects(withSourceAnalysisRecovery(async () => {
    calls++
    throw Object.assign(formatIssue(), { message: `第 ${calls} 次结构不合法`, diagnostics: 'ending 缺少 section_ids', raw_output: `changed output ${calls}` })
  }, { signal: new AbortController().signal, progressFingerprint: () => analysis(), onRecovery: () => {} }),
  /ending 缺少 section_ids/)
  assert.equal(calls, 2)
})

test('paraphrased quality findings and changing invented evidence IDs retain the same semantic diagnosis', async t => {
  for (const kind of ['quality', 'format']) await t.test(kind, async () => {
    const state = analysis()
    let calls = 0
    await assert.rejects(withSourceAnalysisRecovery(async () => {
      calls++
      state.quality!.findings[0]!.explanation = `不同说法 ${calls}`
      if (kind === 'quality') throw Object.assign(qualityIssue(), { message: state.quality!.findings[0]!.explanation })
      throw Object.assign(formatIssue(), { diagnostics: `sections.0.events.0.evidence.unit_id=${999 + calls} 不属于「章节」正文范围` })
    }, { signal: new AbortController().signal, progressFingerprint: () => sourceAnalysisProgressFingerprint(state),
      diagnosisFingerprint: issue => sourceAnalysisDiagnosisFingerprint(state, issue), onRecovery: () => {} }), /未取得新进展/)
    assert.equal(calls, 2)
  })
})

test('cancellation and unrelated failures cannot be turned into new analysis requests', async t => {
  const failures = [new Error('连接中断'), Object.assign(new Error('鉴权失败'), { statusCode: 401 }),
    Object.assign(new Error('分析累计用量已到上限'), { code: 'script_request_budget_exceeded' }),
    formatIssue('script_draft_repair')]
  for (const failure of failures) await t.test(failure.message, async () => {
    let calls = 0
    await assert.rejects(withSourceAnalysisRecovery(async () => { calls++; throw failure }, {
      signal: new AbortController().signal, onRecovery: () => assert.fail('unrelated failures must not trigger analysis recovery'),
    }), issue => issue === failure)
    assert.equal(calls, 1)
  })
  const controller = new AbortController(), reason = new Error('用户停止')
  let calls = 0
  await assert.rejects(withSourceAnalysisRecovery(async () => { calls++; controller.abort(reason); throw formatIssue() }, {
    signal: controller.signal, onRecovery: () => assert.fail('cancelled work must not restart'),
  }), issue => issue === reason)
  assert.equal(calls, 1)
})
