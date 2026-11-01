import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScriptToolProgress } from '../src/modules/script/script-tool-progress.js'

const failed = (length = 20000) => ({ name: 'read_documents', arguments: { document_ids: ['a'], length }, ok: false,
  error: { code: 'read_too_large', message: '读取过长' }, state: { text: '稿件' } })
const page = (offset: number, next_offset: number, extra: Record<string, unknown> = {}) => ({ name: 'read_documents',
  arguments: { document_ids: ['a'], offset, length: next_offset - offset }, ok: true,
  result: { documents: [{ id: 'a', source: 'draft', version: 'a-v1', offset, next_offset, content: '重复段落', ...extra }] } })

test('repeated identical failures receive a repair warning and then stop without a total request quota', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  assert.equal(guard.observe(failed()).action, 'continue')
  const warning = guard.observe(failed())
  assert.equal(warning.action, 'warn')
  assert.match(warning.instruction!, /改变具体失败参数/)
  const stop = guard.observe(failed())
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'repeated_failure')
  assert.match(stop.message!, /保留当前草稿/)
})

test('object property order and minted draft versions cannot disguise repeated failed arguments', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  guard.observe({ ...failed(), arguments: { length: 20000, document_ids: ['a'], version: 'v1' } })
  guard.observe({ ...failed(), arguments: { document_ids: ['a'], version: 'v2', length: 20000 }, error: { code: 'read_too_large', message: '措辞变化' } })
  assert.equal(guard.observe({ ...failed(), arguments: { version: 'v3', length: 20000, document_ids: ['a'] } }).reason, 'repeated_failure')
})

test('a smaller successful read is progress and clears the prior identical failure streak', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  guard.observe(failed()); guard.observe(failed())
  assert.equal(guard.observe(page(0, 1000)).action, 'continue')
  assert.equal(guard.observe(failed()).action, 'continue')
})

test('changing failed arguments without gaining evidence does not evade the no-progress guard', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe(failed(20000 - index)).action, 'stop')
  const stop = guard.observe(failed(20000))
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'no_progress')
})

test('forty newly covered pages proceed even when every page has identical prose', () => {
  const guard = createScriptToolProgress()
  for (let index = 0; index < 40; index++) assert.equal(guard.observe(page(index * 100, index * 100 + 100)).action, 'continue')
})

test('overlapping reads count only newly covered ranges rather than changing arguments', () => {
  const guard = createScriptToolProgress()
  guard.observe(page(0, 1000)); guard.observe(page(900, 1100))
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe(page(index, 900 - index)).action, 'stop')
  const stop = guard.observe(page(400, 600))
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'no_progress')
})

test('a document version change makes its current text new evidence', () => {
  const guard = createScriptToolProgress()
  guard.observe(page(0, 1000))
  for (let index = 0; index < 4; index++) guard.observe(page(0, 1000))
  assert.equal(guard.observe(page(0, 1000, { version: 'a-v2', content: '修订正文' })).action, 'continue')
})

test('new read ranges remain learned when the caller state advances at the same time', () => {
  const guard = createScriptToolProgress({ state: { covered: 0 } })
  guard.observe({ ...page(0, 1000), state: { covered: 1000 } })
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe({ ...page(0, 1000), state: { covered: 1000 } }).action, 'stop')
  assert.equal(guard.observe({ ...page(0, 1000), state: { covered: 1000 } }).action, 'stop')
})

test('a real draft edit permits a new consistency pass over seven unchanged documents without allowing repeated ranges forever', () => {
  const guard = createScriptToolProgress({ draftState: { content: '原稿' } })
  const unchanged = (id: number) => ({ name: 'read_documents', ok: true, result: { documents: [{ id: `unchanged-${id}`, version: 'stable-version',
    source: 'draft', offset: 0, next_offset: 100, content: '没有改动的关联文档' }] } })
  for (let index = 0; index < 7; index++) assert.equal(guard.observe({ ...unchanged(index), draftState: { content: '原稿' } }).action, 'continue')
  assert.equal(guard.observe({ name: 'propose_document_patch', ok: true, draftState: { content: '实际修订稿' } }).action, 'continue')
  for (let index = 0; index < 7; index++) assert.equal(guard.observe({ ...unchanged(index), draftState: { content: '实际修订稿' } }).action, 'continue')
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe({ ...unchanged(6), draftState: { content: '实际修订稿' } }).action, 'stop')
  assert.equal(guard.observe({ ...unchanged(6), draftState: { content: '实际修订稿' } }).action, 'stop')
})

test('context reads changing timestamps and summaries do not evade stagnation', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  for (let index = 0; index < 5; index++) {
    assert.notEqual(guard.observe({ name: 'get_creation_state', ok: true, state: { text: '稿件' }, result: {
      version: `v${index}`, updated_at: `时刻${index}`, summary: `措辞${index}`, task: { status: 'in_progress', reviewed: 0 },
    } }).action, 'stop')
  }
  assert.equal(guard.observe({ name: 'get_creation_state', ok: true, state: { text: '稿件' },
    result: { version: 'v6', updated_at: '现在', summary: '仍在处理', task: { status: 'in_progress', reviewed: 0 } } }).action, 'stop')
})

test('genuine draft edits and completed review results permit long work', () => {
  const guard = createScriptToolProgress({ state: { content: '原稿', reviewed: 0 }, draftState: { content: '原稿', reviewed: 0 } })
  for (let index = 1; index <= 40; index++) {
    const state = { content: `第${index}处已修订`, reviewed: index }
    assert.equal(guard.observe({ name: 'review_revision_batch', ok: true, state, draftState: state }).action, 'continue')
  }
})

test('minting a draft version or a new summary for a no-op write is not progress', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe({ name: 'manage_document_draft', arguments: { operation: 'update' },
    ok: true, state: { text: '稿件' }, result: { version: `v${index}`, summary: `第${index}次修订` } }).action, 'stop')
  assert.equal(guard.observe({ name: 'manage_document_draft', arguments: { operation: 'update' }, ok: true, state: { text: '稿件' },
    result: { version: 'v5', summary: '继续修订' } }).action, 'stop')
})

test('rereading changed operation counters and assessment wording cannot disguise alternating no-op writes', () => {
  for (const name of ['get_creation_state', 'manage_revision_task', 'manage_document_draft']) {
    const state = { text: '稿件', reviewed: 0 }, guard = createScriptToolProgress({ state })
    let decision: ReturnType<typeof guard.observe> | undefined
    for (let index = 0; index < 5; index++) {
      guard.observe({ name: 'propose_document_patch', ok: true, state })
      decision = guard.observe({ name, arguments: { operation: 'read' }, ok: true, state, result: {
        task: { batches: index, documents: [{ id: 'a', assessment: { conclusion: 'needs_change', explanation: `第${index}次解释` } }] },
        replacements: [{ find: '稿件', replace: '稿件', reason: `第${index}次提交理由` }],
        notes: `不同备注 ${index}`, reading_progress: [{ id: 'a', next_offset: 100, complete: true }],
      } })
      if (decision.action === 'stop') break
    }
    assert.equal(decision?.action, 'stop', name)
    assert.equal(decision?.reason, 'no_progress', name)
  }
})

test('A to B to A stops even if reread coverage keeps changing', () => {
  const guard = createScriptToolProgress({ state: { content: '甲', read: 0 }, draftState: { content: '甲', reviewed: false } })
  guard.observe({ name: 'manage_document_draft', ok: true, state: { content: '乙', read: 100 }, draftState: { content: '乙', reviewed: false } })
  const stop = guard.observe({ name: 'manage_document_draft', ok: true, state: { content: '甲', read: 200 }, draftState: { content: '甲', reviewed: false } })
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'draft_cycle')
})

test('returning to the same text with newly completed review is legitimate semantic progress', () => {
  const guard = createScriptToolProgress({ draftState: { content: '甲', reviewed: false } })
  guard.observe({ name: 'manage_document_draft', ok: true, draftState: { content: '乙', reviewed: false } })
  assert.equal(guard.observe({ name: 'review_revision_batch', ok: true, draftState: { content: '甲', reviewed: true } }).action, 'continue')
})

test('empty final responses stop after the repair instruction fails to produce progress', () => {
  const guard = createScriptToolProgress({ state: { text: '稿件' } })
  assert.equal(guard.finish({ state: { text: '稿件' }, text: '' }).action, 'warn')
  const stop = guard.finish({ state: { text: '稿件' }, text: '  ' })
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'empty_response')
})

test('rewording a premature final response cannot restart the incomplete loop', () => {
  const guard = createScriptToolProgress({ state: { reviewed: 0 } })
  assert.equal(guard.finish({ text: '我会继续修订。' }).action, 'warn')
  const stop = guard.finish({ text: '下一步继续处理。' })
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'incomplete_response')
})

test('real progress after a premature response grants another completion attempt', () => {
  const guard = createScriptToolProgress({ state: { reviewed: 0 } })
  guard.finish({ text: '继续处理' })
  assert.equal(guard.observe({ name: 'review_revision_batch', ok: true, state: { reviewed: 1 } }).action, 'continue')
  assert.equal(guard.finish({ state: { reviewed: 1 }, text: '还有剩余文档' }).action, 'warn')
})

test('serialized history preserves failure streaks and ranges without retaining manuscript text', () => {
  const guard = createScriptToolProgress({ state: { text: '私密稿件正文' } })
  guard.observe(page(0, 1000)); guard.observe(failed()); guard.observe(failed())
  const serialized = JSON.stringify(guard.snapshot())
  assert.doesNotMatch(serialized, /私密稿件正文|重复段落/)
  const restored = createScriptToolProgress({ history: JSON.parse(serialized) })
  assert.equal(restored.observe(failed()).reason, 'repeated_failure')
  assert.equal(restored.observe(page(1000, 2000)).action, 'continue')
})

test('scene and source paging count new evidence and repeated pages do not', () => {
  const guard = createScriptToolProgress()
  for (let index = 0; index < 25; index++) {
    assert.equal(guard.observe({ name: 'read_source_document', ok: true, result: { source_version: 'source-v1', offset: index * 10, next_offset: index * 10 + 10 } }).action, 'continue')
    assert.equal(guard.observe({ name: 'read_episode_scenes', ok: true, result: { scenes: [{ id: `scene-${index}`, version: 'v1', action: '相同动作' }] } }).action, 'continue')
  }
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe({ name: 'read_episode_scenes', ok: true, result: { scenes: [{ id: 'scene-24', version: 'v1', action: '相同动作' }] } }).action, 'stop')
  assert.equal(guard.observe({ name: 'read_episode_scenes', ok: true, result: { scenes: [{ id: 'scene-24', version: 'v1', action: '相同动作' }] } }).action, 'stop')
})

test('new scene fragments advance even after document text has been read completely', () => {
  const guard = createScriptToolProgress()
  for (let index = 0; index < 40; index++) assert.equal(guard.observe(page(1000, 1000, {
    scene_fragments: [{ id: 'long-scene', version: 'scene-v1', offset: index * 100, next_offset: (index + 1) * 100, serialized_scene_fragment: '场次片段' }],
  })).action, 'continue')
  for (let index = 0; index < 4; index++) assert.notEqual(guard.observe(page(1000, 1000, {
    scene_fragments: [{ id: 'long-scene', version: 'scene-v1', offset: 3900, next_offset: 4000, serialized_scene_fragment: '场次片段' }],
  })).action, 'stop')
  assert.equal(guard.observe(page(1000, 1000, {
    scene_fragments: [{ id: 'long-scene', version: 'scene-v1', offset: 3900, next_offset: 4000, serialized_scene_fragment: '场次片段' }],
  })).action, 'stop')
})
