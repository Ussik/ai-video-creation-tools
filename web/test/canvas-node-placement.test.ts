import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canvasNodeGap, freeCanvasPosition, placeNewCanvasNodes, type CanvasRectangle } from '../src/features/canvas/canvas-node-placement'

const rectangle = (id: string, x = 0, y = 0, width = 440, height = 420) => ({ id, x, y, width, height })
function assertSeparated(a: CanvasRectangle, b: CanvasRectangle) {
  const epsilon = 1e-8
  assert.ok(a.x + a.width + canvasNodeGap <= b.x + epsilon
    || b.x + b.width + canvasNodeGap <= a.x + epsilon
    || a.y + a.height + canvasNodeGap <= b.y + epsilon
    || b.y + b.height + canvasNodeGap <= a.y + epsilon, `Cards overlap: ${JSON.stringify([a, b])}`)
}

test('unused requested positions and exact gap boundaries remain unchanged', () => {
  const old = rectangle('old')
  const fresh = rectangle('new', 440 + canvasNodeGap, 0)
  const next = [old, fresh]
  assert.equal(placeNewCanvasNodes([old], next), next)
  assert.deepEqual(freeCanvasPosition(rectangle('empty', -345.5, 719.25), []), { x: -345.5, y: 719.25 })
})

test('blocked positions move to a nearby gap, instead of drifting diagonally or beyond the whole canvas', () => {
  const old = rectangle('old', 0, 0, 100, 100)
  const distant = rectangle('distant', 50000, 50000)
  const node = rectangle('new', 20, 20, 100, 100)
  assert.deepEqual(freeCanvasPosition(node, [old, distant]), { x: 100 + canvasNodeGap, y: 20 })
  // The gap between two occupied intervals remains usable even when their
  // forbidden boundaries touch; a coarse scan would easily miss it.
  const right = rectangle('right', 296, 0, 100, 100)
  assert.deepEqual(freeCanvasPosition(rectangle('middle', 148, 0, 100, 100), [old, right]), { x: 148, y: 0 })
})

test('batch creation avoids both existing cards and earlier additions without mutating inputs', () => {
  const previous = [rectangle('left', -350, 80, 400, 272), rectangle('large', 80, 80, 800, 650)]
  const next = [...previous, rectangle('reference', -270, 80, 400, 272), rectangle('video', 690, 80),
    rectangle('copy', 128, 128, 800, 650), rectangle('upload', 690, 110, 400, 272)]
  const before = structuredClone(next)
  const placed = placeNewCanvasNodes(previous, next)
  assert.deepEqual(next, before)
  assert.equal(placed[0], previous[0])
  assert.equal(placed[1], previous[1])
  for (let index = previous.length; index < placed.length; index++) {
    for (let other = 0; other < index; other++) assertSeparated(placed[index], placed[other])
  }
})

test('placement uses rendered sizes and the updated graph, including edits/removals in the same action', () => {
  const old = rectangle('old', 0, 0, 80, 80)
  const resized = { ...old, width: 700, height: 600 }
  const newNode = rectangle('new', 500, 0, 80, 80)
  const resolve = (node: typeof old) => ({ width: Math.max(node.width, 440), height: Math.max(node.height, 420) })
  const placed = placeNewCanvasNodes([old], [resized, newNode], resolve)
  assert.equal(placed[0], resized)
  assertSeparated({ ...placed[0], ...resolve(placed[0]) }, { ...placed[1], ...resolve(placed[1]) })
  const removed = placeNewCanvasNodes([old], [newNode])
  assert.equal(removed[0], newNode)
})

test('manual dragging and prompt edits preserve exact geometry even when existing cards overlap', () => {
  const previous = [rectangle('first'), rectangle('second', 700, 0)]
  const next = [previous[0], { ...previous[1], x: 48, y: 48, prompt: 'edited' }]
  assert.equal(placeNewCanvasNodes(previous, next), next)
  const empty: typeof previous = []
  assert.equal(placeNewCanvasNodes([], empty), empty)
})

test('dense irregular canvases and repeated same-position additions stay separated and in coordinate limits', () => {
  const previous = Array.from({ length: 350 }, (_, index) => rectangle(`old-${index}`,
    index % 25 * 175 - 1900.25, Math.floor(index / 25) * 130 - 920.5,
    120 + index % 7 * 29, 90 + index % 9 * 31))
  const additions = Array.from({ length: 150 }, (_, index) => rectangle(`new-${index}`, -300.25, -100.75,
    160 + index % 4 * 90, 180 + index % 6 * 110))
  const placed = placeNewCanvasNodes(previous, [...previous, ...additions])
  assert.deepEqual(placed.slice(0, previous.length), previous)
  for (let index = previous.length; index < placed.length; index++) {
    for (let other = 0; other < index; other++) assertSeparated(placed[index], placed[other])
    assert.ok(Math.abs(placed[index].x) <= 1_000_000 && Math.abs(placed[index].y) <= 1_000_000)
  }
  for (const sign of [1, -1]) {
    const old = rectangle('boundary', sign * 1_000_000, sign * 1_000_000, 5000, 5000)
    const pos = freeCanvasPosition(old, [old])
    assert.ok(Math.abs(pos.x) <= 1_000_000 && Math.abs(pos.y) <= 1_000_000)
    assertSeparated({ ...old, ...pos }, old)
  }
})
