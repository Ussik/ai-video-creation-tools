import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset } from '../src/shared/api/api'
import { filterLibraryAssets, libraryCollection, libraryEmptyText } from '../src/features/assets/asset-library'

const assets = [
  { id: 'draft', filename: 'Draft.PNG', kind: 'image', source: 'generated', saved: false, prompt: '雨夜', shot_id: 'shot', created_at: '2026-10-06T03:00:00Z' },
  { id: 'saved', filename: 'Selected.mp4', kind: 'video', source: 'generated', saved: true, created_at: '2026-10-06T02:00:00Z' },
  { id: 'upload', filename: 'Music.wav', kind: 'audio', source: 'upload', saved: true, created_at: '2026-10-06T01:00:00Z' },
  { id: 'export', filename: 'Final.mp4', kind: 'video', source: 'export', saved: true, created_at: '2026-10-06T04:00:00Z' },
] as Asset[]
const filters = { kind: 'all', source: 'all', query: '', sort: 'newest' } as const

test('history keeps all generated candidates; personal library includes only saved assets', () => {
  assert.deepEqual(libraryCollection(assets, 'history').map(a => a.id), ['draft', 'saved'])
  assert.deepEqual(libraryCollection(assets, 'personal').map(a => a.id), ['saved', 'upload', 'export'])
})

test('search matches filenames, prompts and associated shot titles while composing type and source filters', () => {
  const shots = [{ id: 'shot', title: '古城石桥' }]
  for (const query of [' draft.png ', '雨夜', '石桥']) {
    assert.deepEqual(filterLibraryAssets(assets, shots, { ...filters, query }).map(a => a.id), ['draft'])
  }
  assert.deepEqual(filterLibraryAssets(assets, shots, { ...filters, kind: 'video', source: 'generated' }).map(a => a.id), ['saved'])
  assert.deepEqual(filterLibraryAssets(assets, shots, { ...filters, kind: 'audio', query: '石桥' }), [])
})

test('both sort directions work without mutating project asset order', () => {
  const before = assets.map(a => a.id)
  assert.deepEqual(filterLibraryAssets(assets, [], filters).map(a => a.id), ['export', 'draft', 'saved', 'upload'])
  assert.deepEqual(filterLibraryAssets(assets, [], { ...filters, sort: 'oldest' }).map(a => a.id), ['upload', 'saved', 'draft', 'export'])
  assert.deepEqual(assets.map(a => a.id), before)
})

test('filtered empty results do not claim that the library itself is empty', () => {
  assert.equal(libraryEmptyText('history', 0), '暂无历史记录')
  assert.equal(libraryEmptyText('personal', 0), '暂无个人资产')
  assert.equal(libraryEmptyText('history', 4), '没有符合条件的素材')
  assert.equal(libraryEmptyText('personal', 4), '没有符合条件的素材')
})

test('search finds a persisted custom name without requiring a presentation-name map', () => {
  const named = assets.map(asset => asset.id === 'saved' ? { ...asset, display_name: '雷神 MASK 终版' } : asset)
  for (const query of ['雷神', 'mask', '  终版  ', 'Selected.mp4']) {
    assert.deepEqual(filterLibraryAssets(named, [], { ...filters, query }).map(asset => asset.id), ['saved'])
  }
  assert.deepEqual(filterLibraryAssets(named, [], { ...filters, query: '雷神', kind: 'image' }), [])
  assert.equal(assets.find(asset => asset.id === 'saved')?.display_name, undefined)
})
