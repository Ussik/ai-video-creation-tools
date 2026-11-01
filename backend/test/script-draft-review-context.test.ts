import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptDraftReviewContext } from '../src/modules/script/script-draft-review-context.js'

test('review context retains the entire effective manuscript, whole-story understanding and identities while removing duplicated analysis state', () => {
  const content = '开场：第一批十七张签用完，十七个位置也记满。\n' + '完整原文与全部约束。'.repeat(5000) + '\n结局：原稿的确切结局。'
  const source = { project_id: 'project', filename: '故事总纲.md', content, updated_at: '2026-10-23T00:00:00Z', revision: 2,
    source_version: 'effective-v2', source_kind: 'effective', analysis: {
      id: 'analysis', status: 'ready', source_version: 'analysis-v2', sections: [{ summary: content, events: [{ evidence: { quote: content } }] }],
      story: { summary: content }, work: [{ result: content }], story_work: { tasks: [{ result: content }] },
      synthesis: { inputs: [content], outputs: [content] }, quality: { status: 'passed' }, progress: { message: '分析已完成' },
    } }
  const context = { uploaded_script: source, project: { name: '测试', brief: '保留主线与结局' } }
  const before = structuredClone(context)
  const projected = scriptDraftReviewContext(context) as typeof context
  const { analysis: _analysis, ...manuscript } = source
  assert.deepEqual(projected.uploaded_script, { ...manuscript, analysis: { source_version: source.analysis.source_version, story: source.analysis.story } })
  assert.equal(projected.uploaded_script.content, content, 'no summary, slice or character limit may replace the manuscript')
  assert.equal(projected.uploaded_script.analysis.story, source.analysis.story, 'final whole-story understanding accompanies the exact manuscript')
  for (const key of ['id', 'status', 'sections', 'work', 'story_work', 'synthesis', 'quality', 'progress']) {
    assert.equal(Object.hasOwn(projected.uploaded_script.analysis, key), false, `${key} is derived navigation or execution state`)
  }
  assert.ok(JSON.stringify(projected).length < JSON.stringify(context).length / 3, 'derived copies are removed from the model prompt')
  assert.deepEqual(context, before, 'the saved source and analysis must remain untouched')
})

test('review projection preserves all conversation turns, complete documents, references and creative constraints', () => {
  const reference = { id: 'reference', title: '既有设定', content: '真实引用原文。'.repeat(2000) }
  const context = {
    uploaded_script: { content: '完整有效稿' },
    creator_messages: [
      { role: 'assistant', text: '第一项保留十七位容量；第二项保留原结局。' },
      { role: 'user', text: '按第二项处理，第一项也保留。', reference_documents: [reference] },
      { role: 'user', text: '沿用已有处理方案继续。' },
    ],
    saved_documents: Array.from({ length: 9 }, (_, index) => ({ id: `doc-${index}`, title: `完整文档${index}`, content: `第${index}份文档完整原文。`.repeat(400) })),
    confirmed_decisions: [{ topic: '容量', content: '十七个位置已满', source_text: '原始用户决定' }],
    resolved_findings: { decisions: [{ id: 'known', answer: '保留原结局', decision: '不得增补名单容量' }], summaries: [{ id: 'summary', text: '处理说明' }] },
    requested_settings: { episode_count: 60 }, current_settings: { episode_count: 60 }, task_scope: { stage: 'outline' },
    future_constraint: { text: '不得删除尚未识别的顶层创作约束' },
  }
  const before = structuredClone(context)
  const projected = scriptDraftReviewContext(context) as typeof context
  assert.deepEqual(projected, before)
  for (const key of ['creator_messages', 'saved_documents', 'confirmed_decisions', 'resolved_findings', 'future_constraint'] as const) {
    assert.equal(projected[key], context[key], `${key} is neither rewritten nor truncated`)
  }
  assert.deepEqual(context, before)
})

test('analysis progress cannot invalidate review input while final whole-story understanding, its source version and source edits still do', () => {
  const context = { source_version: 'formal-version', uploaded_script: { filename: '原稿.txt', content: '同一完整原文',
    updated_at: 'same-source', analysis: { source_version: 'story-version', story: { summary: '全剧结局必须保留' }, status: 'running', progress: { message: '旧进度' } } } }
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(scriptDraftReviewContext(value))).digest('hex')
  const original = hash(context)
  assert.equal(hash({ ...context, uploaded_script: { ...context.uploaded_script, analysis: { ...context.uploaded_script.analysis,
    status: 'ready', work: ['缓存正文'], updated_at: 'new-analysis' } } }), original)
  assert.notEqual(hash({ ...context, uploaded_script: { ...context.uploaded_script, analysis: { ...context.uploaded_script.analysis,
    story: { summary: '全剧补全后的结局事实' } } } }), original)
  assert.notEqual(hash({ ...context, uploaded_script: { ...context.uploaded_script, analysis: { ...context.uploaded_script.analysis,
    source_version: 'new-story-version' } } }), original)
  assert.notEqual(hash({ ...context, uploaded_script: { ...context.uploaded_script, content: '真实改写后的完整原文' } }), original)
  assert.notEqual(hash({ ...context, uploaded_script: { ...context.uploaded_script, updated_at: 'new-source' } }), original)
  assert.notEqual(hash({ ...context, source_version: 'new-formal-version' }), original)
})

test('analysis without a final story or its source version contributes no navigation or execution state', () => {
  const context = { uploaded_script: { content: '完整原文', analysis: { status: 'running', sections: ['目录与重复引文'], work: ['可恢复运行态'] } } }
  assert.deepEqual(scriptDraftReviewContext(context), { uploaded_script: { content: context.uploaded_script.content } })
})

test('contexts without a recognizable uploaded manuscript pass through intact', () => {
  for (const context of [undefined, null, 'context', [], {}, { uploaded_script: null },
    { uploaded_script: { analysis: { story: 'unknown shape must not be discarded' } } }]) {
    assert.equal(scriptDraftReviewContext(context), context)
  }
})
