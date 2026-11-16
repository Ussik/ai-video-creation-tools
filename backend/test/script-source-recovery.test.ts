import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisDiagnosisFingerprint, sourceAnalysisFailureDetails, sourceAnalysisProgressFingerprint, sourceAnalysisRebuildFingerprint, withSourceAnalysisRecovery } from '../src/modules/script/script-source-recovery.js'

const qualityIssue = () => Object.assign(new Error('分析遗漏原文的用尽条件'), { sourceQualityIssues: true })
const formatIssue = (name = 'script_source_quality_repair') => Object.assign(new Error('修补项格式不合法'), { structuredOutputContract: name })

test('initial and wrapped failures retain their actual format, evidence, content or recovery category', () => {
  for (const [metadata, stage] of [
    [{ code: 'model_json_syntax' }, 'format'],
    [{ code: 'model_field_contract' }, 'format'],
    [{ code: 'model_business_validation', structuredOutputContract: 'script_source_evidence_repair' }, 'evidence'],
    [{ code: 'model_business_validation', structuredOutputContract: 'script_source_quality' }, 'content'],
    [{ code: 'structured_checkpoint_identity_mismatch' }, 'recovery'],
    [{ code: 'structured_initial_delivery_pending', failure_stage: 'recovery' }, 'recovery'],
    [{ code: 'source_request_recovery_conflict' }, 'recovery'],
    [{ code: 'source_request_unknown' }, 'recovery'],
    [{ code: 'source_request_sibling_pending' }, 'recovery'],
    [{ code: 'model_workflow_budget_invalid' }, 'recovery'],
    [{ code: 'model_workflow_budget_exceeded' }, 'recovery'],
  ] as const) {
    const cause = Object.assign(new Error('当前原因'), metadata)
    const wrapped = new Error('历史包装', { cause })
    assert.equal(sourceAnalysisFailureDetails(wrapped).stage, stage)
  }
})

test('program-owned recovery codes outrank historical model failures across a bounded cause traversal', () => {
  const conflict = Object.assign(new Error('当前请求许可不对应此步骤'), { code: 'source_request_recovery_conflict' })
  const stale = Object.assign(new Error('旧模型格式问题', { cause: conflict }), {
    code: 'model_json_syntax', current_failure: { status: 'invalid_json', layer: 'format', message: '旧候选格式未通过' },
  })
  assert.deepEqual(sourceAnalysisFailureDetails(stale), { stage: 'recovery', message: conflict.message })
  const cycle: { code: string; message: string; cause?: unknown } = { code: 'unknown_wrapper', message: 'wrapper' }
  cycle.cause = cycle
  assert.equal(sourceAnalysisFailureDetails(cycle).stage, 'content', 'cyclic cause metadata terminates without inferring a recovery failure')
  for (const message of ['source_request_recovery_conflict', '恢复许可已用完', 'program recovery authorization conflict']) {
    assert.equal(sourceAnalysisFailureDetails(new Error(message)).stage, 'content', 'message text never supplies a program-owned code')
  }
  assert.equal(sourceAnalysisFailureDetails(Object.assign(new Error('保存纠正仍无效'), {
    code: 'structured_correction_exhausted', failure_stage: 'recovery',
    current_failure: { status: 'invalid_json', layer: 'format', message: '当前JSON未通过' },
  })).stage, 'format', 'a saved answer validation failure keeps its current model-output layer')
})

test('a wrapped dispatch conflict cannot trigger quality or format auto-recovery or another request', async () => {
  const conflict = Object.assign(new Error('请求身份已变化'), { code: 'source_request_recovery_conflict' })
  const failure = Object.assign(new Error('保留的模型诊断', { cause: conflict }), { sourceQualityIssues: true, structuredOutputContract: 'script_source_quality_repair' })
  let calls = 0
  await assert.rejects(withSourceAnalysisRecovery(async () => { calls++; throw failure }, {
    signal: new AbortController().signal, onRecovery: () => assert.fail('a program guard cannot authorize a model retry'),
  }), issue => issue === failure)
  assert.equal(calls, 1)
})

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


test('retained character fixes count as progress while execution lineage and obsolete candidates do not', () => {
  const state = analysis()
  state.story_candidate = { input_hash: 'source-directory-configuration', result: { covered_section_ids: [0], story: {
    summary: '林舟把钥匙交给车夫。',
    characters: [{ name: '林舟', aliases: [], description: '交出钥匙的主角。', section_ids: [0] }],
    timeline: [{ summary: '林舟交出钥匙。', section_ids: [0] }], threads: [],
    ending: { summary: '车夫等林舟回家。', section_ids: [0] }, uncertainties: [],
  } } }
  const original = sourceAnalysisProgressFingerprint(state)
  state.story_response_run_ids = ['original-compatible-execution', 'another-compatible-execution']
  state.updated_at = 'a later checkpoint'; state.progress = { stage: 'repairing', message: '重试人物补充' }
  assert.equal(sourceAnalysisProgressFingerprint(state), original, 'changing the execution lineage is not manuscript progress')

  state.story_candidate.result!.story.characters.push({ name: '车夫', aliases: [], description: '接过钥匙并等林舟回家。', section_ids: [0] })
  assert.notEqual(sourceAnalysisProgressFingerprint(state), original, 'a newly retained character permits recovery to continue instead of being mistaken for a stalled retry')
  state.story = structuredClone(state.story_candidate.result!.story)
  const published = sourceAnalysisProgressFingerprint(state)
  state.story_candidate.result!.story.summary = 'unused obsolete candidate'
  assert.equal(sourceAnalysisProgressFingerprint(state), published, 'once a validated story exists, an obsolete candidate cannot manufacture progress')
})


const evidenceDiagnosis = (path: string, unknown: number[], repeated: number[] = []) =>
  `${path}必须引用真实且非空的原文句段，不能重复或编造证据ID；非法ID=${JSON.stringify(unknown)}，重复ID=${JSON.stringify(repeated)}。仅使用units[].id，不是字符偏移、目录ID或集数；不得猜测相邻ID。`
const blankDiagnosis = (path: string, ids: number[]) =>
  `${path}必须引用真实且非空的原文句段；所引ID=${JSON.stringify(ids)}均无非空证据。仅使用units[].id，不是字符偏移；不得猜测或补造ID。`

test('quality evidence diagnosis ignores only changing machine ID values while preserving paths and error categories', () => {
  const state = analysis()
  const fp = (text: string) => sourceAnalysisDiagnosisFingerprint(state, Object.assign(formatIssue('script_source_quality'), { diagnostics: text }))
  assert.deepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378, 11057])), fp(evidenceDiagnosis('findings[1].unit_ids', [20000])))
  assert.deepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [], [4, 4])), fp(evidenceDiagnosis('findings[1].unit_ids', [], [8])))
  assert.deepEqual(fp(blankDiagnosis('findings[1].unit_ids', [4])), fp(blankDiagnosis('findings[1].unit_ids', [8, 12])))
  assert.deepEqual(fp(evidenceDiagnosis('items[].finding.unit_ids', [10378])), fp(evidenceDiagnosis('items[].finding.unit_ids', [11057])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378])), fp(evidenceDiagnosis('findings[2].unit_ids', [10378])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378])), fp(evidenceDiagnosis('items[].finding.unit_ids', [10378])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378])), fp(evidenceDiagnosis('findings[1].unit_ids', [], [10378])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378])), fp(blankDiagnosis('findings[1].unit_ids', [10378])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378], [4])), fp(evidenceDiagnosis('findings[1].unit_ids', [10378])))
  assert.notDeepEqual(fp(evidenceDiagnosis('findings[1].unit_ids', [10378]) + ' 第10集事件'), fp(evidenceDiagnosis('findings[1].unit_ids', [10378]) + ' 第11集事件'))
  assert.notDeepEqual(fp('创作者说明非法ID=[10378]，第10集'), fp('创作者说明非法ID=[11057]，第10集'), 'unrelated prose is not a machine-owned diagnostic')
})

test('changing invalid quality IDs cannot bypass no-progress stopping and the final error retains actual diagnostic values', async t => {
  for (const category of ['unknown', 'repeated', 'blank', 'page'] as const) await t.test(category, async () => {
    const state = analysis(); let calls = 0, notices = 0
    const errors: Array<Error & { diagnostics: string }> = []
    await assert.rejects(withSourceAnalysisRecovery(async () => {
      calls++; const id = 10000 + calls
      const diagnostics = category === 'blank' ? blankDiagnosis('findings[1].unit_ids', [id])
        : evidenceDiagnosis(category === 'page' ? 'items[].finding.unit_ids' : 'findings[1].unit_ids', category === 'repeated' ? [] : [id], category === 'repeated' ? [id] : [])
      const issue = Object.assign(formatIssue('script_source_quality'), { diagnostics }); errors.push(issue); throw issue
    }, { signal: new AbortController().signal, progressFingerprint: () => sourceAnalysisProgressFingerprint(state),
      diagnosisFingerprint: issue => sourceAnalysisDiagnosisFingerprint(state, issue), onRecovery: () => { notices++ } }), issue => {
      assert.ok(issue instanceof Error); assert.match(issue.message, /未取得新进展/)
      assert.ok(issue.message.includes('[10002]')); assert.ok(!issue.message.includes('<invalid>'))
      assert.equal(issue.cause, errors[1]); assert.ok(errors[0]!.diagnostics.includes('[10001]')); assert.ok(errors[1]!.diagnostics.includes('[10002]'))
      return true
    })
    assert.equal(calls, 2); assert.equal(notices, 1)
  })
})

test('distinct quality finding paths remain independent diagnoses and permit their separate bounded repair attempt', async () => {
  const state = analysis(); let calls = 0
  const value = await withSourceAnalysisRecovery(async () => {
    calls++
    if (calls < 3) throw Object.assign(formatIssue('script_source_quality'), { diagnostics: evidenceDiagnosis(`findings[${calls - 1}].unit_ids`, [10000 + calls]) })
    return 'separate fields observed'
  }, { signal: new AbortController().signal, progressFingerprint: () => sourceAnalysisProgressFingerprint(state),
    diagnosisFingerprint: issue => sourceAnalysisDiagnosisFingerprint(state, issue), onRecovery: () => {} })
  assert.equal(value, 'separate fields observed'); assert.equal(calls, 3)
})


test('machine-looking quoted diagnostics and appended story prose retain all original semantic numbers', () => {
  const state = analysis()
  const fp = (text: string) => sourceAnalysisDiagnosisFingerprint(state, Object.assign(formatIssue('script_source_quality'), { diagnostics: text }))
  for (const diagnose of [
    (id: number) => evidenceDiagnosis('findings[1].unit_ids', [id]),
    (id: number) => blankDiagnosis('findings[1].unit_ids', [id]),
  ]) {
    assert.notDeepEqual(fp('创作者原话：' + diagnose(10)), fp('创作者原话：' + diagnose(20)), 'a complete machine-looking sentence inside creator prose is not a machine-owned line')
    assert.notDeepEqual(fp(diagnose(10) + ' 故事对白：非法ID=[30]'), fp(diagnose(10) + ' 故事对白：非法ID=[40]'), 'appended prose disables template normalization rather than swallowing its numbers')
    assert.notDeepEqual(fp(diagnose(10) + ' 故事对白：非法ID=[30]'), fp(diagnose(20) + ' 故事对白：非法ID=[30]'), 'a line with additional semantic content is preserved completely')
  }
})
