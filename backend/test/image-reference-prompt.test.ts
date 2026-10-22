import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withImageReferenceMapping } from '@video-studio/shared/visuals/image-reference-prompt'
import type { PromptVisualBinding } from '@video-studio/shared/visuals/visual-prompt'
import type { VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'

const reference = (asset_id: string, view: VisualReferenceSnapshot['view'], purpose: VisualReferenceSnapshot['purpose'], label: string): VisualReferenceSnapshot => ({
  id: `${asset_id}-${view}-${purpose}`, asset_id, view, purpose, label, revision: 1, style_version: 'anime',
})
const binding = (overrides: Partial<PromptVisualBinding> = {}): PromptVisualBinding => ({
  profile_id: 'hero', kind: 'character', name: '姜望', variant: '渡口补网装', revision: 1,
  definition: '不应恢复的旧设定全文', view_requirements: '不应恢复的旧视图要求',
  board_asset_id: 'legacy-board', required: true,
  reference_assets: [reference('face', 'face', 'identity', '面部'), reference('side', 'side', 'costume', '服装侧面')], ...overrides,
})
const rows = (prompt: string) => prompt.split('\n').filter(line => /^参考图 \d+：/.test(line))

test('image references remain explicit even when creator prose has no references, without rebuilding old descriptions', () => {
  const prose = '  \n固定机位，姜望补网。@手写说明和🎣保持原样。\n\t  '
  const result = withImageReferenceMapping(prose, [binding()], ['manual', 'face', 'side'], 'profiles')
  assert.ok(result.startsWith(prose + '\n\n【图片参考图用途】'))
  assert.equal(rows(result).length, 3)
  assert.match(rows(result)[0]!, /^参考图 1：补充参考.*不自动认定/)
  assert.match(rows(result)[1]!, /^参考图 2：姜望（渡口补网装）.*面部特写.*五官/)
  assert.match(rows(result)[2]!, /^参考图 3：姜望（渡口补网装）.*侧面.*服装侧面.*服装款式/)
  assert.doesNotMatch(rows(result)[2]!, /五官/)
  assert.doesNotMatch(result, /不应恢复|legacy-board|参考图 0|参考图 4/)
})

test('mapping tracks actual image order and removal without adding unsubmitted independent or legacy assets', () => {
  const first = withImageReferenceMapping('只生成补网瞬间。', [binding()], ['face', 'side', 'legacy-board'], 'profiles')
  const reordered = withImageReferenceMapping(first, [binding()], ['side', 'face'], 'profiles')
  assert.match(rows(reordered)[0]!, /^参考图 1：姜望.*服装侧面/)
  assert.match(rows(reordered)[1]!, /^参考图 2：姜望.*面部特写/)
  assert.equal(rows(reordered).length, 2)
  const removed = withImageReferenceMapping(reordered, [binding()], ['side'], 'profiles')
  assert.equal(rows(removed).length, 1)
  assert.doesNotMatch(removed, /面部特写|参考图 2|legacy-board/)
  const legacy = withImageReferenceMapping('保持新正文。', [binding()], ['legacy-board'], 'profiles')
  assert.match(rows(legacy)[0]!, /补充参考/)
  assert.doesNotMatch(legacy, /姜望/)
})

test('one image retains all owners, distinct states and independent uses including an owner using a legacy board', () => {
  const first = binding({ reference_assets: [reference('shared', 'face', 'identity', '身份'), reference('shared', 'side', 'costume', '衣服')] })
  const second = binding({ profile_id: 'hero-clean', variant: '日常装', reference_assets: [reference('shared', 'front', 'identity', '另一状态')] })
  const prop = binding({ profile_id: 'needle', kind: 'prop', name: '木网针', variant: '旧木', board_asset_id: 'shared', reference_assets: [] })
  const result = withImageReferenceMapping('按新正文持针。', [first, second, prop], ['shared'], 'profiles')
  assert.equal(rows(result).length, 1)
  assert.match(rows(result)[0]!, /姜望（渡口补网装） \/ 姜望（日常装） \/ 木网针（旧木）/)
  assert.match(rows(result)[0]!, /姜望（渡口补网装）：面部特写（身份），用于.*五官/)
  assert.match(rows(result)[0]!, /姜望（渡口补网装）：侧面（衣服），用于服装款式/)
  assert.match(rows(result)[0]!, /姜望（日常装）：正面（另一状态）/)
  assert.match(rows(result)[0]!, /木网针（旧木）：道具外形、尺度、材质与持握细节/)
})

test('location and prop references retain their selected space, structure and detail purposes', () => {
  const location = binding({ kind: 'location', name: '寒江渡口', variant: '白日', reference_assets: [reference('location', 'layout', 'space', '岸船布局')] })
  const prop = binding({ kind: 'prop', name: '木网针', variant: '', reference_assets: [reference('needle', 'detail', 'detail', '线槽'), reference('needle', 'front', 'structure', '木制结构')] })
  const result = withImageReferenceMapping('按新构图。', [location, prop], ['needle', 'location'], 'profiles')
  assert.match(rows(result)[0]!, /木网针：局部细节（线槽），用于对应对象的局部纹理、连接与持握等细节/)
  assert.match(rows(result)[0]!, /木网针：正面（木制结构），用于对应对象的外形、结构、尺度与材质/)
  assert.match(rows(result)[1]!, /寒江渡口（白日）：空间布局（岸船布局），用于场景空间结构、位置关系/)
})

test('video-only and inactive bindings never assign image ownership', () => {
  const result = withImageReferenceMapping('开镜只有渡口。', [binding({ usage: 'video' }), binding({ usage: 'none' })], ['face'], 'profiles')
  assert.match(rows(result)[0]!, /补充参考/)
  assert.doesNotMatch(result, /姜望|渡口补网装|面部特写/)
})

test('text-only and keyframe mode changes clear stale ownership while mapping each manual image', () => {
  const original = withImageReferenceMapping('保留我的动作和构图。', [binding()], ['face', 'side'], 'profiles')
  for (const mode of ['text_only', 'keyframe']) {
    const result = withImageReferenceMapping(original, [binding()], ['face', 'manual'], mode)
    assert.equal(rows(result).length, 2)
    for (const row of rows(result)) assert.match(row, /补充参考/)
    assert.doesNotMatch(result, /姜望|渡口补网装|面部特写|服装侧面/)
    assert.equal((result.match(/【图片参考图用途】/g) || []).length, 1)
  }
})

test('synchronization is idempotent and removing references recovers all original creator whitespace', () => {
  const prose = '\n\t开镜  姜望补网。\n\n本段空格保留。  \n\n\t'
  const first = withImageReferenceMapping(prose, [binding()], ['face'], 'profiles')
  assert.equal(withImageReferenceMapping(first, [binding()], ['face'], 'profiles'), first)
  assert.equal(withImageReferenceMapping(first, [binding()], [], 'text_only'), prose)
  const suffix = '\n\n  人工追加段落。\t\n'
  const after = withImageReferenceMapping(first + suffix, [binding()], [], 'profiles')
  assert.equal(after, prose + suffix)
})

test('duplicate managed blocks collapse and replaced assets lose the old ownership metadata', () => {
  const prose = '固定机位。'
  const first = withImageReferenceMapping(prose, [binding()], ['face'], 'profiles')
  const duplicate = first + first.slice(prose.length)
  const nextBinding = binding({ reference_assets: [reference('new-face', 'three_quarter', 'identity', '新参考')] })
  const result = withImageReferenceMapping(duplicate, [nextBinding], ['new-face'], 'profiles')
  assert.ok(result.startsWith(prose + '\n\n【图片参考图用途】'))
  assert.equal((result.match(/【图片参考图用途】/g) || []).length, 1)
  assert.match(rows(result)[0]!, /四分之三视角（新参考）/)
  assert.doesNotMatch(result, /面部特写|（面部）|参考图 2/)
})
