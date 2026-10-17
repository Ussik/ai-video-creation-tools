import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Model } from '../src/shared/api/api'
import { generationCost, imageGenerationDefaults, imageParameterOptions, imageParameterValue, imagePreferencePrompt, imageRatioError, imageRatios, imageRequestResolution, imageResolutionClarity, imageSizeChoices, modelDefaultResolution, resolutionRatio, selectImageSize, usesModelParameter } from '../src/features/canvas/canvas-model-parameters'
import { videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { imagesApiSettings } from '@video-studio/shared/models/images-api-settings'

const model = (settings: Model['settings'], modality: Model['modality'] = 'image') => ({ settings, modality } as Model)

test('automatic Images size sends auto and keeps the requested ratio in the prompt', () => {
  const image = model(imagesApiSettings())
  for (const mode of ['text', 'reference']) {
    const resolution = imageRequestResolution(image, '2048x2048', { ratio: '16:9', clarity: '2K', mode })
    assert.equal(resolution, 'auto')
    assert.equal(imageRatioError(image, resolution, '16:9', mode), null)
    assert.ok(imagePreferencePrompt(image, '保持人物身份', { ratio: '16:9', resolution, clarity: '2K', quality: 'high', background: 'auto' }, mode).includes('画面比例：16:9'))
  }
})

test('size-only image templates expose creative preferences with usable defaults', () => {
  const image = model({ request_template: { size: '{{size}}' }, image_qualities: ['high'] })
  assert.deepEqual(imageParameterOptions(image, 'quality'), ['high'])
  assert.deepEqual(imageParameterOptions(image, 'clarity'), ['1K', '2K', '4K'])
  assert.deepEqual(imageParameterOptions(image, 'background'), ['auto', 'preserve', 'transparent'])
  assert.equal(imageParameterValue(image, 'quality'), 'high')
  assert.equal(imageParameterValue(image, 'clarity'), '2K')
  assert.equal(imageParameterValue(image, 'background'), 'auto')
  assert.deepEqual(imageParameterOptions(model({}, 'video'), 'quality'), [])
  assert.equal(usesModelParameter(image, 'ratio'), false)
  assert.equal(resolutionRatio('1536x1024'), '3:2')
  assert.equal(resolutionRatio('1024x1536'), '2:3')
  assert.equal(resolutionRatio('720p'), null)
})

test('canvas image defaults prefer 4K, extreme quality, auto, 16:9 and one candidate with real provider values', () => {
  const expected = { quality: 'extreme', clarity: '4K', resolution: '4K', background: 'auto', ratio: '16:9', candidate_count: 1 }
  assert.deepEqual(imageGenerationDefaults(model({})), expected)
  assert.deepEqual(imageGenerationDefaults(), expected, 'new nodes have defaults before choosing a model')
  const native = model({ image_qualities: ['low', 'medium', 'high'], default_quality: 'low', default_clarity: '1K', default_background: 'transparent', request_template: { size: '{{ratio}}', resolution: '{{resolution}}' }, resolutions: ['1K', '2K', '4K'] })
  const defaults = imageGenerationDefaults(native)
  assert.equal(defaults.quality, 'high')
  assert.equal(defaults.clarity, '4K')
  assert.equal(defaults.background, 'auto')
  assert.equal(imageRequestResolution(native, '1K', defaults), '4K')
  assert.equal(imageParameterValue(native, 'quality', 'high'), 'high', 'saved choices stay authoritative')
  assert.equal(imageParameterValue(native, 'quality', 'low'), 'low', 'explicit low-quality choice stays authoritative')
  assert.equal(imageParameterValue(native, 'quality', 'extreme'), 'high', 'unsupported quality uses the highest supported option')
  assert.equal(imageParameterValue(native, 'clarity', '4K'), '4K')
  assert.equal(imageParameterValue(native, 'background', 'transparent'), 'transparent')
})

test('image defaults use supported native levels and exact pixel sizes instead of inventing 4K capabilities', () => {
  const limited = imageGenerationDefaults(model({ image_qualities: ['low', 'high'], image_clarities: ['1K', '2K'],
    default_quality: 'low', default_clarity: '1K', resolutions: ['1K', '2K'], ratios: ['1:1'],
    request_template: { ratio: '{{ratio}}', resolution: '{{resolution}}' } }))
  assert.equal(limited.quality, 'high'); assert.equal(limited.clarity, '2K'); assert.equal(limited.resolution, '2K')
  assert.equal(limited.ratio, '1:1')
  const resolutionOnlyModel = model({ resolutions: ['1K', '2K'], request_template: { ratio: '{{ratio}}', resolution: '{{resolution}}' } })
  const resolutionOnly = imageGenerationDefaults(resolutionOnlyModel)
  assert.equal(resolutionOnly.resolution, '2K'); assert.equal(resolutionOnly.clarity, '2K')
  assert.equal(imageParameterValue(resolutionOnlyModel, 'clarity', '4K'), '2K', 'model selection safely adapts a new node default')
  const pixels = imageGenerationDefaults(model({ resolutions: ['1024x1024', '1536x1024', '1024x1536'],
    default_resolution: '1536x1024', request_template: { size: '{{size}}' } }))
  assert.equal(pixels.resolution, '1536x1024'); assert.equal(pixels.ratio, '3:2'); assert.equal(pixels.clarity, '1K')
  assert.equal(imageRatioError(model({ request_template: { size: '{{size}}' } }), pixels.resolution!, pixels.ratio), null)
  const wide = imageGenerationDefaults(model({ resolutions: ['1536x864', '3840x2160'], request_template: { size: '{{size}}' } }))
  assert.equal(wide.resolution, '3840x2160'); assert.equal(wide.ratio, '16:9'); assert.equal(wide.clarity, '4K')
  assert.equal(imageGenerationDefaults(model(imagesApiSettings())).resolution, 'auto')
})

test('explicit model choices and configured defaults remain usable', () => {
  const image = model({ request_templates: { text: { quality: '{{quality}}' } }, image_qualities: ['high', 'high', 'low'], default_resolution: '1536x1024' })
  assert.deepEqual(imageParameterOptions(image, 'quality'), ['high', 'low'])
  assert.equal(modelDefaultResolution(image, ['1024x1024', '1536x1024']), '1536x1024')
  assert.equal(modelDefaultResolution(image, ['1024x1024']), '1024x1024')
  assert.equal(imageParameterValue(image, 'quality', 'low'), 'low')
  assert.equal(imageParameterValue(model({default_quality: 'high'}), 'quality'), 'high')
  assert.equal(imageParameterValue(model({}), 'quality'), 'standard')
  assert.equal(imageResolutionClarity('2K'), '2K', 'older explicit resolutions retain their clarity')
  assert.equal(imageResolutionClarity('1536x1024'), '1K')
  assert.equal(imageResolutionClarity('3840x2160'), '4K')
  assert.equal(imageResolutionClarity('auto'), undefined)
})

test('video node defaults prefer 480p while preserving image model defaults', () => {
  const video = model({ resolutions: ['480p', '720p'], default_resolution: '720p' }, 'video')
  assert.equal(modelDefaultResolution(video, videoResolutionOptions(video.settings)), '480p')
  assert.equal(modelDefaultResolution(model({ resolutions: ['1080p'], default_resolution: '1080p' }, 'video'), videoResolutionOptions()), '480p')
  assert.equal(modelDefaultResolution(model({ resolutions: ['480P'], default_resolution: '720p' }, 'video'), ['480P', '720p']), '480P')
})

test('fixed-size providers never replace a requested ratio with a nearby ratio', () => {
  const image = model({ request_template: { prompt: '{{prompt}}', size: '{{size}}' }, resolutions: ['1024x1024', '1536x1024', '1024x1536'] })
  for (const ratio of imageRatios) for (const clarity of ['1K', '2K', '4K']) {
    const resolution = imageRequestResolution(image, '1024x1024', {ratio, clarity})
    if (['1:1', '3:2', '2:3'].includes(ratio)) {
      assert.equal(resolutionRatio(resolution), ratio)
      assert.equal(imageRatioError(image, resolution, ratio), null)
    } else {
      assert.equal(resolution, '')
      assert.ok(imageRatioError(image, resolution, ratio)?.includes(ratio))
    }
  }
  assert.ok(imageRatioError(image, '1536x1024', '16:9'))
  assert.ok(imageRatioError(image, '1024x1536', '9:16'))
})

test('exact widescreen sizes and native ratio parameters preserve the requested ratio', () => {
  const image = model({ request_template: { size: '{{size}}' }, resolutions: ['1024x1024', '1536x864', '864x1536'] })
  for (const [ratio, expected] of [['16:9', '1536x864'], ['9:16', '864x1536']]) {
    const resolution = imageRequestResolution(image, '1024x1024', {ratio, clarity: '1K'})
    assert.equal(resolution, expected)
    assert.equal(imageRatioError(image, resolution, ratio), null)
  }
  const native = model({ request_template: { aspect_ratio: '{{ratio}}', image_size: '{{resolution}}' }, resolutions: ['1K', '2K', '4K'] })
  for (const ratio of imageRatios) {
    assert.equal(imageRequestResolution(native, '1K', {ratio, clarity: '2K'}), '2K')
    assert.equal(imageRatioError(native, '2K', ratio), null)
  }
})

test('ratio validation requires an actual parameter mapping for the active mode', () => {
  const noSize = model({ request_template: { prompt: '{{prompt}}' }, resolutions: ['1536x864'] })
  assert.ok(imageRatioError(noSize, '1536x864', '16:9'))
  const perMode = model({
    request_template: { size: '{{size}}' },
    request_templates: { reference: { aspect_ratio: '{{ratio}}', resolution: '{{resolution}}' } },
    resolutions: ['1K', '2K', '4K'],
  })
  assert.equal(imageRequestResolution(perMode, '1K', {ratio: '16:9', clarity: '2K', mode: 'reference'}), '2K')
  assert.equal(imageRatioError(perMode, '2K', '16:9', 'reference'), null)
  assert.ok(imageRatioError(perMode, '2K', '16:9', 'text'))
  assert.equal(imageRequestResolution(model({request_template:{size:'{{size}}'}}), '1536x864', {ratio:'16:9',clarity:''}), '1536x864')
  assert.equal(imageRequestResolution(model({request_template:{size:'{{size}}'}}), '1536x1024', {ratio:'16:9',clarity:''}), '')
})

test('unmapped clarity, quality and background preferences remain in the prompt', () => {
  const image = model({ request_template: { prompt: '{{prompt}}', size: '{{size}}' }, resolutions: ['1536x864'] })
  for (const clarity of ['1K', '2K', '4K']) {
    const resolution = imageRequestResolution(image, '1536x864', {ratio: '16:9', clarity})
    const prompt = imagePreferencePrompt(image, '一个旧相框', {ratio: '16:9', clarity, resolution, quality: 'extreme', background: 'transparent'})
    assert.equal(resolution, '1536x864')
    assert.ok(prompt.includes('画面比例：16:9（宽:高，横版）'))
    if (clarity !== '1K') assert.ok(prompt.includes(`清晰度要求：${clarity}`))
    assert.ok(prompt.includes('极致画质'))
    assert.ok(prompt.includes('透明背景'))
  }
})

test('native parameters keep whole-image ratio instructions while other requirements follow the active template', () => {
  const image = model({request_templates: {
    text: {prompt: '{{prompt}}', ratio: '{{ratio}}', quality: '{{quality}}', clarity: '{{clarity}}', background: '{{background}}'},
  }, resolutions: ['1K', '2K', '4K']})
  assert.equal(imageRequestResolution(image, '1K', {ratio: '16:9', clarity: '4K'}), '')
  const prompt = imagePreferencePrompt(image, '原始提示词', {ratio:'16:9', resolution:'4K', clarity:'4K', quality:'high', background:'preserve'})
  assert.ok(prompt.startsWith('原始提示词\n\n图片生成要求：\n画面比例：16:9'))
  assert.ok(prompt.includes('整张输出图片使用此比例'))
  assert.ok(!prompt.includes('清晰度要求：') && !prompt.includes('画质要求：') && !prompt.includes('背景要求：'))
  const otherMode = model({request_template:{prompt:'{{prompt}}', size:'{{size}}'}, request_templates: { reference: {quality:'{{quality}}'} }})
  assert.ok(imagePreferencePrompt(otherMode, '相框', {ratio:'1:1', resolution:'1024x1024', clarity:'1K', quality:'ultra', background:'auto'}).includes('超高画质'))
  assert.equal(imageRequestResolution(model({}), '1K', {ratio:'16:9', clarity:'2K'}), '')
  assert.equal(imageRequestResolution(model({request_template:{size:'{{size}}'},resolutions:['1K','2K','4K']}), '1K', {ratio:'16:9',clarity:'4K'}), '')
})

test('ratio-only templates keep every selected aspect ratio explicit in text and reference prompts', () => {
  const image = model({ request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' } })
  for (const ratio of imageRatios) for (const mode of ['text', 'reference']) {
    const prompt = imagePreferencePrompt(image, '人物视觉设定信息图', { ratio, resolution: null, clarity: '2K', quality: 'standard', background: 'auto' }, mode)
    assert.ok(prompt.includes(`画面比例：${ratio}（宽:高`))
    assert.ok(prompt.includes('整张输出图片使用此比例'))
    assert.ok(prompt.includes('清晰度要求：2K'))
  }
  assert.ok(imagePreferencePrompt(image, '人物视觉设定信息图', { ratio: '9:16', resolution: null, clarity: null, quality: null, background: null }).includes('宽:高，竖版'))
  assert.ok(imagePreferencePrompt(image, '人物视觉设定信息图', { ratio: '1:1', resolution: null, clarity: null, quality: null, background: null }).includes('宽:高，方形'))
  assert.equal(imagePreferencePrompt(model({}, 'video'), '视频提示词', { ratio: '9:16', resolution: null, clarity: null, quality: null, background: null }), '视频提示词')
})

test('fixed image sizes map to clarity and aspect ratios without inventing supported dimensions', () => {
  assert.deepEqual(imageSizeChoices(['1024x1024', '1536x1024', '1024x1536', '1024x1024', 'auto', '0x1024']), [
    { resolution: '1024x1024', ratio: '1:1', clarity: '1K' },
    { resolution: '1536x1024', ratio: '3:2', clarity: '1K' },
    { resolution: '1024x1536', ratio: '2:3', clarity: '1K' },
  ])
  assert.equal(selectImageSize(['1024x1024', '1536x1024'], '1024x1024', { ratio: '3:2' })?.resolution, '1536x1024')
  assert.equal(selectImageSize(['1024x1024', '1536x1024'], '1024x1024', { ratio: '16:9' }), null)
  assert.equal(selectImageSize(['1024x1024', '1536x1024'], '1024x1024', { clarity: '4K' }), null)
})

test('image size changes preserve the other selection when supported and recover from unavailable combinations', () => {
  const sizes = ['1024x1024', '2048x2048', '4096x4096', '1536x1024', '3072x2048']
  assert.equal(selectImageSize(sizes, '1536x1024', { clarity: '2K' })?.resolution, '3072x2048')
  assert.equal(selectImageSize(sizes, '3072x2048', { ratio: '1:1' })?.resolution, '2048x2048')
  assert.equal(selectImageSize(sizes, '1536x1024', { clarity: '4K' })?.resolution, '4096x4096')
  assert.equal(selectImageSize(sizes, 'unknown', { clarity: '2K' })?.resolution, '2048x2048')
})

test('cost includes every candidate and zero is a valid estimate', () => {
  const video = model({ pricing: { per_second_by_resolution: { '720p': 0.2 }, currency: '¥' } }, 'video')
  assert.equal(generationCost(video, { resolution: '720p', duration: 8 }, 3), '¥4.8')
  assert.equal(generationCost(model({ pricing: { per_image: 0 } }), { duration: 1 }, 4), '¥0')
  assert.equal(generationCost(model({}), { duration: 1 }), null)
})
