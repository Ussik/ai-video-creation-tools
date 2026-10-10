import assert from 'node:assert/strict'
import test from 'node:test'
import { composerCanvasBounds, composerRectInArea, placeCanvasComposer, type ComposerSize, type ScreenRect } from '../src/canvas-composer-placement.ts'

const canvas = { left: 70, top: 0, right: 1510, bottom: 900 }
const preferred = { width: 720, height: 400 }
const overlaps = (a: ScreenRect, b: ScreenRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
function checkPlacement(size: ComposerSize, node: ScreenRect, bounds = canvas, sidebar?: ScreenRect) {
  const placement = placeCanvasComposer(size, node, bounds, sidebar)
  assert.ok(placement)
  const safe = composerCanvasBounds(bounds, sidebar)
  assert.ok(placement.rect.left >= safe.left && placement.rect.right <= safe.right)
  assert.ok(placement.rect.top >= safe.top && placement.rect.bottom <= safe.bottom)
  assert.equal(overlaps(placement.rect, placement.reframe?.node || node), false)
  assert.ok(placement.maxWidth > 0 && placement.maxHeight > 0)
  return placement
}

test('an editor stays below the selected node when the complete editor fits', () => {
  const node = { left: 510, top: 100, right: 910, bottom: 350 }
  const result = checkPlacement(preferred, node)
  assert.equal(result.side, 'bottom')
  assert.equal(result.rect.top, node.bottom + 24)
  assert.equal(result.reframe, undefined)
})

test('bottom overflow uses a side instead of pushing the editor over the image', () => {
  const node = { left: 200, top: 400, right: 600, bottom: 700 }
  const result = checkPlacement(preferred, node)
  assert.equal(result.side, 'right')
  assert.equal(result.rect.left, node.right + 24)
  assert.equal(result.reframe, undefined)
})

test('a long editor is constrained to free space beside a near-edge node', () => {
  const result = checkPlacement({ width: 900, height: 800 }, { left: 850, top: 200, right: 1250, bottom: 600 })
  assert.equal(result.side, 'left')
  assert.equal(result.maxHeight, 738)
  assert.ok(result.maxWidth < 900)
  assert.equal(result.reframe, undefined)
})

test('an open sidebar is reserved and a sidebar outside the canvas is ignored', () => {
  const node = { left: 1000, top: 200, right: 1400, bottom: 600 }
  const visible = { left: 88, top: 76, right: 406, bottom: 882 }
  const result = checkPlacement(preferred, node, canvas, visible)
  assert.ok(result.rect.left >= 422)
  assert.deepEqual(placeCanvasComposer(preferred, node, canvas, { ...visible, left: -400, right: 0 }), placeCanvasComposer(preferred, node, canvas))
})

test('a narrow viewport reframes the preview above a scrollable editor', () => {
  const result = checkPlacement(preferred, { left: 20, top: 100, right: 420, bottom: 400 }, { left: 0, top: 0, right: 390, bottom: 600 })
  assert.equal(result.side, 'bottom')
  assert.ok(result.reframe)
  assert.ok(result.reframe.scale < 1)
  assert.ok(result.reframe.node.bottom + 24 <= result.rect.top)
})

test('a zoomed node and editor can be framed together without resizing saved node dimensions', () => {
  const result = checkPlacement({ width: 900, height: 700 }, { left: -250, top: -100, right: 1300, bottom: 900 })
  assert.equal(result.side, 'right')
  assert.ok(result.reframe)
  assert.ok(result.reframe.scale > 0 && result.reframe.scale < 1)
  assert.ok(result.reframe.node.right + 24 <= result.rect.left)
})

test('measuring a smaller actual editor keeps top and left placements separated', () => {
  const node = { left: 900, top: 500, right: 1300, bottom: 800 }
  const top = { left: 90, top: 72, right: 1490, bottom: 476 }
  const left = { left: 90, top: 72, right: 876, bottom: 810 }
  assert.equal(composerRectInArea({ width: 500, height: 300 }, node, top, 'top').bottom, node.top - 24)
  assert.equal(composerRectInArea({ width: 500, height: 300 }, node, left, 'left').right, node.left - 24)
})

test('canvas offsets are included and invalid geometry is rejected', () => {
  checkPlacement(preferred, { left: 500, top: 200, right: 900, bottom: 450 }, { left: 220, top: 44, right: 1660, bottom: 944 })
  assert.equal(placeCanvasComposer(preferred, { left: NaN, top: 200, right: 900, bottom: 450 }, canvas), null)
  assert.equal(placeCanvasComposer({ width: 0, height: 300 }, { left: 500, top: 200, right: 900, bottom: 450 }, canvas), null)
})

test('wrapped bottom tools and editor actions reserve real space on narrow screens', () => {
  const bounds = { left: 0, top: 0, right: 390, bottom: 600 }
  const options = { topInset: 72, bottomInset: 176 }
  const result = placeCanvasComposer({ ...preferred, minHeight: 320 }, { left: 20, top: 90, right: 619, bottom: 470 }, bounds, undefined, options)
  assert.ok(result?.reframe)
  assert.ok(result.rect.bottom <= 424)
  assert.ok(result.maxHeight >= 270)
  assert.equal(overlaps(result.rect, result.reframe.node), false)
})

test('very large nodes respect the zoom floor and do not repeatedly reframe', () => {
  const node = { left: -800, top: -900, right: 12000, bottom: 8000 }
  const options = { minScale: 0.1 }
  const result = placeCanvasComposer(preferred, node, canvas, undefined, options)
  assert.ok(result?.reframe)
  assert.equal(result.reframe.scale, 0.1)
  assert.equal(overlaps(result.rect, result.reframe.node), false)
  const settled = placeCanvasComposer(preferred, result.reframe.node, canvas, undefined, { minScale: 1 })
  assert.ok(settled)
  assert.equal(settled.reframe, undefined)
  assert.equal(overlaps(settled.rect, result.reframe.node), false)
})
