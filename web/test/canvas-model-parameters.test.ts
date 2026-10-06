import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Model } from '../src/api'
import { generationCost, imageParameterOptions, modelDefaultResolution, resolutionRatio, usesModelParameter } from '../src/canvas-model-parameters'

const model = (settings: Model['settings'], modality: Model['modality'] = 'image') => ({ settings, modality } as Model)

test('size-only image templates cannot advertise unconsumed visual settings', () => {
  const image = model({ request_template: { size: '{{size}}' }, image_qualities: ['high'] })
  assert.deepEqual(imageParameterOptions(image, 'quality'), [])
  assert.deepEqual(imageParameterOptions(image, 'clarity'), [])
  assert.deepEqual(imageParameterOptions(image, 'background'), [])
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
})

test('cost includes every candidate and zero is a valid estimate', () => {
  const video = model({ pricing: { per_second_by_resolution: { '720p': 0.2 }, currency: '¥' } }, 'video')
  assert.equal(generationCost(video, { resolution: '720p', duration: 8 }, 3), '¥4.8')
  assert.equal(generationCost(model({ pricing: { per_image: 0 } }), { duration: 1 }, 4), '¥0')
  assert.equal(generationCost(model({}), { duration: 1 }), null)
})
