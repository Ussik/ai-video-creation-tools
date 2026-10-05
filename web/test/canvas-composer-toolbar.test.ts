import assert from 'node:assert/strict'
import test from 'node:test'
import { composerViewportFit, composerViewportShift } from '../src/CanvasComposerToolbar.tsx'

const canvas = { left: 70, top: 0, right: 1510, bottom: 900 }

test('composer already inside the usable canvas does not move the viewport', () => {
  assert.deepEqual(composerViewportShift({ left: 450, top: 280, right: 1170, bottom: 600 }, canvas), { x: 0, y: 0 })
})

test('right and bottom overflow pan only by the pixels required to reveal the composer', () => {
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

test('canvas offset is included and invalid geometry does not change the viewport', () => {
  assert.deepEqual(composerViewportShift({ left: 230, top: 20, right: 950, bottom: 340 },
    { left: 220, top: 44, right: 1660, bottom: 944 }), { x: 10, y: 96 })
  assert.deepEqual(composerViewportShift({ left: NaN, top: 20, right: 950, bottom: 340 }, canvas), { x: 0, y: 0 })
})

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} should be near ${expected}`)
}

test('fitting a tall video and composer keeps the title and full composer visible together', () => {
  const node = { x: 500, y: 200, width: 720, height: 405 }
  const viewport = { x: 0, y: 0, zoom: 1 }
  const next = composerViewportFit(viewport, node, { width: 720, height: 345 }, canvas)
  near(next.zoom, 333 / 405)
  near(node.y * next.zoom + next.y - 36, 72)
  near((node.y + node.height) * next.zoom + next.y + 24 + 345, 810)
  near((node.x + node.width / 2) * next.zoom + next.x, node.x + node.width / 2)
})

test('a high zoom is reduced only as much as needed and a fitting low zoom is never enlarged', () => {
  const node = { x: 350, y: 150, width: 720, height: 405 }
  const next = composerViewportFit({ x: -900, y: -350, zoom: 2.5 }, node, { width: 720, height: 300 }, canvas)
  near(next.zoom, 378 / 405)
  assert.ok(node.y * next.zoom + next.y - 36 >= 72 - 0.001)
  assert.ok((node.y + node.height) * next.zoom + next.y + 24 + 300 <= 810 + 0.001)
  const small = composerViewportFit({ x: 250, y: 100, zoom: 0.4 }, node, { width: 720, height: 300 }, canvas)
  assert.equal(small.zoom, 0.4)
})

test('an already visible node and composer preserve the entire viewport exactly', () => {
  const viewport = { x: 10, y: 20, zoom: 1 }
  const node = { x: 400, y: 120, width: 720, height: 300 }
  assert.deepEqual(composerViewportFit(viewport, node, { width: 720, height: 250 }, canvas), viewport)
})

test('a small screen reduces only the node while respecting the fixed composer size', () => {
  const smallCanvas = { left: 0, top: 0, right: 800, bottom: 650 }
  const node = { x: 40, y: 90, width: 720, height: 405 }
  const next = composerViewportFit({ x: 0, y: 0, zoom: 1 }, node, { width: 720, height: 300 }, smallCanvas)
  near(next.zoom, 128 / 405)
  near(node.y * next.zoom + next.y - 36, 72)
  near((node.y + node.height) * next.zoom + next.y + 24 + 300, 560)
  near((node.x + node.width / 2) * next.zoom + next.x, 400)
})

test('minimum zoom is respected when even the smallest node cannot fit, and repeated fitting is stable', () => {
  const tinyCanvas = { left: 0, top: 0, right: 800, bottom: 450 }
  const node = { x: 40, y: 90, width: 720, height: 405 }
  const size = { width: 720, height: 300 }
  const next = composerViewportFit({ x: 0, y: 0, zoom: 1 }, node, size, tinyCanvas)
  assert.equal(next.zoom, 0.1)
  near(node.y * next.zoom + next.y - 36, 72)
  assert.deepEqual(composerViewportFit(next, node, size, tinyCanvas), next)
})
