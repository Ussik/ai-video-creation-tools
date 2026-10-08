import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directorStageContext, type DirectorStageContext, type DirectorInteraction } from '../src/script-workflow'
import { activeReplyChoice, classificationBatch, episodePreparationAction, latestReplyNeedsRecognition,
  replyDisplayText, replyWorkflowAction, replyClassificationVersion, type ClassifiableMessage } from '../src/script-reply'

const outline = directorStageContext({})
const draft = (stage: DirectorInteraction['stage'], purpose: DirectorInteraction['purpose'] = 'setting', episode_number?: number): DirectorInteraction =>
  ({ stage, purpose, ...(episode_number ? { episode_number } : {}) })
function question(interaction?: DirectorInteraction): ClassifiableMessage {
  return { id: 'question', role: 'assistant', stage_context: outline, text: JSON.stringify({ kind: 'confirmation',
    question: '主角寻找失踪的姐姐，作为故事主线可以吗？', interaction, intro: '完整的主线说明', trailing: '确认后整理大纲。' }) }
}
function action(interaction: DirectorInteraction, context: DirectorStageContext = outline): ClassifiableMessage {
  return { id: 'action', role: 'assistant', stage_context: context, text: JSON.stringify({ kind: 'workflow_action', interaction, intro: '可整理当前阶段草稿。' }) }
}

test('outline questions about protagonists remain usable while full character/location/episode work is blocked', () => {
  assert.ok(activeReplyChoice([question(draft('outline'))], {}, null, outline))
  for (const stage of ['characters', 'locations', 'props', 'episode'] as const) {
    assert.equal(activeReplyChoice([question(draft(stage, 'setting', stage === 'episode' ? 1 : undefined))], {}, null, outline), null)
    assert.equal(replyWorkflowAction([action(draft(stage, 'generate', stage === 'episode' ? 1 : undefined))], outline), null)
  }
  assert.equal(replyWorkflowAction([action(draft('outline', 'generate'))], outline)?.stage, 'outline')
})

test('document confirmations become explicit generation actions instead of setting agree/skip controls', () => {
  const generate = question(draft('outline', 'generate'))
  assert.equal(activeReplyChoice([generate], {}, null, outline), null)
  assert.deepEqual(replyWorkflowAction([generate], outline), draft('outline', 'generate'))
  assert.equal(replyWorkflowAction([action(draft('outline', 'revise'))], outline), null)
  assert.equal(replyDisplayText(action(draft('outline', 'generate'))), '可整理当前阶段草稿。')
  const classified: ClassifiableMessage = { id: 'natural', role: 'assistant', text: '是否开始生成人物设定？',
    classification_version: replyClassificationVersion, classification: { type: 'workflow_action', interaction: draft('characters', 'generate') } }
  assert.equal(replyWorkflowAction([classified], outline), null)
  assert.equal(activeReplyChoice([classified], {}, null, outline), null)
})

test('recognized prose and typed replies share stage gates; missing legacy tags are recognized before buttons appear', () => {
  const old = question()
  assert.equal(latestReplyNeedsRecognition([old], true), true)
  assert.equal(classificationBatch([old], new Set(), undefined, true).length, 1)
  assert.equal(activeReplyChoice([old], {}, null, outline), null)
  const untaggedCache: ClassifiableMessage = { ...old, text: '是否接受主线？', classification_version: replyClassificationVersion,
    classification_context: '[]', classification: { type: 'confirmation_request', status: 'pending', question: '是否接受主线？' } }
  assert.equal(latestReplyNeedsRecognition([untaggedCache], true), true)
  assert.equal(classificationBatch([untaggedCache], new Set(), undefined, true).length, 1)
  const recognized: ClassifiableMessage = { ...old, classification_version: replyClassificationVersion, classification_context: '[]',
    classification: { type: 'confirmation_request', status: 'pending', question: '接受主线？', interaction: draft('outline') } }
  assert.equal(latestReplyNeedsRecognition([recognized], true), false)
  assert.equal(activeReplyChoice([recognized], {}, null, outline)?.choice.intro, '完整的主线说明')
  assert.equal(activeReplyChoice([{ ...recognized, classification: { ...recognized.classification, interaction: draft('props') } } as ClassifiableMessage], {}, null, outline), null)
  const direct = question(draft('outline'))
  assert.equal(classificationBatch([direct], new Set(), undefined, true).length, 0)
  assert.equal(classificationBatch([direct], new Set(), direct.id, true).length, 1, 'explicit recognition can correct bad direct metadata')
  assert.equal(replyWorkflowAction([{ ...action(draft('outline', 'generate')), classification_version: replyClassificationVersion,
    classification: { type: 'other' } }], outline), null, 'explicit negative recognition overrides a direct action')
})

test('mixed question sets retain current-stage settings without exposing unrelated stage or document choices', () => {
  const group: ClassifiableMessage = { id: 'mixed', role: 'assistant', stage_context: outline, text: JSON.stringify({ kind: 'question_set', question: '主线与下一步', questions: [
    { id: 'plot', kind: 'confirmation', question: '寻找姐姐作为主线？', interaction: draft('outline') },
    { id: 'wardrobe', kind: 'input_request', question: '完整服装档案？', fields: [{ id: 'clothing', label: '服装' }], interaction: draft('characters') },
    { id: 'generate', kind: 'confirmation', question: '生成大纲？', interaction: draft('outline', 'generate') },
  ] }) }
  const active = activeReplyChoice([group], {}, null, outline)!
  assert.equal(active.choice.question, '寻找姐姐作为主线？')
  assert.equal(active.choice.questions, undefined)
  assert.equal(replyWorkflowAction([group], outline)?.stage, 'outline')
  assert.equal(activeReplyChoice([group], { mixed: true }, null, outline), null)
})

test('unsaved drafts never advance and saves remove stale controls and reuse out-of-order saved characters', () => {
  const preexisting = { characters: '已确认人物' }
  const before = directorStageContext(preexisting)
  const old = { ...action(draft('outline', 'generate')), stage_context: before }
  const review = directorStageContext(preexisting, { pending: { stage: 'outline', episode_number: 0 } })
  assert.equal(review.stage, 'outline')
  assert.equal(replyWorkflowAction([old], review), null)
  assert.ok(activeReplyChoice([{ ...question(draft('outline')), stage_context: before }], {}, null, review))
  const saved = { ...preexisting, outline: '已保存大纲' }
  const after = directorStageContext(saved)
  assert.equal(after.stage, 'locations')
  assert.equal(replyWorkflowAction([old], after), null)
  assert.equal(activeReplyChoice([{ ...question(draft('outline')), stage_context: before }], {}, null, after), null)
})

test('explicit editing and jumping survives reload/answers but expires on new saved-stage progress', () => {
  const script = { outline: '大纲' }
  const editing = directorStageContext(script, { explicit: { stage: 'outline', episode_number: 0 } })
  const restored = JSON.parse(JSON.stringify(editing)) as DirectorStageContext
  const continued = directorStageContext(script, { previous: restored })
  assert.deepEqual(continued, editing)
  assert.equal(replyWorkflowAction([action(draft('outline', 'revise'), editing)], continued)?.purpose, 'revise')
  const saved = directorStageContext({ ...script, characters: '人物' }, { previous: restored })
  assert.equal(saved.mode, 'default')
  assert.equal(saved.stage, 'locations')
  const episode = directorStageContext({}, { explicit: { stage: 'episode', episode_number: 3 } })
  const message: ClassifiableMessage = { id: 'ready', role: 'assistant', text: '第三集节奏准备完毕', stage_context: episode,
    classification_version: replyClassificationVersion, classification: { type: 'episode_preparation', episode_number: 3 } }
  assert.equal(episodePreparationAction([message], episode)?.episode_number, 3)
  assert.equal(episodePreparationAction([message], outline), null)
  assert.equal(episodePreparationAction([{ ...message, classification: { type: 'episode_preparation', episode_number: 4 } }], episode), null)
})
