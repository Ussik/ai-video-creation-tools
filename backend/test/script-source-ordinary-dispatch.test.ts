import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { createSourceStoryDispatchGrant, isUnstartedSourceStoryTask, sourceStoryDispatchAuthorized, sourceQualityDispatchAuthorized, bindSourceQualityDispatchGrant } from '../src/modules/script/script-source-ordinary-dispatch.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { sourceStoryResume } from '../src/modules/script/script-source-story-progress.js'

const request = { task_key: 'characters_merge:fixture', candidate_hash: 'merge-candidate', request_key: 'exact-managed-request' }
function fixture() {
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: 'p', filename: 'story.md', content: '完整原稿', updated_at: 'source-stamp' }
  const state: ScriptSourceAnalysis = { id: 'explicit-run', source_version: 'source', model_id: 'model', configuration_hash: 'configuration',
    status: 'queued', completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: 'stamp', phase: 'synthesis',
    story_work: { input_hash: 'work', tasks: [
      ...Array.from({ length: 16 }, (_, i) => ({ key: `completed:${i}`, result: { preserved: i } })),
      { key: 'unknown:0', result: { preserved: 'already locally valid' }, output_candidate: { context_hash: 'old', checkpoint: { raw: 'complete original', correction_started: { input_hash: 'old-correction' } } } },
      { key: request.task_key, failure: { code: 'source_request_sibling_pending', message: 'legacy sibling diagnostic 13/21' },
        output_candidate: { context_hash: request.candidate_hash, replay_version: 1, checkpoint: {} } },
    ] } }
  const context = { document, state, configuration_hash: 'configuration', local_active: false }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
  state.status = 'running'; context.local_active = true
  return context
}

test('explicit ordinary authorization survives a queued snapshot reload and excludes completed or previously attempted logical tasks', () => {
  const context = fixture()
  assert.equal(sourceStoryDispatchAuthorized(context, request), true)
  assert.equal(sourceStoryDispatchAuthorized(JSON.parse(JSON.stringify(context)), request), true)
  assert.ok(context.state.ordinary_story_dispatch?.protected_task_keys.includes('unknown:0'))
  assert.equal(sourceStoryDispatchAuthorized(context, { ...request, task_key: 'unknown:0', candidate_hash: 'old' }), false)
  assert.equal(sourceStoryDispatchAuthorized(context, { ...request, task_key: 'completed:0' }), false)
  const cp = context.state.story_work!.tasks.at(-1)!.output_candidate!.checkpoint
  cp.input_hash = 'frozen-initial'; cp.initial_started = { input_hash: 'frozen-initial' }
  assert.equal(sourceStoryDispatchAuthorized(context, request), true, 'producer initial marker does not revoke its own new-task grant')
  cp.initial_started = { input_hash: 'another-input' }
  assert.equal(sourceStoryDispatchAuthorized(context, request), false)
})

test('ordinary authorization is invalidated by current run source config feedback work or dispatch-boundary changes', async t => {
  const changes: Array<[string, (context: ReturnType<typeof fixture>) => void]> = [
    ['no explicit grant', c => { delete c.state.ordinary_story_dispatch }],
    ['not locally active', c => { c.local_active = false }],
    ['paused', c => { c.state.status = 'paused' }],
    ['queued', c => { c.state.status = 'queued' }],
    ['run replaced', c => { c.state.id = 'replacement' }],
    ['source version', c => { c.state.source_version = 'new-version' }],
    ['source timestamp', c => { c.document.updated_at = 'new-stamp' }],
    ['source content', c => { c.document.content = '其他内容' }],
    ['filename', c => { c.document.filename = 'other.md' }],
    ['model', c => { c.state.model_id = 'other-model' }],
    ['configuration', c => { c.configuration_hash = 'new-configuration' }],
    ['state configuration', c => { c.state.configuration_hash = 'new-configuration' }],
    ['feedback', c => { c.state.review_feedback = { id: 'feedback', text: 'different', source_version: 'source', source_updated_at: 'source-stamp', model_id: 'model', configuration_hash: 'configuration' } }],
    ['work invalidated', c => { c.state.story_work!.input_hash = 'rebuilt' }],
    ['candidate changed', c => { c.state.story_work!.tasks.at(-1)!.output_candidate!.context_hash = 'changed' }],
    ['new complete raw', c => { c.state.story_work!.tasks.at(-1)!.output_candidate!.checkpoint.raw = '' }],
    ['new correction started', c => { c.state.story_work!.tasks.at(-1)!.output_candidate!.checkpoint.correction_started = { input_hash: 'correction' } }],
    ['new result', c => { c.state.story_work!.tasks.at(-1)!.result = {} }],
    ['unknown delivery', c => { c.state.story_work!.tasks.at(-1)!.failure = { code: 'source_request_unknown', message: 'unknown' } }],
  ]
  for (const [name, mutate] of changes) await t.test(name, () => {
    const context = fixture(); mutate(context); assert.equal(sourceStoryDispatchAuthorized(context, request), false)
  })
})

test('new dynamic tasks may use their own candidate without inheriting protected sibling permissions', () => {
  const context = fixture()
  context.state.story_work!.tasks.push({ key: 'characters_merge:next', output_candidate: { context_hash: 'next-binding', checkpoint: {} } })
  assert.equal(sourceStoryDispatchAuthorized(context, { ...request, task_key: 'characters_merge:next', candidate_hash: 'next-binding' }), true)
  assert.deepEqual(context.state.story_work!.tasks.find(t => t.key === 'unknown:0')!.output_candidate!.checkpoint,
    { raw: 'complete original', correction_started: { input_hash: 'old-correction' } })
})

test('only an unstarted sibling-blocked task offers explicit independent continuation; unknown or saved correction keeps its recovery path', () => {
  const context = fixture(), task = context.state.story_work!.tasks.at(-1)!
  context.state.status = 'failed'
  assert.equal(sourceStoryResume(context.state)?.action, 'continue')
  assert.equal(sourceStoryResume(context.state)?.available, true)
  assert.equal(isUnstartedSourceStoryTask(task), true)
  task.output_candidate!.checkpoint.raw = 'saved candidate'
  assert.equal(isUnstartedSourceStoryTask(task), false)
  assert.equal(sourceStoryResume(context.state)?.action, 'reconcile_request')
  task.output_candidate!.checkpoint.correction_started = { input_hash: 'unknown' }
  assert.equal(sourceStoryResume(context.state)?.available, false)
})

test('same-run normal streaming remains concurrent; a terminal unknown sibling revokes the grant at dispatch', () => {
  const context = { ...fixture(), current_run_unknown: true }
  const sibling = { key: 'characters:in-flight', output_candidate: { context_hash: 'sibling', checkpoint: {
    initial_started: { input_hash: 'sibling-initial' } } }, failure: undefined as { code: string; message: string } | undefined }
  context.state.story_work!.tasks.push(sibling)
  assert.equal(sourceStoryDispatchAuthorized(context, request), true)
  sibling.failure = { code: 'stream_disconnected', message: 'terminal unknown delivery' }
  assert.equal(sourceStoryDispatchAuthorized(context, request), false)
  context.current_run_unknown = false
  assert.equal(sourceStoryDispatchAuthorized(context, request), true, 'settled ledger is not an unknown dispatch')
  context.current_run_unknown = true
  sibling.failure = { code: 'source_request_sibling_pending', message: 'never dispatched' }
  assert.equal(sourceStoryDispatchAuthorized(context, request), true)
})

test('fresh quality authorization is bound with the successful story checkpoint and survives losing story_work', () => {
  const context = fixture(), oldGrant = structuredClone(context.state.ordinary_story_dispatch!)
  context.state.story = { summary: '完整总结', characters: [], timeline: [], threads: [], ending: { summary: '结局', section_ids: [0] }, uncertainties: [] }
  delete context.state.story_work
  const quality = { task_key: 'quality:initial' as const, candidate_hash: sourceQualityInputHash(context.state), request_key: 'exact-quality' }
  assert.equal(sourceQualityDispatchAuthorized(context, quality), false)
  bindSourceQualityDispatchGrant(context, 'wrong-work')
  assert.deepEqual(context.state.ordinary_story_dispatch, oldGrant)
  bindSourceQualityDispatchGrant(context, 'work')
  assert.equal(sourceQualityDispatchAuthorized(JSON.parse(JSON.stringify(context)), quality), true)
  context.state.quality_work = { input_hash: quality.candidate_hash, checkpoint: { steps: {} } }
  assert.equal(sourceQualityDispatchAuthorized(context, { ...quality, task_key: 'quality:page' }), true)
  context.state.story.summary = '被替换的总结'
  assert.equal(sourceQualityDispatchAuthorized(context, quality), false)
})

test('quality grants cannot be minted from old audits or repairs, or used with changed identity or unresolved same-run requests', async t => {
  for (const kind of ['quality', 'quality_work', 'quality_repair'] as const) await t.test(kind, () => {
    const context = fixture()
    Object.assign(context.state, { [kind]: kind === 'quality' ? { input_hash: 'old', status: 'issues', findings: [] }
      : kind === 'quality_work' ? { input_hash: 'old', checkpoint: { steps: {} } } : { review_hash: 'old' } })
    context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
    assert.equal(context.state.ordinary_story_dispatch?.quality_pending_story, undefined)
    assert.equal(context.state.ordinary_story_dispatch?.quality_input_hash, undefined)
  })
  const changes: Array<[string, (c: ReturnType<typeof fixture> & { current_run_unknown: boolean }) => void]> = [
    ['run', c => { c.state.id = 'other' }], ['source', c => { c.document.content = 'changed' }],
    ['config', c => { c.configuration_hash = 'changed' }], ['inactive', c => { c.local_active = false }],
    ['unknown current-run request', c => { c.current_run_unknown = true }],
    ['review already saved', c => { c.state.quality = { input_hash: 'old', status: 'issues', findings: [] } }],
    ['unbound pagination', c => { c.state.quality_work = { input_hash: 'other-audit', checkpoint: { steps: {} } } }],
  ]
  for (const [name, mutate] of changes) await t.test(name, () => {
    const context = { ...fixture(), current_run_unknown: false }
    context.state.story = { summary: '完整总结', characters: [], timeline: [], threads: [], ending: { summary: '结局', section_ids: [0] }, uncertainties: [] }
    delete context.state.story_work
    context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
    const quality = { task_key: 'quality:initial' as const, candidate_hash: sourceQualityInputHash(context.state), request_key: 'exact-quality' }
    assert.equal(sourceQualityDispatchAuthorized(context, quality), true)
    mutate(context)
    assert.equal(sourceQualityDispatchAuthorized(context, quality), false)
  })
})
