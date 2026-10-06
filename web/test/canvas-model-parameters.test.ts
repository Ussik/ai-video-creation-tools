import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Model } from '../src/api'
import { generationCost, imageParameterOptions, imageParameterValue, imagePreferencePrompt, imageRatios, imageRequestResolution, imageSizeChoices, modelDefaultResolution, resolutionRatio, selectImageSize, usesModelParameter } from '../src/canvas-model-parameters'

const model = (settings: Model['settings'], modality: Model['modality'] = 'image') => ({ settings, modality } as Model)

test('size-only image templates expose creative preferences with usable defaults', () => {
  const image = model({ request_template: { size: '{{size}}' }, image_qualities: ['high'] })
  assert.deepEqual(imageParameterOptions(image, 'quality'), ['high'])
  assert.deepEqual(imageParameterOptions(image, 'clarity'), ['1K', '2K', '4K'])
  assert.deepEqual(imageParameterOptions(image, 'background'), ['auto', 'preserve', 'transparent'])
  assert.equal(imageParameterValue(image, 'quality'), 'high')
  assert.equal(imageParameterValue(image, 'clarity'), '1K')
  assert.equal(imageParameterValue(image, 'background'), 'auto')
  assert.deepEqual(imageParameterOptions(model({}, 'video'), 'quality'), [])
  assert.equal(usesModelParameter(image, 'ratio'), false)
  assert.equal(resolutionRatio('1536x1024'), '3:2')
  assert.equal(resolutionRatio('1024x1536'), '2:3')
  assert.equal(resolutionRatio('720p'), null)
})

test('explicit model choices and configured defaults remain usable', () => {
  const image = model({ request_templates: { text: { quality: '{{quality}}' } }, image_qualities: ['high', 'high', 'low'], default_resolution: '1536x1024' })
  assert.deepEqual(imageParameterOptions(image, 'quality'), ['high', 'low'])
  assert.equal(modelDefaultResolution(image, ['1024x1024', '1536x1024']), '1536x1024')
  assert.equal(modelDefaultResolution(image, ['1024x1024']), '1024x1024')
  assert.equal(imageParameterValue(image, 'quality', 'low'), 'low')
  assert.equal(imageParameterValue(model({default_quality: 'high'}), 'quality'), 'high')
  assert.equal(imageParameterValue(model({}), 'quality'), 'standard')
})

test('every requested ratio and clarity stays independent from a fixed-size provider', () => {
  const image = model({ request_template: { prompt: '{{prompt}}', size: '{{size}}' }, resolutions: ['1024x1024', '1536x1024', '1024x1536'] })
  for (const ratio of imageRatios) for (const clarity of ['1K', '2K', '4K']) {
    const resolution = imageRequestResolution(image, '1024x1024', {ratio, clarity})
    assert.ok((image.settings.resolutions as string[]).includes(resolution))
    const prompt = imagePreferencePrompt(image, '一个旧相框', {ratio, clarity, resolution, quality: 'extreme', background: 'transparent'})
    assert.ok(prompt.startsWith('一个旧相框\n\n图片生成要求：'))
    if (resolutionRatio(resolution) !== ratio) assert.ok(prompt.includes(`画面比例：${ratio}`))
    if (clarity !== '1K') assert.ok(prompt.includes(`清晰度要求：${clarity}`))
    assert.ok(prompt.includes('极致画质'))
    assert.ok(prompt.includes('透明背景'))
  }
  assert.equal(imageRequestResolution(image, '1024x1024', { ratio: '16:9', clarity: '2K' }), '1536x1024')
  assert.equal(imageRequestResolution(image, '1024x1024', { ratio: '9:16', clarity: '4K' }), '1024x1536')
})

test('native parameters do not duplicate prompt requirements and follow the active template', () => {
  const image = model({request_templates: {
    text: {prompt: '{{prompt}}', ratio: '{{ratio}}', quality: '{{quality}}', clarity: '{{clarity}}', background: '{{background}}'},
  }, resolutions: ['1K', '2K', '4K']})
  assert.equal(imageRequestResolution(image, '1K', {ratio: '16:9', clarity: '4K'}), '4K')
  assert.equal(imagePreferencePrompt(image, '原始提示词', {ratio:'16:9', resolution:'4K', clarity:'4K', quality:'high', background:'preserve'}), '原始提示词')
  const otherMode = model({request_template:{prompt:'{{prompt}}', size:'{{size}}'}, request_templates: { reference: {quality:'{{quality}}'} }})
  assert.ok(imagePreferencePrompt(otherMode, '相框', {ratio:'1:1', resolution:'1024x1024', clarity:'1K', quality:'ultra', background:'auto'}).includes('超高画质'))
  assert.equal(imageRequestResolution(model({}), '1K', {ratio:'16:9', clarity:'2K'}), '1K')
  assert.equal(imageRequestResolution(model({request_template:{size:'{{size}}'},resolutions:['1K','2K','4K']}), '1K', {ratio:'16:9',clarity:'4K'}), '4K')
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
