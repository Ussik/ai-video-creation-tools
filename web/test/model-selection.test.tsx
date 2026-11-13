import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { Modality } from '../src/shared/api/api'
import { modelSelectionStorageKey, rememberedModelId, rememberModelSelection } from '../src/features/models/model-selection-store'
import { useSharedModelSelection } from '../src/features/models/useSharedModelSelection'
import { orderModelsByDefault, preferredModel } from '../src/features/models/model-defaults'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
beforeEach(() => dom.window.localStorage.clear())
after(() => dom.window.close())

const textModels = [{ id: 'a', is_default: true }, { id: 'b' }]
type Props = { name: string; modality?: Modality; models?: typeof textModels; locked?: boolean; active?: boolean }
function Selector({ name, modality = 'text', models = textModels, locked, active }: Props) {
  const { modelId, selectModel } = useSharedModelSelection(modality, models, { locked, active })
  return <div data-selector={name}><output>{modelId}</output>{models.map(model =>
    <button key={model.id} onClick={() => selectModel(model.id)}>{model.id}</button>)}</div>
}
async function mount(children: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (content: React.ReactNode) => act(() => root.render(content))
  await render(children)
  return { render, close: async () => { await act(() => root.unmount()); container.remove() } }
}
const value = (name: string) => document.querySelector(`[data-selector="${name}"] output`)?.textContent
const choose = async (name: string, id: string) => act(() => {
  const button = [...document.querySelectorAll<HTMLButtonElement>(`[data-selector="${name}"] button`)].find(item => item.textContent === id)
  assert.ok(button); button.click()
})

test('manual choice synchronizes same-type selectors, persists after remount and keeps modalities separate', async () => {
  const view = await mount(<><Selector name="first" /><Selector name="second" /><Selector name="image" modality="image" /><Selector name="video" modality="video" /></>)
  try {
    await choose('first', 'b')
    assert.equal(value('second'), 'b')
    assert.equal(value('image'), 'a'); assert.equal(value('video'), 'a')
    assert.equal(dom.window.localStorage.getItem(modelSelectionStorageKey('text')), 'b')
    await choose('image', 'b')
    assert.equal(value('video'), 'a')
  } finally { await view.close() }
  const reopened = await mount(<Selector name="reopened" />)
  try { assert.equal(value('reopened'), 'b') } finally { await reopened.close() }
})

test('running consumer freezes its model and follows the latest compatible selection after unlocking', async () => {
  const children = (locked: boolean) => <><Selector name="running" locked={locked} /><Selector name="other" /></>
  const view = await mount(children(true))
  try {
    await choose('other', 'b')
    assert.equal(value('running'), 'a')
    await choose('running', 'b')
    assert.equal(value('running'), 'a')
    await view.render(children(false))
    assert.equal(value('running'), 'b')
  } finally { await view.close() }
})

test('capability fallback never overwrites the global choice and removed models fall back to an eligible default', async () => {
  rememberModelSelection('text', 'b')
  const limited = [{ id: 'vision', is_default: true }]
  const view = await mount(<><Selector name="general" /><Selector name="vision" models={limited} /></>)
  try {
    assert.equal(value('general'), 'b'); assert.equal(value('vision'), 'vision')
    assert.equal(rememberedModelId('text'), 'b')
    await view.render(<Selector name="general" models={[textModels[0]]} />)
    assert.equal(value('general'), 'a')
    assert.equal(rememberedModelId('text'), 'b')
    await view.render(<Selector name="general" />)
    assert.equal(value('general'), 'b')
    await view.render(<Selector name="general" models={[]} />)
    assert.equal(value('general'), '')
  } finally { await view.close() }
})

test('inactive consumer catches changes when reopened', async () => {
  const view = await mount(<Selector name="closed" active={false} />)
  try {
    await act(() => rememberModelSelection('text', 'b'))
    assert.equal(value('closed'), 'a')
    await view.render(<Selector name="closed" active />)
    assert.equal(value('closed'), 'b')
  } finally { await view.close() }
})

test('another browser tab storage event updates the choice and clearing it restores the default', async () => {
  const view = await mount(<Selector name="tab" />)
  try {
    await act(() => {
      dom.window.localStorage.setItem(modelSelectionStorageKey('text'), 'b')
      dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: modelSelectionStorageKey('text'), newValue: 'b', storageArea: dom.window.localStorage }))
    })
    assert.equal(value('tab'), 'b')
    await act(() => {
      dom.window.localStorage.clear()
      dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: null, storageArea: dom.window.localStorage }))
    })
    assert.equal(value('tab'), 'a')
  } finally { await view.close() }
})

test('storage failure still synchronizes within the session, including clearing a stale stored choice', async t => {
  rememberModelSelection('text', 'b')
  const view = await mount(<><Selector name="first" /><Selector name="second" /></>)
  const storagePrototype = Object.getPrototypeOf(dom.window.localStorage)
  const write = t.mock.method(storagePrototype, 'setItem', () => { throw new Error('storage denied') })
  const remove = t.mock.method(storagePrototype, 'removeItem', () => { throw new Error('storage denied') })
  try {
    await choose('first', 'a')
    assert.equal(value('second'), 'a')
    assert.equal(rememberedModelId('text'), 'a')
    await act(() => rememberModelSelection('text', null))
    assert.equal(rememberedModelId('text'), undefined)
    assert.equal(value('second'), 'a')
  } finally {
    write.mock.restore(); remove.mock.restore()
    await act(() => rememberModelSelection('text', null))
    await view.close()
  }
})

test('new-node model helpers prioritize a compatible recent choice before configured defaults', () => {
  const catalog = [{ id: 'a', modality: 'text' as const, is_default: true }, { id: 'b', modality: 'text' as const }, { id: 'c', modality: 'text' as const }]
  rememberModelSelection('text', 'b')
  assert.equal(preferredModel(catalog)?.id, 'b')
  assert.deepEqual(orderModelsByDefault(catalog).map(model => model.id), ['b', 'a', 'c'])
  assert.equal(preferredModel(catalog.filter(model => model.id !== 'b'))?.id, 'a')
  assert.equal(preferredModel(catalog.map(model => ({ ...model, modality: 'image' as const })))?.id, 'a')
  assert.deepEqual(catalog.map(model => model.id), ['a', 'b', 'c'])
})
