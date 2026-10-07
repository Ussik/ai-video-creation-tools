import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactKey, workflowInstruction, workflowRequestForStage, workflowStages } from '../src/script-workflow.ts'

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

test('all workflow buttons preserve concrete decisions delegated to the model and distinguish other unknowns', () => {
  for (const stage of workflowStages) {
    const instruction = workflowInstruction(workflowRequestForStage(stage, 1))
    assert.match(instruction, /沿用我明确交给模型决定后已经作出的具体设定/)
    assert.match(instruction, /不再将这些设定标为待定/)
    assert.match(instruction, /其他尚未确定且未授权模型决定的设定标为待定/)
  }
})
