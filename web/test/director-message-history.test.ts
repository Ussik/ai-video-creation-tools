import assert from 'node:assert/strict'
import test from 'node:test'
import { isSupersededDirectorDraft, isSupersededDirectorFailure } from '../src/features/script/director-message-history'

const script = {
  artifacts: [
    { artifact_type: 'outline', content: '已保存大纲', status: 'ready' },
    { artifact_type: 'characters', content: '已保存人物', status: 'ready' },
    { artifact_type: 'locations', content: '已保存场景', status: 'ready' },
    { artifact_type: 'props', content: '已保存道具', status: 'ready' },
    { artifact_type: 'episode_script', episode_number: 1, content: '第一集正文', status: 'ready' },
  ],
  generation_options: { episode_count: 3 },
}

const failure = (stage: 'outline' | 'characters' | 'locations' | 'props' | 'episode', episode_number = 0) => ({
  role: 'assistant' as const, failed: true, execution: { outcome: { kind: 'failed' }, workflow: { stage, episode_number } },
})

test('saved project stages turn their earlier failures into history', () => {
  assert.equal(isSupersededDirectorFailure(failure('props'), script), true)
  assert.equal(isSupersededDirectorFailure(failure('episode', 1), script), true)
})

test('unsaved stages and unrelated replies remain current failures', () => {
  assert.equal(isSupersededDirectorFailure(failure('episode', 2), script), false)
  assert.equal(isSupersededDirectorFailure({ role: 'assistant', failed: true, execution: { outcome: { kind: 'failed' } } }, script), false)
})

test('legacy failures infer a unique saved stage from activity labels', () => {
  assert.equal(isSupersededDirectorFailure({ role: 'assistant', failed: true,
    execution: { title: '生成阶段草稿' }, activity: [{ label: '编写道具清单', summary: '整理道具' }] }, script), true)
  assert.equal(isSupersededDirectorFailure({ role: 'assistant', failed: true,
    execution: { title: '生成阶段草稿' }, activity: [{ label: '处理中', summary: '模型调用失败' }] }, script), false)
  assert.equal(isSupersededDirectorFailure({ role: 'assistant', failed: true,
    execution: { title: '第10集生成中断' } }, { ...script, artifacts: [...script.artifacts, { artifact_type: 'episode_script', episode_number: 10, content: '第十集正文', status: 'ready' }] }), true)
})

test('saved workflow drafts can be projected to saved after a remount', () => {
  assert.equal(isSupersededDirectorDraft({ role: 'assistant', execution: {
    outcome: { kind: 'draft' }, workflow: { stage: 'episode', episode_number: 1 },
  } }, script), true)
  assert.equal(isSupersededDirectorDraft({ role: 'assistant', execution: {
    outcome: { kind: 'draft' }, workflow: { stage: 'episode', episode_number: 2 },
  } }, script), false)
})
