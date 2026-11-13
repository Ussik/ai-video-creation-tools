import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { seedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { videoDefaultDuration, videoDefaultRatio, videoModelConfigError } from '@video-studio/shared/models/video-model-settings'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: VideoModelConfig } = await import('../src/features/models/VideoModelConfig')
after(() => dom.window.close())

test('video defaults reject values outside the configured capability while keeping unset legacy defaults', () => {
  const settings = seedance25VideoSettings()
  assert.equal(videoModelConfigError(settings), null)
  assert.equal(videoModelConfigError({ ...settings, default_duration: 31 }), '默认视频时长必须在模型支持的时长范围内')
  assert.match(videoModelConfigError({ ...settings, default_duration: '12' })!, /整数/)
  assert.match(videoModelConfigError({ ...settings, default_resolution: '4k' })!, /可选列表/)
  assert.match(videoModelConfigError({ ...settings, default_ratio: '32:9' })!, /可选列表/)
  assert.equal(videoDefaultDuration(), 5)
  assert.equal(videoDefaultDuration({ default_duration: 12 }), 12)
  assert.equal(videoDefaultRatio({ default_ratio: '9:16' }, ['16:9', '9:16'], '16:9'), '9:16')
  assert.equal(videoDefaultRatio({}, ['16:9', '9:16'], '9:16'), '9:16')
})

test('video form changes actual defaults without rebuilding the request or dropping provider overrides', async () => {
  const original = { ...seedance25VideoSettings(), custom: { keep: true }, api_base_url: 'https://video.invalid/api/v3', pricing: { per_second: 0.1 } }
  let saved: Record<string, unknown> = original
  function Harness() {
    const [value, setValue] = useState(JSON.stringify(original))
    return <MantineProvider env="test"><VideoModelConfig value={value} onChange={next => { saved = next; setValue(JSON.stringify(next)) }} onError={assert.equal.bind(null, '')} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<Harness />))
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '默认视频时长（秒）')!
    const input = document.getElementById(label.htmlFor) as HTMLInputElement
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '12')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.equal(saved.default_duration, 12)
    assert.deepEqual(saved.request_template, original.request_template)
    assert.deepEqual(saved.custom, original.custom)
    assert.deepEqual(saved.pricing, original.pricing)
    assert.equal(saved.api_base_url, original.api_base_url)
  } finally { await act(() => root.unmount()); container.remove() }
})
