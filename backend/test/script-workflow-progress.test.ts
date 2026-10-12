import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workflowProgress, workflowGuidance } from '../src/modules/script/script-workflow.js'
import { workflowProgress as frontendProgress } from '../../web/src/features/script/script-workflow.ts'

test('backend and frontend recommendations agree across saved, draft, out-of-order and gapped projects', () => {
  const globalArtifacts = ['outline', 'characters', 'locations', 'props'].map(artifact_type => ({ artifact_type, content: artifact_type, status: 'ready', episode_number: 0 }))
  const cases = [
    {}, { characters: '先确认的人物' }, { outline: '大纲', characters: '人物' },
    { artifacts: globalArtifacts.slice(1) }, { artifacts: globalArtifacts, generation_options: { episode_count: 3 }, scenes: [{ episode_number: 1 }, { episode_number: 3 }] },
    { artifacts: globalArtifacts, generation_options: { episode_count: 1 }, scenes: [{ episode_number: 1 }] },
    { outline: '大纲', characters: '草稿', artifacts: [{ artifact_type: 'characters', content: '未确认', status: 'draft' }] },
    { outline: '大纲', artifacts: [{ artifact_type: 'characters', content: '本集', episode_number: 2, status: 'ready' }] },
    { outline: '大纲', characters: '人物', artifacts: [{ artifact_type: 'structure', content: '全剧分段', status: 'ready' }], scenes: [{ episode_number: 1 }] },
  ]
  for (const input of cases) assert.deepEqual(workflowProgress(input), frontendProgress(input))
  const script = { artifacts: globalArtifacts.filter(item => item.artifact_type !== 'locations') }
  assert.equal(workflowProgress(script).next_stage, 'locations')
  assert.match(workflowGuidance(script), /推荐下一步：全剧场景设计/)
  assert.match(workflowGuidance(script), /已保存全剧资料：全剧故事大纲、全剧人物设定、全剧道具设计/)
  assert.match(workflowGuidance(script), /大纲更新不自动使人物\/场景\/道具失效/)
  assert.match(workflowGuidance(script), /未保存阶段必须依次生成并确认保存/)
})
