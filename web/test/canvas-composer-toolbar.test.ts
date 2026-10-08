import assert from 'node:assert/strict'
import test from 'node:test'
import { composerViewportShift } from '../src/CanvasComposerToolbar.tsx'

const canvas = { left: 70, top: 0, right: 1510, bottom: 900 }

test('composer already inside the usable canvas needs no position shift', () => {
  assert.deepEqual(composerViewportShift({ left: 450, top: 280, right: 1170, bottom: 600 }, canvas), { x: 0, y: 0 })
})

test('right and bottom overflow shift only by the pixels required to reveal the composer', () => {
  assert.deepEqual(composerViewportShift({ left: 1000, top: 700, right: 1720, bottom: 1040 }, canvas), { x: -230, y: -230 })
})

test('left and top overflow preserve navigation margins', () => {
  assert.deepEqual(composerViewportShift({ left: -150, top: -30, right: 570, bottom: 290 }, canvas), { x: 240, y: 102 })
})

test('an open left sidebar reserves its width while an off-canvas sidebar does not', () => {
  const composer = { left: 170, top: 150, right: 890, bottom: 470 }
  assert.deepEqual(composerViewportShift(composer, canvas, { left: 88, top: 76, right: 406, bottom: 882 }), { x: 252, y: 0 })
  assert.deepEqual(composerViewportShift(composer, canvas, { left: -400, top: 76, right: 0, bottom: 882 }), { x: 0, y: 0 })
})

test('a composer larger than a small viewport aligns its leading edges without oscillating', () => {
  const smallCanvas = { left: 0, top: 0, right: 390, bottom: 500 }
  const first = composerViewportShift({ left: -160, top: 360, right: 560, bottom: 860 }, smallCanvas)
  assert.deepEqual(first, { x: 180, y: -288 })
  assert.deepEqual(composerViewportShift({ left: 20, top: 72, right: 740, bottom: 572 }, smallCanvas), { x: 0, y: 0 })
})

test('canvas offset is included and invalid geometry does not shift the composer', () => {
  assert.deepEqual(composerViewportShift({ left: 230, top: 20, right: 950, bottom: 340 },
    { left: 220, top: 44, right: 1660, bottom: 944 }), { x: 10, y: 96 })
  assert.deepEqual(composerViewportShift({ left: NaN, top: 20, right: 950, bottom: 340 }, canvas), { x: 0, y: 0 })
})
