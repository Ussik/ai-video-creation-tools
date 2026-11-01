import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactKey, workflowInstruction, workflowRequestForStage, workflowRequestSnapshot, workflowStages, workflowProgress, outlineGenerationIssue, outlineGenerationPrerequisite, exploreStoryDirectionMessage } from '../src/features/script/script-workflow.ts'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

test('episode document keys keep separate episodes and project-level outlines distinct', () => {
  const keys = [1, 2, 20].map(episode_number => artifactKey({ artifact_type: 'episode_script', episode_number }))
  assert.equal(new Set(keys).size, 3)
  assert.notEqual(keys[0], artifactKey({ artifact_type: 'episode_outline', episode_number: 1 }))
  assert.equal(artifactKey({ artifact_type: 'outline' }), 'outline:0')
})

test('project buttons after episode one never carry the next episode or its runtime', () => {
  for (const stage of workflowStages.filter(stage => stage !== 'episode')) {
    const request = workflowRequestForStage(stage, 2, 300)
    assert.deepEqual(request, { stage, scope: 'project', episode_number: 0,
      ...(stage === 'outline' ? { intent: 'stage_design', artifact_types: ['outline'] } : {}) })
    assert.match(workflowInstruction(request), /整个故事的全剧资料/)
  }
  const episode = workflowRequestForStage('episode', 2, 300)
  assert.deepEqual(episode, { stage: 'episode', scope: 'episode', episode_number: 2, target_duration: 300 })
  assert.match(workflowInstruction(episode), /仅处理第 2 集正文/)
})

test('uploaded source outline buttons declare one faithful deliverable and never authorize invented answers', () => {
  const request = workflowRequestForStage('outline', 8, 120, undefined, { hasSource: true })
  assert.deepEqual(request, { stage: 'outline', scope: 'project', episode_number: 0, intent: 'source_outline', artifact_types: ['outline'] })
  const instruction = workflowInstruction(request, '生成故事大纲')
  assert.match(instruction, /本次只交付：概要设计/)
  assert.match(instruction, /依据完整原稿整理故事大纲/)
  assert.match(instruction, /允许开放结局和未揭示信息/)
  assert.match(instruction, /不新增原稿未明确的谜底、能力代价或后续剧情/)
  assert.match(instruction, /文风建议和后续深化不阻断/)
  assert.doesNotMatch(instruction, /本阶段完整包含|钩子预设|伏笔与回收|分集大纲|已授权你在该范围内设计尚缺的虚构细节|不再将这些设定标为待定/)
  assert.deepEqual(workflowRequestForStage('outline', 1, undefined, undefined, { hasSource: true }), request,
    'a label or chat keywords cannot expand the declared task')
})

test('ordinary new story outlines stay focused and only an explicit complete design selects all nine deliverables', () => {
  const ordinary = workflowRequestForStage('outline', 1)
  assert.deepEqual(ordinary.artifact_types, ['outline']); assert.equal(ordinary.intent, 'stage_design')
  assert.doesNotMatch(workflowInstruction(ordinary), /本阶段完整包含|本次只交付：[^\n]*分集大纲/)
  const complete = workflowRequestForStage('outline', 1, undefined, undefined, { hasSource: true, intent: 'stage_design' })
  assert.deepEqual(complete.artifact_types, [...scriptStageArtifacts.outline]); assert.equal(complete.intent, 'stage_design')
  assert.match(workflowInstruction(complete), /本次只交付：概要设计、故事简述、背景设定、全剧分段、钩子预设、伏笔与回收、反转预设、创作禁区、分集大纲/)
  const selected = workflowRequestForStage('outline', 1, undefined, undefined, { intent: 'stage_design', artifact_types: ['world', 'constraints'] })
  assert.match(workflowInstruction(selected), /本次只交付：背景设定、创作禁区/)
  assert.deepEqual(selected.artifact_types, ['world', 'constraints'])
})

test('restoring a candidate preserves its declared task and never retrofits new-task defaults onto history', () => {
  const request = { ...workflowRequestForStage('outline', 1, undefined, undefined, { hasSource: true }), target_duration: 120 }
  const before = structuredClone(request)
  const restored = workflowRequestSnapshot(request)
  assert.deepEqual(restored, { stage: 'outline', scope: 'project', episode_number: 0, intent: 'source_outline', artifact_types: ['outline'] })
  assert.notEqual(restored.artifact_types, request.artifact_types)
  assert.deepEqual(request, before)
  assert.deepEqual(workflowRequestSnapshot({ stage: 'outline', episode_number: 9, target_duration: 120 }),
    { stage: 'outline', scope: 'project', episode_number: 0 }, 'historical full-stage drafts keep their absent contract')
  const complete = workflowRequestForStage('outline', 1, undefined, undefined, { intent: 'stage_design' })
  assert.deepEqual(workflowRequestSnapshot(complete), complete)
  const supplement = workflowRequestForStage('outline', 1, undefined, 'supplement', { hasSource: true })
  assert.equal(supplement.intent, undefined); assert.equal(supplement.artifact_types, undefined)
  assert.match(workflowInstruction(supplement), /只补齐缺失栏目/)
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

test('supplement declares only currently missing saved sections and filters stale requested sections', () => {
  const script = { outline: '已保存概要，保持原样', artifacts: [{ artifact_type: 'hooks', content: '已保存钩子', status: 'ready' }] }
  const request = workflowRequestForStage('outline', 1, undefined, 'supplement', { script, hasSource: true })
  assert.equal(request.intent, 'stage_design')
  assert.deepEqual(request.artifact_types, scriptStageArtifacts.outline.filter(type => !['outline', 'hooks'].includes(type)))
  assert.match(workflowInstruction(request), /原样保留其标题和正文，只补齐缺失栏目/)
  const selected = workflowRequestForStage('outline', 1, undefined, 'supplement', { script, artifact_types: ['hooks', 'world'] })
  assert.deepEqual(selected.artifact_types, ['world'])
  assert.match(workflowInstruction(selected), /本次只交付：背景设定/)
  assert.doesNotMatch(workflowInstruction(selected), /本次只交付：[^\n]*钩子预设/)
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
