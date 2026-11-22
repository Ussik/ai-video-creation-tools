import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampDirectorWindow, defaultDirectorWindow, shouldSendDirectorMessage } from '../src/features/script/director-window'

test('dragging and resizing keep the full director window reachable', () => {
  assert.deepEqual(clampDirectorWindow({ x: 1600, y: -50, width: 900, height: 1000 }, { width: 1500, height: 800 }),
    { x: 768, y: 12, width: 720, height: 776 })
  const normal = defaultDirectorWindow({ width: 1500, height: 800 })
  assert.deepEqual(clampDirectorWindow(normal, { width: 1500, height: 800 }), normal)
})

test('a saved desktop window fits a small viewport without inaccessible controls', () => {
  const small = clampDirectorWindow({ x: 1100, y: 400, width: 600, height: 650 }, { width: 320, height: 360 })
  assert.deepEqual(small, { x: 12, y: 12, width: 296, height: 336 })
})

test('expanded and minimized windows stay below the workspace tabs', () => {
  const viewport = { width: 1200, height: 720, top: 64 }
  const rect = { x: 600, y: 0, width: 520, height: 680 }
  assert.deepEqual(clampDirectorWindow(rect, viewport), { ...rect, y: 76, height: 632 })
  assert.equal(clampDirectorWindow({ ...rect, y: 700 }, viewport, 68).y, 640)
})

test('Enter submits while Shift+Enter and Chinese IME confirmation do not', () => {
  assert.equal(shouldSendDirectorMessage({ key: 'Enter', shiftKey: false }), true)
  assert.equal(shouldSendDirectorMessage({ key: 'Enter', shiftKey: true }), false)
  assert.equal(shouldSendDirectorMessage({ key: 'Enter', shiftKey: false, isComposing: true }), false)
  assert.equal(shouldSendDirectorMessage({ key: 'Enter', shiftKey: false, keyCode: 229 }), false)
  assert.equal(shouldSendDirectorMessage({ key: 'a', shiftKey: false }), false)
})
