import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import VideoReferencePanel, { type VideoReferencePanelProps } from '../src/VideoReferencePanel'
import type { Asset } from '../src/api'
import type { VideoReferenceEntry } from '../../backend/src/video-reference-manifest'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
after(() => dom.window.close())

const entry = (asset_id: string, index: number, overrides: Partial<VideoReferenceEntry> = {}): VideoReferenceEntry => ({
  asset_id, index, name: asset_id, purpose: 'manual', profile_ids: [], required: false, ...overrides,
})
const asset = (id: string) => ({ id, kind: 'image', filename: `${id}.png`, url: `/assets/${id}.png` }) as Asset

async function mount(overrides: Partial<VideoReferencePanelProps> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const previews: string[] = [], located: string[] = [], excluded: string[] = [], restored: string[] = [], removed: string[] = []
  await act(() => root.render(<VideoReferencePanel entries={[entry('shot', 1, { name: '分镜构图', purpose: 'storyboard' }), entry('hero', 2, { name: '林晚', variant: '校服', purpose: 'character', profile_ids: ['wan'], required: true })]}
    assets={[asset('shot'), asset('hero')]} onPreview={value => previews.push(value.id)} onLocate={value => located.push(value.asset_id)}
    onExclude={value => excluded.push(value)} onRestore={value => restored.push(value)} onRemoveManual={value => removed.push(value)} {...overrides} />))
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(found, label)
    return found
  }
  return { container, button, previews, located, excluded, restored, removed,
    destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('video references show actual image numbers and preview or locate the requested asset', async () => {
  const view = await mount()
  try {
    assert.deepEqual([...view.container.querySelectorAll('.pc-video-reference-number')].map(node => node.textContent), ['图片1', '图片2'])
    assert.match(view.container.textContent!, /林晚 · 校服/)
    await act(() => view.button('查看图片2：林晚 · 校服').click())
    await act(() => view.button('定位参考节点：林晚 · 校服').click())
    assert.deepEqual(view.previews, ['hero'])
    assert.deepEqual(view.located, ['hero'])
    assert.equal(view.container.querySelector('[role="dialog"]'), null, 'references stay inline and do not cover a canvas node')
  } finally { await view.destroy() }
})

test('required profiles and storyboard images have no exclusion or manual removal action', async () => {
  const view = await mount()
  try {
    assert.equal(view.container.querySelector('button[aria-label^="排除"]'), null)
    assert.equal(view.container.querySelector('button[aria-label^="移除"]'), null)
    assert.ok(view.container.querySelector('[aria-label="必需参考"]'))
  } finally { await view.destroy() }
})

test('optional shared reference excludes its profiles, manual reference can be removed, and excluded profiles can be restored', async () => {
  const view = await mount({
    entries: [entry('shared', 1, { name: 'A / B', purpose: 'character', profile_ids: ['a', 'b'] }), entry('manual', 2)],
    assets: [asset('shared'), asset('manual')], excludedBindings: [{ profile_id: 'crowd', name: '乘客', variant: '通勤' }],
  })
  try {
    await act(() => view.button('排除可选参考：A / B').click())
    await act(() => view.button('移除手动参考：manual').click())
    await act(() => view.button('恢复可选参考：乘客').click())
    assert.deepEqual(view.excluded, ['a', 'b'])
    assert.deepEqual(view.removed, ['manual'])
    assert.deepEqual(view.restored, ['crowd'])
  } finally { await view.destroy() }
})

test('references can be collapsed without changing selections', async () => {
  const view = await mount()
  try {
    const toggle = view.container.querySelector<HTMLButtonElement>('.pc-video-references-heading')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    await act(() => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(view.container.querySelector('img'), null)
    await act(() => toggle.click())
    assert.equal(view.container.querySelectorAll('img').length, 2)
    assert.deepEqual(view.removed, [])
    assert.deepEqual(view.excluded, [])
  } finally { await view.destroy() }
})

test('generation disables mutation actions but keeps available reference previews readable', async () => {
  const view = await mount({ disabled: true, entries: [entry('optional', 1, { profile_ids: ['optional'], purpose: 'prop' }), entry('manual', 2)],
    assets: [asset('optional'), asset('manual')], excludedBindings: [{ profile_id: 'other', name: '备选' }] })
  try {
    for (const label of ['排除可选参考：optional', '移除手动参考：manual', '恢复可选参考：备选', '定位参考节点：manual']) assert.equal(view.button(label).disabled, true)
    assert.equal(view.button('查看图片2：manual').disabled, false)
    await act(() => view.button('查看图片2：manual').click())
    assert.deepEqual(view.previews, ['manual'])
  } finally { await view.destroy() }
})

test('missing images remain numbered and identifiable and cannot invoke a wrong preview', async () => {
  const view = await mount({ entries: [entry('missing', 1, { name: '场景信息图', purpose: 'location' })], assets: [] })
  try {
    assert.match(view.container.textContent!, /图片缺失/)
    assert.match(view.container.textContent!, /图片1/)
    assert.equal(view.button('查看图片1：场景信息图').disabled, true)
    await act(() => view.button('定位参考节点：场景信息图').click())
    assert.deepEqual(view.located, ['missing'])
    assert.deepEqual(view.previews, [])
  } finally { await view.destroy() }
})

test('empty reference state does not add an empty toolbar', async () => {
  const view = await mount({ entries: [], assets: [] })
  try { assert.equal(view.container.innerHTML, '') } finally { await view.destroy() }
})
