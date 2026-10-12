import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactKey, workflowInstruction, workflowRequestForStage, workflowStages, workflowProgress, outlineGenerationIssue, outlineGenerationPrerequisite, exploreStoryDirectionMessage } from '../src/features/script/script-workflow.ts'

test('episode document keys keep separate episodes and project-level outlines distinct', () => {
  const keys = [1, 2, 20].map(episode_number => artifactKey({ artifact_type: 'episode_script', episode_number }))
  assert.equal(new Set(keys).size, 3)
  assert.notEqual(keys[0], artifactKey({ artifact_type: 'episode_outline', episode_number: 1 }))
  assert.equal(artifactKey({ artifact_type: 'outline' }), 'outline:0')
})

test('project buttons after episode one never carry the next episode or its runtime', () => {
  for (const stage of workflowStages.filter(stage => stage !== 'episode')) {
    const request = workflowRequestForStage(stage, 2, 300)
    assert.deepEqual(request, { stage, scope: 'project', episode_number: 0 })
    assert.match(workflowInstruction(request), /整个故事的全剧资料/)
  }
  const episode = workflowRequestForStage('episode', 2, 300)
  assert.deepEqual(episode, { stage: 'episode', scope: 'episode', episode_number: 2, target_duration: 300 })
  assert.match(workflowInstruction(episode), /仅处理第 2 集正文/)
})

test('all workflow buttons preserve confirmed decisions and grant creative discretion inside the selected stage', () => {
  for (const stage of workflowStages) {
    const instruction = workflowInstruction(workflowRequestForStage(stage, 1))
    assert.match(instruction, /沿用我明确交给模型决定后已经作出的具体设定/)
    assert.match(instruction, /不再将这些设定标为待定/)
    assert.match(instruction, /已授权你在该范围内设计尚缺的虚构细节/)
    assert.doesNotMatch(instruction, /其他尚未确定且未授权模型决定的设定标为待定/)
  }
})

test('empty projects and unselected story alternatives do not enable outline generation', () => {
  assert.equal(outlineGenerationIssue({}), outlineGenerationPrerequisite)
  assert.equal(outlineGenerationIssue({}, { input: '  ', brief: '\n', referenceContents: [''] }), outlineGenerationPrerequisite)
  assert.equal(outlineGenerationIssue({}, { input: exploreStoryDirectionMessage, brief: exploreStoryDirectionMessage }), outlineGenerationPrerequisite)
  assert.equal(outlineGenerationIssue({ generation_options: { episode_count: 12 } }), outlineGenerationPrerequisite)
  assert.equal(outlineGenerationIssue({ artifacts: [{ artifact_type: 'outline', content: '未确认候选', status: 'draft' }] }), outlineGenerationPrerequisite)
  assert.equal(outlineGenerationIssue({}, { nextStep: { stage: 'characters', purpose: 'generate' } }), outlineGenerationPrerequisite)
})

test('creator source text, current direction proposals and saved story facts enable outline generation', () => {
  assert.equal(outlineGenerationIssue({}, { input: '退休侦探在故乡追查一封没有寄出的信。' }), null)
  assert.equal(outlineGenerationIssue({}, { brief: '主角追查姐姐失踪的真相。' }), null)
  assert.equal(outlineGenerationIssue({}, { referenceContents: ['主角追查姐姐失踪的真相。'] }), null)
  assert.equal(outlineGenerationIssue({}, { nextStep: { stage: 'outline', purpose: 'generate' } }), null)
  assert.equal(outlineGenerationIssue({ characters: '林晚是记者，追查姐姐的失踪。' }), null)
  assert.equal(outlineGenerationIssue({ artifacts: [{ artifact_type: 'world', content: '主角每次开门都会失去记忆。', status: 'ready' }] }), null)
  assert.equal(outlineGenerationIssue({ generation_options: { core_hook: '已确认核心冲突' } }), null)
})

test('episode redesign keeps the selected episode and requests complete prose, scenes and stable source IDs', () => {
  const request = workflowRequestForStage('episode', 3, 120, 'regenerate')
  assert.deepEqual(request, { stage: 'episode', scope: 'episode', episode_number: 3, target_duration: 120, operation: 'regenerate' })
  const instruction = workflowInstruction(request, '重新设计第 3 集正文')
  assert.match(instruction, /读完本集已保存正文和全部分场/)
  assert.match(instruction, /完整正文及对应分场草稿/)
  assert.match(instruction, /source_scene_id/)
  assert.match(instruction, /仅处理第 3 集正文/)
  assert.match(instruction, /不改动其他集/)
})


test('saving an outline after characters reuses saved characters; drafts and per-episode settings are not global progress', () => {
  const saved = { outline: '修订后的故事', characters: '已确认的人物', artifacts: [
    { artifact_type: 'characters', episode_number: 0, content: '已确认的人物', status: 'ready' },
  ] }
  assert.equal(workflowProgress(saved).next_stage, 'locations')
  assert.equal(workflowProgress({ ...saved, outline: '' }).next_stage, 'outline')
  assert.equal(workflowProgress({ outline: '大纲', characters: '尚未确认', artifacts: [
    { artifact_type: 'characters', content: '未保存草稿', status: 'draft' },
  ] }).next_stage, 'characters')
  assert.equal(workflowProgress({ outline: '大纲', artifacts: [
    { artifact_type: 'characters', episode_number: 2, content: '本集客串', status: 'ready' },
    { artifact_type: 'relationships', content: '关系', status: 'ready' },
  ] }).next_stage, 'characters')
})

test('generic scenes and structure never count as location design; episode recommendations fill gaps and stop at confirmed count', () => {
  const script = { outline: '大纲', characters: '人物', generation_options: { episode_count: 3 }, scenes: [{ episode_number: 1 }, { episode_number: 3 }], artifacts: [
    { artifact_type: 'structure', content: '分段', status: 'ready' },
  ] }
  assert.equal(workflowProgress(script).next_stage, 'locations')
  const prepared = { ...script, artifacts: [...script.artifacts,
    { artifact_type: 'locations', content: '场景', status: 'ready' },
    { artifact_type: 'props', content: '无需关键道具', status: 'edited' },
  ] }
  assert.equal(workflowProgress(prepared).next_stage, 'episode')
  assert.equal(workflowProgress(prepared).next_episode, 2)
  const complete = workflowProgress({ ...prepared, scenes: [...prepared.scenes, { episode_number: 2 }] })
  assert.equal(complete.next_stage, null)
  assert.equal(complete.next_episode, null)
})
