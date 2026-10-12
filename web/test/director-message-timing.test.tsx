import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import DirectorMessageTiming, { finishMessageTiming, formatProcessingDuration, type MessageTiming } from '../src/features/script/DirectorMessageTiming'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

async function mount(props: MessageTiming & { pending?: boolean }) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const update = async (next: typeof props) => { await act(() => root.render(<DirectorMessageTiming {...next} />)) }
  await update(props)
  return { container, update, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('duration formatting handles subsecond, minute and hour boundaries without rounding into the next minute', () => {
  assert.equal(formatProcessingDuration(0), '0.0 秒')
  assert.equal(formatProcessingDuration(1250), '1.2 秒')
  assert.equal(formatProcessingDuration(59_999), '59.9 秒')
  assert.equal(formatProcessingDuration(60_000), '1 分 0 秒')
  assert.equal(formatProcessingDuration(125_900), '2 分 5 秒')
  assert.equal(formatProcessingDuration(3_661_000), '1 小时 1 分 1 秒')
})

test('finishing a request records its own monotonic elapsed time and removes the live start', () => {
  assert.deepEqual(finishMessageTiming(1000, 2250.4), { processing_started_at: undefined, processing_duration_ms: 1250 })
  assert.equal(finishMessageTiming(0, 0).processing_duration_ms, 0)
  assert.equal(finishMessageTiming(2000, 1000).processing_duration_ms, 0)
})

test('live elapsed time updates, freezes when stopped, restarts per new reply and cleans up on unmount', async () => {
  let now = 1000
  let nextId = 0
  const ticks = new Map<number, () => void>()
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
  const originalInterval = dom.window.setInterval
  const originalClear = dom.window.clearInterval
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  dom.window.setInterval = callback => { const id = ++nextId; ticks.set(id, callback as () => void); return id }
  dom.window.clearInterval = id => { ticks.delete(id) }
  let view: Awaited<ReturnType<typeof mount>> | undefined
  try {
    view = await mount({ pending: true, processing_started_at: 0 })
    assert.equal(view.container.textContent, '处理中 1.0 秒')
    assert.equal(ticks.size, 1)
    now = 2250
    await act(() => { for (const tick of ticks.values()) tick() })
    assert.equal(view.container.textContent, '处理中 2.2 秒')
    await view.update({ pending: false, ...finishMessageTiming(0, now) })
    assert.equal(view.container.textContent, '用时 2.2 秒')
    assert.equal(ticks.size, 0)
    now = 60_000
    await act(() => { for (const tick of ticks.values()) tick() })
    assert.equal(view.container.textContent, '用时 2.2 秒')
    await view.update({ pending: true, processing_started_at: now })
    assert.equal(view.container.textContent, '处理中 0.0 秒')
    assert.equal(ticks.size, 1)
    now += 1200
    await act(() => { for (const tick of ticks.values()) tick() })
    assert.equal(view.container.textContent, '处理中 1.2 秒')
  } finally {
    await view?.destroy()
    assert.equal(ticks.size, 0)
    dom.window.setInterval = originalInterval
    dom.window.clearInterval = originalClear
    if (originalNow) Object.defineProperty(performance, 'now', originalNow)
    else Reflect.deleteProperty(performance, 'now')
  }
})

test('historical recorded durations display without starting a timer; absent or invalid durations stay hidden', async () => {
  const view = await mount({ processing_duration_ms: 82_000 })
  try {
    assert.equal(view.container.textContent, '用时 1 分 22 秒')
    for (const duration of [undefined, null, -1, NaN, Infinity]) {
      await view.update({ processing_duration_ms: duration })
      assert.equal(view.container.childElementCount, 0)
    }
    await view.update({ processing_duration_ms: 0 })
    assert.equal(view.container.textContent, '用时 0.0 秒')
  } finally { await view.destroy() }
})
