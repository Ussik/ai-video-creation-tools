import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { CanvasGenerationParameters, type CanvasGenerationParametersProps } from '../src/CanvasGenerationControls'
import { imageParameterOptions, imageParameterValue, imagePreferencePrompt, imageRatios, imageRequestResolution } from '../src/canvas-model-parameters'
import type { Model } from '../src/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.assign(globalThis, {
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})
after(() => dom.window.close())

const defaults: CanvasGenerationParametersProps = {
  modality: 'image', ratios: [], ratio: '1:1', resolutions: ['1024x1024', '1536x1024', '1024x1536'], resolution: '1024x1024',
  duration: 5, minDuration: 1, maxDuration: 30, showDuration: false, audioSupported: false, generateAudio: false, count: 1,
  onChange() {}, onCountChange() {},
}

async function mount(overrides: Partial<CanvasGenerationParametersProps> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const changes: unknown[] = []
  function Harness() {
    const [props, setProps] = useState({ ...defaults, ...overrides })
    return <MantineProvider env="test"><CanvasGenerationParameters {...props}
      onChange={patch => { changes.push(patch); setProps(current => ({ ...current, ...patch })) }}
      onCountChange={count => { changes.push({ count }); setProps(current => ({ ...current, count })) }} />
    </MantineProvider>
  }
  await act(() => root.render(<Harness />))
  await act(() => container.querySelector<HTMLButtonElement>('.pc-generation-parameters-trigger')!.click())
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!
  assert.ok(panel)
  return { panel, changes, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

function button(panel: HTMLElement, group: string, label: string) {
  const found = [...panel.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(node => node.textContent === label)
  assert.ok(found, `${group}: ${label}`)
  return found
}

test('fixed-size image popup shows only supported choices and maps every selectable ratio to real dimensions', async () => {
  const view = await mount()
  try {
    assert.deepEqual([...view.panel.querySelectorAll('[role="group"]')].map(node => node.getAttribute('aria-label')), ['清晰度', '比例', '生成候选数量'])
    assert.equal(view.panel.querySelector('button:disabled'), null)
    assert.deepEqual([...view.panel.querySelectorAll('[aria-label="比例"] button')].map(node => node.textContent), ['1:1', '3:2', '2:3'])
    assert.equal(view.panel.textContent?.includes('2K'), false)
    await act(() => button(view.panel, '比例', '3:2').click())
    assert.equal(button(view.panel, '比例', '3:2').getAttribute('aria-pressed'), 'true')
    await act(() => button(view.panel, '比例', '2:3').click())
    await act(() => button(view.panel, '生成候选数量', '4张').click())
    assert.deepEqual(view.changes, [
      { resolution: '1536x1024', ratio: '3:2' }, { resolution: '1024x1536', ratio: '2:3' }, { count: 4 },
    ])
  } finally { await view.destroy() }
})

test('configured image quality, clarity, background and ratios remain selectable with their provider values', async () => {
  const view = await mount({ ratios: ['1:1', '16:9'], clarities: ['1K', '2K'], clarity: '1K', qualities: ['low', 'medium', 'high'], quality: 'medium', backgrounds: ['auto', 'keep', 'transparent'], background: 'auto' })
  try {
    assert.equal(view.panel.querySelector('button:disabled'), null)
    await act(() => button(view.panel, '画质', '高画质').click())
    await act(() => button(view.panel, '清晰度', '2K').click())
    await act(() => button(view.panel, '背景', '保留背景').click())
    await act(() => button(view.panel, '比例', '16:9').click())
    assert.deepEqual(view.changes, [{ quality: 'high' }, { clarity: '2K' }, { background: 'keep' }, { ratio: '16:9' }])
    assert.equal(view.panel.textContent?.includes('极致画质'), false)
  } finally { await view.destroy() }
})

test('complete image panel keeps all reference controls selectable and preserves preferences for submission', async () => {
  const model = { modality: 'image', settings: { request_template: {prompt:'{{prompt}}', size:'{{size}}'}, resolutions: defaults.resolutions } } as Model
  const view = await mount({
    ratios: imageRatios, clarities: imageParameterOptions(model, 'clarity'), clarity: imageParameterValue(model, 'clarity'),
    qualities: imageParameterOptions(model, 'quality'), quality: imageParameterValue(model, 'quality'),
    backgrounds: imageParameterOptions(model, 'background'), background: imageParameterValue(model, 'background'),
  })
  try {
    assert.deepEqual([...view.panel.querySelectorAll('[role="group"]')].map(node => node.getAttribute('aria-label')), ['画质', '清晰度', '背景', '比例', '生成候选数量'])
    assert.equal(view.panel.querySelector('button:disabled'), null)
    assert.equal(view.panel.querySelectorAll('[aria-label="画质"] button').length, 5)
    assert.equal(view.panel.querySelectorAll('[aria-label="清晰度"] button').length, 3)
    assert.equal(view.panel.querySelectorAll('[aria-label="背景"] button').length, 3)
    for (const ratio of imageRatios) {
      await act(() => button(view.panel, '比例', ratio).click())
      assert.equal(button(view.panel, '比例', ratio).getAttribute('aria-pressed'), 'true')
    }
    await act(() => button(view.panel, '画质', '极致画质').click())
    await act(() => button(view.panel, '清晰度', '4K').click())
    await act(() => button(view.panel, '背景', '透明背景').click())
    await act(() => button(view.panel, '比例', '16:9').click())
    await act(() => button(view.panel, '生成候选数量', '4张').click())
    assert.deepEqual(view.changes.slice(-5), [{quality:'extreme'}, {clarity:'4K'}, {background:'transparent'}, {ratio:'16:9'}, {count:4}])
    const resolution = imageRequestResolution(model, '1024x1024', {ratio:'16:9',clarity:'4K'})
    const prompt = imagePreferencePrompt(model, '旧相框', {ratio:'16:9',clarity:'4K',quality:'extreme',background:'transparent',resolution})
    assert.equal(resolution, '1536x1024')
    assert.ok(prompt.includes('16:9') && prompt.includes('4K') && prompt.includes('极致画质') && prompt.includes('透明背景'))
  } finally { await view.destroy() }
})

test('image models using resolution levels retain their clarity selector', async () => {
  const view = await mount({ ratios: ['1:1'], resolutions: ['1K', '2K', '4K'], resolution: '1K' })
  try {
    await act(() => button(view.panel, '清晰度', '4K').click())
    assert.deepEqual(view.changes, [{ resolution: '4K' }])
  } finally { await view.destroy() }
})

test('video controls retain supported resolution, ratio and candidate selectors', async () => {
  const view = await mount({ modality: 'video', ratios: ['16:9', '9:16'], ratio: '16:9', resolutions: ['480p', '720p'], resolution: '480p' })
  try {
    await act(() => button(view.panel, '清晰度', '720p').click())
    await act(() => button(view.panel, '比例', '9:16').click())
    assert.deepEqual(view.changes, [{ resolution: '720p' }, { ratio: '9:16' }])
    assert.equal(view.panel.querySelector('[aria-label="画质"]'), null)
    assert.equal(view.panel.querySelector('[aria-label="背景"]'), null)
  } finally { await view.destroy() }
})
