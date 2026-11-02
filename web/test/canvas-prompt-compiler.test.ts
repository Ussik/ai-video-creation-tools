import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileCanvasPrompt, type CanvasPromptCompilerInput } from '../src/features/canvas/canvas-prompt-compiler'
import { getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'

const profile = {
  kind: 'character' as const, name: '林晚', variant: '雨衣', definition: '蓝色雨衣，保持人物身份。',
  view_requirements: '正面、侧面、背面与面部细节。', state_delta: '只增加右袖湿痕。',
}
const input = (): CanvasPromptCompilerInput => ({
  profileReferences: [], referenceIds: [], referenceNames: [], model: { modality: 'image', settings: {} },
  ratio: '16:9', resolution: '4K', clarity: '4K', quality: 'high', background: 'auto', duration: 6,
  durationFollowsSource: false, mode: 'text', bindings: [{ ...profile, revision: 1, board_asset_id: 'hero-board', profile_id: 'hero' }],
  visualReferenceMode: 'profiles', style: { version: 'v1', label: '水墨', source: 'settings', details: {} },
})

test('profile and reference-template boards retain multiple views without shot-only restrictions', () => {
  for (const board of [{ profile }, { templateKind: 'location' as const }]) {
    const prompt = compileCanvasPrompt('请整理对象的多视角设定。', { ...input(), ...board })
    assert.match(prompt, /【设定图固定要求】/)
    assert.match(prompt, /设定板版式/)
    assert.doesNotMatch(prompt, /【镜头视觉设定】|只生成当前镜头的一幅完整画面|不要复制设定板的多视角拼版/)
    assert.match(prompt, /画面比例：16:9/)
    assert.match(prompt, /画风：水墨/)
  }
})

test('independent copied boards retain profile content and base-reference context while parameters and changed references can refresh', () => {
  const source = { ...input(), profile, referenceIds: ['base', 'detail'], referenceNames: ['基础人物', '灯光细节'],
    profileReferences: [{ asset_id: 'base', name: '林晚', variant: '基础服装', definition: '蓝色外套', role: 'base' as const },
      { asset_id: 'detail', name: '灯光细节', role: 'manual' as const }] }
  const template = compileCanvasPrompt('只增加右袖湿痕。', source)
  const independent = { ...input(), templateKind: 'character' as const, boardTemplate: template,
    referenceIds: source.referenceIds, referenceNames: source.referenceNames }
  const copied = compileCanvasPrompt('只增加右袖湿痕。', independent)
  for (const name of ['设定图固定要求', '基础版本与本次状态变化', '基础身份参考', '生成参考图'] as const) {
    assert.deepEqual(getManagedPromptBlocks(copied, [name]), getManagedPromptBlocks(template, [name]))
  }
  const changed = compileCanvasPrompt('只增加右袖湿痕。', { ...independent, ratio: '9:16', referenceIds: ['detail'], referenceNames: ['新灯光'] })
  assert.match(changed, /画面比例：9:16/)
  assert.doesNotMatch(changed, /【基础身份参考】|【基础版本与本次状态变化】|\[\[ref:base\]\]/)
  assert.match(changed, /新灯光/)
  assert.deepEqual(getManagedPromptBlocks(changed, ['设定图固定要求']), getManagedPromptBlocks(template, ['设定图固定要求']))
})

test('base identity follows actual submitted reference order even when the base is not first', () => {
  const prompt = compileCanvasPrompt('保留参考图 1 的灯光。', {
    ...input(), profile, referenceIds: ['lighting', 'base'], referenceNames: ['灯光', '基础图'],
    profileReferences: [
      { asset_id: 'lighting', name: '灯光参考', role: 'manual' },
      { asset_id: 'base', name: '林晚', variant: '基础服装', role: 'base' },
    ],
  })
  assert.match(prompt, /^保留\[\[ref:lighting\]\] 的灯光。/)
  assert.match(prompt, /基础对象：林晚 · 基础服装；基础图为\[\[ref:base\]\]。/)
  assert.match(prompt, /【基础身份参考】\n\[\[ref:base\]\] 用于保持基础版本身份/)
  assert.match(prompt, /【生成参考图】\n\[\[ref:lighting\]\]：灯光参考[\s\S]*\[\[ref:base\]\]：林晚（基础服装）/)
})

test('image request mode and model parameter support refresh the editable requirements', () => {
  const original = { ...input(), bindings: [], model: { modality: 'image' as const, settings: {
    request_templates: { text: { quality: '{{quality}}', clarity: '{{clarity}}' }, reference: { prompt: '{{prompt}}' } },
  } } }
  const text = compileCanvasPrompt('门前站着林晚。', original)
  assert.doesNotMatch(text, /画质要求：|清晰度要求：/)
  const reference = compileCanvasPrompt('门前站着林晚。', { ...original, referenceIds: ['hero'], referenceNames: ['林晚'] })
  assert.match(reference, /画质要求：高画质/)
  assert.match(reference, /清晰度要求：4K/)
  const mapped = compileCanvasPrompt('门前站着林晚。', { ...original, referenceIds: ['hero'], referenceNames: ['林晚'],
    model: { modality: 'image', settings: { request_template: { quality: '{{quality}}', clarity: '{{clarity}}' } } } })
  assert.doesNotMatch(mapped, /画质要求：|清晰度要求：/)
})

test('video mode, generation controls and project style changes reach the compiled document', () => {
  const video: CanvasPromptCompilerInput = { ...input(), model: { modality: 'video', settings: {} },
    referenceIds: ['hero-board'], referenceNames: ['林晚'], mode: 'first_frame', videoOptions: { mode: 'first_frame' } }
  const first = compileCanvasPrompt('林晚走进门。', video)
  assert.match(first, /首帧要求：/)
  assert.match(first, /视频时长：6 秒/)
  assert.doesNotMatch(first, /【视频参考图用途】/)
  const updated = compileCanvasPrompt('林晚走进门。', { ...video, mode: 'reference', videoOptions: { mode: 'reference' },
    ratio: '9:16', duration: 10, resolution: '1080p', style: { version: 'v2', label: '木刻', source: 'settings', details: {} } })
  assert.doesNotMatch(updated, /首帧要求：|画风：水墨/)
  assert.match(updated, /【视频参考图用途】/)
  assert.match(updated, /视频时长：10 秒/)
  assert.match(updated, /画面比例：9:16/)
  assert.match(updated, /清晰度要求：1080p/)
  assert.match(updated, /画风：木刻/)
  const sourceTiming = compileCanvasPrompt('林晚走进门。', { ...video, durationFollowsSource: true })
  assert.match(sourceTiming, /视频时长：跟随原视频/)
  assert.doesNotMatch(sourceTiming, /视频时长：6 秒/)
})
