import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportsVideoMultiReference, videoReferenceConfigError, videoReferenceMediaError } from '@video-studio/shared/media/video-reference-config'
import { applySeedance2VideoSettings, seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { synchronizeVideoReferencePrompt, visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'

test('multi-reference availability requires declared mode and consumed multi-image variables', () => {
  const settings = { supported_modes: ['text', 'reference'], request_template: { images: '{{images}}' } }
  assert.equal(supportsVideoMultiReference(settings), true)
  assert.equal(supportsVideoMultiReference({ ...settings, supported_modes: ['text'] }), false)
  assert.equal(supportsVideoMultiReference({ ...settings, request_template: { image: '{{image}}' } }), false)
  assert.equal(supportsVideoMultiReference({ ...settings, request_template: { prompt: '{{prompt}}' }, content_template: ['{{images}}'] }), false)
  assert.equal(supportsVideoMultiReference({ ...settings, request_template: { images: 'ignore {{images}}' } }), false)
  assert.match(videoReferenceConfigError({ ...settings, request_template: { image: '{{image}}' } }, 2)!, /只配置了一张/)
  assert.match(videoReferenceConfigError(settings, 1, 'text')!, /文生视频模式不能/)
  assert.match(videoReferenceConfigError(settings, 4, 'first_frame')!, /没有配置/)
})

test('explicit preset application removes conflicting request overrides and retains connection and pricing settings', () => {
  const previous = {
    api_base_url: 'https://gateway.example/api/v3', headers: { 'X-Route': 'video' }, price_per_second: 0.08,
    request_templates: { reference: { prompt: '{{prompt}}' } },
    mode_variables: { reference: { ratio: 'adaptive', resolution: '720p' } },
    draft_variables: { resolution: '720p' }, supports_draft: true,
    video_reference_template: { url: '{{reference_video_url}}' },
  }
  const applied = applySeedance2VideoSettings(previous)
  assert.equal(supportsVideoMultiReference(applied), true)
  for (const key of ['request_templates', 'mode_variables', 'draft_variables', 'supports_draft', 'video_reference_template']) assert.equal(key in applied, false)
  assert.equal(applied.api_base_url, previous.api_base_url)
  assert.deepEqual(applied.headers, previous.headers)
  assert.equal(applied.price_per_second, 0.08)
  assert.equal(applied.default_resolution, '480p')
  assert.ok('request_templates' in previous, 'applying the preset must not mutate prior settings')
})

test('reference roles enforce official mode exclusivity and preserve generic provider roles', () => {
  const settings = seedance2VideoSettings()
  assert.equal(supportsVideoMultiReference(settings), true)
  assert.equal(videoReferenceConfigError(settings, 9, 'reference'), null)
  assert.equal(videoReferenceConfigError({ ...settings, image_reference_template: { type: 'image_url', image_url: { url: '{{image}}' }, role: 'reference_image' } }, 3), null)
  assert.match(videoReferenceConfigError(settings, 10, 'reference')!, /9 张/)
  assert.equal(videoReferenceConfigError(settings, 1, 'first_frame'), null)
  assert.equal(videoReferenceConfigError(settings, 2, 'first_last_frame'), null)
  assert.match(videoReferenceConfigError(settings, 2, 'first_frame')!, /一张/)
  assert.match(videoReferenceConfigError({ ...settings, reference_roles: { reference: ['first_frame', 'reference_image'] } }, 2)!, /互斥/)
  assert.match(videoReferenceConfigError({ ...settings, reference_roles: { reference: ['first_frame'] } }, 2)!, /只能使用 reference_image/)
  assert.match(videoReferenceConfigError({ ...settings, image_reference_template: { role: '{{role}}' } }, 2)!, /未传递/)
  assert.match(videoReferenceConfigError({ ...settings, reference_roles: { reference: ['made_up'] } }, 2)!, /官方视频参考图角色/)
  assert.equal(videoReferenceConfigError({ ...settings, video_reference_profile: undefined, reference_roles: { reference: ['subject'] } }, 2), null)
  assert.equal(supportsVideoMultiReference({ ...settings, video_reference_profile: undefined, reference_roles: { reference: ['subject'] } }), true)
  assert.match(videoReferenceConfigError({ ...settings, max_reference_images: 1 }, 2)!, /1 张/)
})

test('Seedance media limits are explicitly configured and account for encoded request bytes', () => {
  const valid = { bytes: 1_000, width: 300, height: 600 }
  const settings = seedance2VideoSettings()
  assert.equal(videoReferenceMediaError(settings, [valid], 64 * 1024 * 1024), null)
  assert.match(videoReferenceMediaError(settings, [{ ...valid, bytes: 30 * 1024 * 1024 }])!, /小于 30 MB/)
  assert.match(videoReferenceMediaError(settings, [{ ...valid, width: 299 }])!, /300 到 6000/)
  assert.match(videoReferenceMediaError(settings, [{ ...valid, width: 6001 }])!, /300 到 6000/)
  assert.match(videoReferenceMediaError(settings, [{ ...valid, width: 300, height: 1000 }])!, /宽高比/)
  assert.match(videoReferenceMediaError(settings, [valid], 64 * 1024 * 1024 + 1)!, /含 Base64/)
  assert.equal(videoReferenceMediaError({}, [{ ...valid, width: 1, bytes: 100 * 1024 * 1024 }], 200 * 1024 * 1024), null)
})

test('video reference mapping keeps edited prose, actual image order and one managed block', () => {
  const bindings = [{ kind: 'character' as const, profile_id: 'hero', name: '林晚', variant: '雨衣', revision: 1,
    definition: '深绿雨衣', view_requirements: '正侧背', board_asset_id: 'hero-board', required: true },
    { kind: 'prop' as const, profile_id: 'key', name: '钥匙', variant: '旧铜', revision: 1,
      definition: '弯曲的铜钥匙', view_requirements: '细节', board_asset_id: 'excluded-board' }]
  const options = { mode: 'reference', storyboard_reference_asset_id: 'shot-frame' }
  const base = visualGenerationPrompt('林晚停顿后转身，镜头缓慢推近', bindings, ['shot-frame', 'hero-board'], 'profiles', options)
  assert.match(base, /图片1：分镜构图/)
  assert.match(base, /图片2：林晚（雨衣）/)
  assert.match(base, /弯曲的铜钥匙/)
  assert.doesNotMatch(base, /图片3/)
  const edited = base.replace('镜头缓慢推近', '镜头向左平移').replace('深绿雨衣', '湿润的雨衣')
  const updated = synchronizeVideoReferencePrompt(edited, bindings, ['hero-board', 'shot-frame'], 'profiles', options)
  assert.match(updated, /镜头向左平移/)
  assert.match(updated, /湿润的雨衣/)
  assert.match(updated, /图片1：林晚（雨衣）/)
  assert.match(updated, /图片2：分镜构图/)
  assert.equal((updated.match(/【视频参考图用途】/g) || []).length, 1)
  assert.equal(synchronizeVideoReferencePrompt(updated, bindings, ['hero-board', 'shot-frame'], 'profiles', options), updated)
  assert.doesNotMatch(synchronizeVideoReferencePrompt(updated, bindings, ['shot-frame'], 'keyframe', { mode: 'first_frame' }), /【视频参考图用途】/)
})

test('excluding an optional profile sharing a required or storyboard image removes only its mapping identity', () => {
  const bindings = [{ kind: 'character' as const, profile_id: 'required-hero', name: '林晚', variant: '雨衣', revision: 1,
    definition: '深绿雨衣', view_requirements: '正侧背', board_asset_id: 'shared-board', required: true },
    { kind: 'prop' as const, profile_id: 'optional-key', name: '铜钥匙', variant: '旧铜', revision: 1,
      definition: '弯曲铜钥匙', view_requirements: '细节', board_asset_id: 'shared-board', required: false }]
  for (const storyboard_reference_asset_id of [undefined, 'shared-board']) {
    const options = { mode: 'reference', storyboard_reference_asset_id, excluded_visual_profile_ids: ['optional-key'] }
    const prompt = visualGenerationPrompt('林晚转身', bindings, ['shared-board'], 'profiles', options)
    const mapping = prompt.split('【视频参考图用途】')[1]!
    assert.match(mapping, /林晚（雨衣）/)
    assert.doesNotMatch(mapping, /铜钥匙|旧铜/)
    assert.match(prompt.split('【视频参考图用途】')[0]!, /弯曲铜钥匙/)
    assert.equal(synchronizeVideoReferencePrompt(prompt, bindings, ['shared-board'], 'profiles', options), prompt)
  }
})
