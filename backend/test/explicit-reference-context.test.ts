import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enrichExplicitReferenceBindings, type ExplicitReferenceProfile } from '@video-studio/shared/visuals/explicit-reference-context'
import type { PromptVisualBinding } from '@video-studio/shared/visuals/visual-prompt'
import type { VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'

function reference(id: string, assetId: string, revision = 2): VisualReferenceSnapshot {
  return { id, asset_id: assetId, revision, view: 'face', purpose: 'identity', label: '面部身份', style_version: 'style' }
}

function binding(values: Partial<PromptVisualBinding> = {}): PromptVisualBinding {
  return { profile_id: 'peiyan', kind: 'character', name: '裴砚', variant: '执卷官常态', revision: 2,
    definition: '冻结的裴砚人物设定', view_requirements: '面部清楚', board_asset_id: 'peiyan-board', usage: 'none', ...values }
}

function profile(values: Partial<ExplicitReferenceProfile> = {}): ExplicitReferenceProfile {
  const { profile_id: _id, ...fields } = binding()
  return { ...fields, id: 'peiyan', definition: '新版人物设定', ...values }
}

test('a manually pinned inactive identity gets frozen semantic context without activating other images or changing inputs', () => {
  const saved = binding({ reference_assets: [reference('face', 'face-view')] })
  const options = { referenceAssetIds: ['peiyan-board'], explicitReferenceAssetIds: ['peiyan-board'], savedBindings: [saved], profiles: [profile()] }
  const before = structuredClone(options)
  const result = enrichExplicitReferenceBindings([], options)
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'character')
  assert.equal(result[0].name, '裴砚')
  assert.equal(result[0].definition, '冻结的裴砚人物设定')
  assert.equal(result[0].usage, 'both')
  assert.equal(result[0].required, false)
  assert.equal(result[0].board_asset_id, 'peiyan-board')
  assert.deepEqual(result[0].selected_reference_asset_ids, ['peiyan-board'])
  assert.equal(result[0].reference_assets, undefined)
  assert.deepEqual(options, before)
})

test('nonexplicit, unsubmitted, excluded and unknown upload images never gain invented owners', () => {
  const savedBindings = [binding()]
  assert.deepEqual(enrichExplicitReferenceBindings([], { referenceAssetIds: ['peiyan-board'], explicitReferenceAssetIds: [], savedBindings }), [])
  assert.deepEqual(enrichExplicitReferenceBindings([], { referenceAssetIds: [], explicitReferenceAssetIds: ['peiyan-board'], savedBindings }), [])
  assert.deepEqual(enrichExplicitReferenceBindings([], { referenceAssetIds: ['peiyan-board'], explicitReferenceAssetIds: ['peiyan-board'],
    excludedVisualProfileIds: ['peiyan'], savedBindings }), [])
  assert.deepEqual(enrichExplicitReferenceBindings([], { referenceAssetIds: ['upload'], explicitReferenceAssetIds: ['upload'], savedBindings }), [])
})

test('only confirmed views at the current profile revision can supply an independent-view owner', () => {
  const current = profile({ board_asset_id: 'unselected-board', reference_assets: [
    { ...reference('face', 'face-view'), status: 'confirmed' },
    { ...reference('candidate', 'candidate-view'), status: 'candidate' },
    { ...reference('stale', 'stale-view', 1), status: 'confirmed' },
    { ...reference('other', 'other-view'), status: 'confirmed' },
  ] })
  const result = enrichExplicitReferenceBindings([], { referenceAssetIds: ['face-view', 'candidate-view', 'stale-view'],
    explicitReferenceAssetIds: ['face-view', 'candidate-view', 'stale-view'], profiles: [current] })
  assert.equal(result.length, 1)
  assert.equal(result[0].board_asset_id, null)
  assert.deepEqual(result[0].reference_assets?.map(item => item.asset_id), ['face-view'])
  assert.equal(result[0].reference_assets?.[0].purpose, 'identity')
})

test('frozen view snapshots win over newer profile definitions and view metadata', () => {
  const saved = binding({ board_asset_id: null, reference_assets: [reference('frozen-view', 'face-view')] })
  const result = enrichExplicitReferenceBindings([], { referenceAssetIds: ['face-view'], explicitReferenceAssetIds: ['face-view'],
    savedBindings: [saved], profiles: [profile({ revision: 3, reference_assets: [{ ...reference('current-view', 'face-view', 3), status: 'confirmed', label: '新版面部' }] })] })
  assert.equal(result.length, 1)
  assert.equal(result[0].definition, saved.definition)
  assert.equal(result[0].revision, 2)
  assert.deepEqual(result[0].reference_assets, saved.reference_assets)
})

test('active identities keep their frozen prose while only explicitly selected extra views merge', () => {
  const active = binding({ usage: 'both', required: true, definition: '当前启用的冻结正文', reference_assets: [reference('old', 'old-view')] })
  const input = [active]
  const current = profile({ reference_assets: [
    { ...reference('face', 'face-view'), status: 'confirmed' }, { ...reference('other', 'other-view'), status: 'confirmed' },
  ] })
  const before = structuredClone({ input, current })
  const result = enrichExplicitReferenceBindings(input, { referenceAssetIds: ['old-view', 'face-view', 'other-view'],
    explicitReferenceAssetIds: ['face-view'], profiles: [current] })
  assert.equal(result.length, 1)
  assert.equal(result[0].definition, active.definition)
  assert.equal(result[0].board_asset_id, active.board_asset_id)
  assert.equal(result[0].required, true)
  assert.deepEqual(result[0].reference_assets?.map(item => item.asset_id), ['old-view', 'face-view'])
  assert.deepEqual({ input, current }, before)
  result[0].reference_assets![0].label = '修改返回副本'
  assert.equal(active.reference_assets![0].label, '面部身份')
})

test('unowned replacements inherit their original identity, while removals and stale explicit ids do not reconnect inputs', () => {
  const saved = binding({ board_asset_id: null, reference_assets: [reference('face', 'face-view')] })
  const options = { referenceAssetIds: ['upload'], explicitReferenceAssetIds: ['upload'], savedBindings: [saved],
    overrides: { 'face-view': 'intermediate', intermediate: 'upload' } }
  const result = enrichExplicitReferenceBindings([], options)
  assert.equal(result[0].name, '裴砚')
  assert.equal(result[0].board_asset_id, null)
  assert.deepEqual(result[0].reference_assets?.map(item => item.asset_id), ['upload'])
  assert.deepEqual(enrichExplicitReferenceBindings([], { ...options, explicitReferenceAssetIds: ['face-view'] }), [])
  assert.deepEqual(enrichExplicitReferenceBindings([], { ...options, overrides: { 'face-view': null } }), [])
})

test('a replacement asset with its own owner never receives the overridden original character identity', () => {
  const own = profile({ id: 'luzhao', name: '陆照', board_asset_id: 'luzhao-board', definition: '陆照自己的外貌' })
  const result = enrichExplicitReferenceBindings([], { referenceAssetIds: ['luzhao-board'], explicitReferenceAssetIds: ['luzhao-board'],
    savedBindings: [binding()], profiles: [own], overrides: { 'peiyan-board': 'luzhao-board' } })
  assert.equal(result.length, 1)
  assert.equal(result[0].profile_id, 'luzhao')
  assert.equal(result[0].name, '陆照')
})

test('one selected image retains every genuine owner without duplicating the same profile', () => {
  const result = enrichExplicitReferenceBindings([], { referenceAssetIds: ['shared-image'], explicitReferenceAssetIds: ['shared-image'],
    savedBindings: [binding({ board_asset_id: 'shared-image' }), binding({ profile_id: 'luzhao', name: '陆照', board_asset_id: 'shared-image' })],
    profiles: [profile({ board_asset_id: 'shared-image' })] })
  assert.deepEqual(result.map(item => item.profile_id), ['peiyan', 'luzhao'])
  assert.deepEqual(result.map(item => item.board_asset_id), ['shared-image', 'shared-image'])
})

test('simultaneously selected board and independent view keep both annotation ids without fabricating a view', () => {
  const saved = binding({ reference_assets: [reference('face', 'face-view'), reference('unselected', 'other-view')] })
  const result = enrichExplicitReferenceBindings([], { referenceAssetIds: ['peiyan-board', 'face-view'],
    explicitReferenceAssetIds: ['peiyan-board', 'face-view'], savedBindings: [saved] })
  assert.equal(result.length, 1)
  assert.equal(result[0].board_asset_id, 'peiyan-board')
  assert.deepEqual(result[0].selected_reference_asset_ids, ['peiyan-board', 'face-view'])
  assert.deepEqual(result[0].reference_assets, [saved.reference_assets![0]])
})

test('an explicit replacement assigned by an active mapped binding does not add the target image as a second character', () => {
  const frozen = binding({ usage: 'both', definition: '裴砚已确认的镜头正文' })
  const active = { ...frozen, board_asset_id: 'luzhao-board' }
  const other = profile({ id: 'luzhao', name: '陆照', board_asset_id: 'luzhao-board', definition: '陆照的人物设定' })
  const result = enrichExplicitReferenceBindings([active], { referenceAssetIds: ['luzhao-board'], explicitReferenceAssetIds: ['luzhao-board'],
    savedBindings: [frozen], profiles: [profile(), other], overrides: { 'peiyan-board': 'luzhao-board' } })
  assert.equal(result.length, 1)
  assert.equal(result[0].profile_id, 'peiyan')
  assert.equal(result[0].name, '裴砚')
  assert.equal(result[0].definition, frozen.definition)
  assert.equal(result[0].board_asset_id, 'luzhao-board')
  assert.deepEqual(result[0].selected_reference_asset_ids, ['luzhao-board'])
})

test('a raw shared image keeps other frozen owners even when one of them is already active', () => {
  const first = binding({ usage: 'both', board_asset_id: 'shared-image' })
  const second = binding({ profile_id: 'luzhao', name: '陆照', board_asset_id: 'shared-image' })
  const result = enrichExplicitReferenceBindings([first], { referenceAssetIds: ['shared-image'], explicitReferenceAssetIds: ['shared-image'],
    savedBindings: [first, second], profiles: [profile({ board_asset_id: 'shared-image' })] })
  assert.deepEqual(result.map(item => item.profile_id), ['peiyan', 'luzhao'])
})
