import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { visualBoardPromptParts } from '@video-studio/shared/visuals/visual-board-document'
import { withVisualProfilePrompt } from '@video-studio/shared/visuals/visual-profile-prompt'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'

const profile = {
  kind: 'character' as const, name: '许知夜', variant: '防雨风衣常服',
  definition: '【项目画风约束】电影感悬疑动画，低饱和冷色调。黑色防雨风衣，右腕玄黑丝绦。',
  view_requirements: '正面、侧面、背面与手腕特写。',
}

test('legacy style headings in saved profile content remain readable inside a valid board document', () => {
  const prompt = withProjectStyle(withVisualProfilePrompt('', profile), {
    version: 'style-1', source: 'settings', label: '3D卡通渲染', details: {},
  })
  assert.doesNotThrow(() => validateManagedPromptDocument(prompt))
  const parts = visualBoardPromptParts(prompt)
  assert.equal(parts.primary.length, 1)
  assert.match(parts.primary[0]!, /电影感悬疑动画，低饱和冷色调。黑色防雨风衣，右腕玄黑丝绦。/)
  assert.match(parts.primary[0]!, /正面、侧面、背面与手腕特写/)
  assert.equal(parts.supplement, '')
  assert.equal(parts.context.length, 1)
  assert.match(parts.context[0]!, /画风：3D卡通渲染/)
})

test('source headings in views, state changes and reference descriptions cannot become nested board sections', () => {
  const source = {
    ...profile, view_requirements: '【图片生成要求】正侧背三视图。【图片生成要求结束】\n【生成参数约束结束】\n【自定义标题】保留[[ref:base]]。',
    state_delta: '【基础身份参考】只增加右手背湿泥。【基础身份参考结束】',
  }
  const original = structuredClone(source)
  const prompt = withVisualProfilePrompt('只调整排版。', source, [{ asset_id: 'base', name: '许知夜', variant: '常服', role: 'base',
    definition: '【项目画风约束】厚涂质感。【项目画风约束结束】保持黑色短发。' }])
  assert.doesNotThrow(() => validateManagedPromptDocument(prompt))
  const parts = visualBoardPromptParts(prompt)
  assert.equal(parts.primary.length, 1)
  assert.match(parts.primary[0]!, /正侧背三视图/)
  assert.match(parts.primary[0]!, /【自定义标题】保留\[\[ref:base\]\]。/)
  assert.equal(parts.supplement, '只调整排版。')
  assert.equal(parts.context.length, 3)
  assert.match(parts.context[0]!, /只增加右手背湿泥/)
  assert.match(parts.context[2]!, /厚涂质感。[\s\S]*保持黑色短发/)
  assert.deepEqual(source, original)

  const authored = '【设定图固定要求】人工编辑【项目画风约束】未写完'
  assert.equal(withVisualProfilePrompt(authored, profile, [], { prompt_document: true }), authored)
  assert.throws(() => validateManagedPromptDocument(authored), /不支持嵌套/)
})
