import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imagesApiSettings, imagesReferenceSettings } from '@video-studio/shared/models/images-api-settings'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import { changeImageAsync, changeImageBinding, changeImageResolutions, changeImageSizeMode, genericImageSettings, imageRequestForm } from '../src/features/models/image-model-settings'

test('Images reference profile works across model names while retaining provider endpoints, pricing and ratios', () => {
  const pricing = { currency: '¥', per_image: 0.3 }
  const settings = imagesReferenceSettings({ pricing, ratios: ['9:16', '1:1'], default_ratio: '9:16', request_path: 'images/generations',
    mode_variables: { reference: { ratio: '1:1' } }, image_reference_template: { url: '{{image}}' }, reference_roles: {} })
  assert.equal(imageReferenceConfigError(settings, 3, 'reference'), null)
  assert.equal(imageReferenceConfigError(settings, 3, 'text'), null)
  assert.deepEqual(settings.pricing, pricing)
  assert.deepEqual(settings.ratios, ['9:16', '1:1'])
  assert.equal(settings.default_ratio, '9:16')
  assert.equal(settings.mode_variables, undefined)
  assert.equal(settings.reference_roles, undefined)
  assert.equal(settings.api_base_url, undefined)
  assert.equal(settings.async_image, undefined)
  assert.equal(settings.request_path, 'images/generations')
  assert.equal(imageRequestForm(settings).preset, 'images_reference')
  const overridden = imagesReferenceSettings({ api_base_url: 'https://existing-provider.invalid', request_path: 'draw/v1/images/generations',
    async_image: true, get_path: 'v1/tasks/{id}' })
  assert.equal(overridden.api_base_url, 'https://existing-provider.invalid')
  assert.equal(overridden.request_path, 'draw/v1/images/generations')
  assert.equal(overridden.get_path, 'v1/tasks/{id}')
})

test('form updates preserve mode parameters and replace the original binding without duplication', () => {
  const settings = { request_template: { model: '{{model}}', prompt: '{{prompt}}', image: '{{image}}', ratio: '{{ratio}}', quality: 'high' },
    request_templates: { reference: { model: '{{model}}', prompt: '{{prompt}}', image: '{{image}}', ratio: '{{ratio}}', n: 1 } }, custom_option: true }
  const changed = changeImageBinding(changeImageBinding(settings, 'reference', 'images', 'multiple'), 'ratio', 'size')
  assert.equal(imageReferenceConfigError(changed, 2, 'reference'), null)
  assert.deepEqual(changed.request_template, { model: '{{model}}', prompt: '{{prompt}}', quality: 'high', images: '{{images}}', size: '{{ratio}}' })
  assert.deepEqual(changed.request_templates, { reference: { model: '{{model}}', prompt: '{{prompt}}', n: 1, images: '{{images}}', size: '{{ratio}}' } })
  assert.equal(changed.custom_option, true)
  assert.throws(() => changeImageBinding(changed, 'ratio', 'quality'), /已用于其他配置/)
})

test('custom nested reference templates and divergent mode fields remain in advanced configuration', () => {
  const nested = { request_template: { model: '{{model}}', prompt: '{{prompt}}', content: [{ image_url: '{{image}}' }] } }
  assert.equal(imageRequestForm(nested).editable, false)
  assert.throws(() => changeImageBinding(nested, 'reference', 'image'), /自定义请求结构/)
  const divergent = { request_template: { model: '{{model}}', prompt: '{{prompt}}', image: '{{image}}' },
    request_templates: { reference: { model: '{{model}}', prompt: '{{prompt}}', images: '{{images}}' } } }
  assert.equal(imageRequestForm(divergent).editable, false)
})

test('switching request profiles retains endpoint, polling, result paths and pricing', () => {
  const settings = genericImageSettings(changeImageAsync(imagesReferenceSettings({ pricing: { per_image: 0.3 }, ratios: ['1:1'], default_ratio: '1:1',
    api_base_url: 'https://image-provider.invalid/v2', request_path: 'custom/images', image_url_path: 'result.url', get_path: 'jobs/{id}' }), true), ['9:16'])
  assert.equal(settings.api_base_url, 'https://image-provider.invalid/v2')
  assert.equal(settings.request_path, 'custom/images')
  assert.equal(settings.async_image, true)
  assert.equal(settings.get_path, 'jobs/{id}')
  assert.equal(settings.image_url_path, 'result.url')
  assert.deepEqual(settings.request_template, { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}', async: true })
  assert.equal(settings.request_templates, undefined)
  assert.deepEqual(settings.pricing, { per_image: 0.3 })
  assert.deepEqual(settings.ratios, ['1:1'])
  assert.equal(imageRequestForm(settings).preset, 'generic')
})

test('async selection configures polling and sync selection stops sending async in every mode', () => {
  const asyncSettings = changeImageAsync(imagesReferenceSettings(), true)
  assert.equal(asyncSettings.get_path, 'tasks/{id}')
  assert.equal(asyncSettings.id_path, 'task_id')
  assert.equal((asyncSettings.request_template as Record<string, unknown>).async, true)
  const sync = changeImageAsync(asyncSettings, false)
  assert.equal(sync.async_image, false)
  for (const template of [sync.request_template, ...Object.values(sync.request_templates as Record<string, unknown>)]) {
    assert.equal((template as Record<string, unknown>).async, undefined)
  }
  assert.equal(imageReferenceConfigError(sync, 2, 'reference'), null)
})

test('file uploads expose references to shared checks and keep custom endpoints and mode parameters', () => {
  const native = imagesApiSettings({ api_base_url: 'https://own-service.invalid/v2', image_reference_path: 'images/generations',
    request_templates: { reference: { model: '{{model}}', prompt: '{{prompt}}', quality: 'high' } } })
  assert.equal(imageRequestForm(native).preset, 'images_api')
  assert.equal(imageRequestForm(native).sizeMode, 'auto')
  assert.equal(imageReferenceConfigError(native, 5, 'reference'), null)
  assert.equal(native.image_reference_path, 'images/generations')
  assert.equal(native.api_base_url, 'https://own-service.invalid/v2')
  assert.equal((native.request_templates as Record<string, Record<string, unknown>>).reference.quality, 'high')
  const sync = changeImageAsync(changeImageAsync(native, true), false)
  assert.equal(sync.image_reference_transport, 'multipart')
  assert.equal(imageRequestForm(sync).editable, true)
  const none = changeImageBinding(sync, 'reference', 'image[]', 'none')
  assert.equal(imageRequestForm(none).referenceField, 'image[]')
  assert.equal(imageReferenceConfigError(changeImageBinding(none, 'reference', imageRequestForm(none).referenceField, 'multiple'), 3), null)
  assert.equal(imageRequestForm({ ...sync, image_reference_transport: 'json' }).preset, 'images_reference')
  const json = imagesReferenceSettings(sync)
  assert.equal(json.image_reference_transport, 'json')
  assert.equal(json.image_reference_path, 'images/generations')
  assert.equal((json.request_template as Record<string, unknown>)['image[]'], undefined)
})

test('pixel dimensions expose exact ratios while size mode changes replace bindings in every mode', () => {
  const native = imagesApiSettings()
  const pixels = changeImageSizeMode(native, 'pixels')
  assert.equal(imageRequestForm(pixels).sizeMode, 'pixels')
  assert.deepEqual(pixels.ratios, ['1:1', '3:2', '2:3'])
  const wide = changeImageResolutions(pixels, ['1280x720', '720x1280'])
  assert.deepEqual(wide.ratios, ['16:9', '9:16'])
  assert.equal(wide.default_resolution, '1280x720')
  assert.equal(wide.default_ratio, '16:9')
  const ratios = changeImageSizeMode(wide, 'ratio')
  for (const template of [ratios.request_template, ...Object.values(ratios.request_templates as Record<string, unknown>)]) {
    assert.equal((template as Record<string, unknown>).size, '{{ratio}}')
  }
  assert.equal(imageRequestForm(changeImageSizeMode(ratios, 'auto')).sizeMode, 'auto')
})
