import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactKey, explicitSeriesSpecs, workflowFromMessage } from '../src/script-workflow.ts'

test('explicit requests produce documents while discussion and asset prompts remain conversation', () => {
  assert.deepEqual(workflowFromMessage('开始写第 2 集', 60), { stage: 'episode', episode_number: 2, target_duration: 60 })
  assert.deepEqual(workflowFromMessage('先整理故事大纲'), { stage: 'outline', episode_number: 1 })
  assert.equal(workflowFromMessage('第2集应该怎么写？'), undefined)
  assert.equal(workflowFromMessage('不要生成第2集'), undefined)
  assert.equal(workflowFromMessage('生成角色图片'), undefined)
  assert.equal(workflowFromMessage('生成第201集'), undefined)
})

test('series specifications never confuse an episode number with the total count', () => {
  assert.deepEqual(explicitSeriesSpecs('总共3集，每集约60秒，最后生成第1集'), { episode_count: 3, target_duration: 60 })
  assert.deepEqual(explicitSeriesSpecs('开始写第1集'), {})
  assert.deepEqual(explicitSeriesSpecs('总共900集，每集0秒'), {})
  assert.notEqual(artifactKey({ artifact_type: 'episode_script', episode_number: 1 }), artifactKey({ artifact_type: 'episode_script', episode_number: 2 }))
})
