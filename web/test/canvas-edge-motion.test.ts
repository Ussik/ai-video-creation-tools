import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleEdgeMotion } from '../src/canvas-edge-motion'

const viewport = { x: 0, y: 0, zoom: 1 }
function position(transform: string) { return transform.match(/-?[\d.]+/g)!.map(Number) }

test('motion follows the actual cubic in source-to-target order and uses distance offsets', () => {
  const result = visibleEdgeMotion('M10,20 C80,20 40,90 110,90', viewport, 200, 200)!
  assert.ok(result)
  assert.deepEqual(position(result.keyframes[0].transform), [10, 20])
  assert.deepEqual(position(result.keyframes.at(-1)!.transform), [110, 90])
  assert.equal(result.keyframes[0].opacity, 0); assert.equal(result.keyframes.at(-1)!.opacity, 0)
  for (let i = 1; i < result.keyframes.length; i++) assert.ok(result.keyframes[i].offset > result.keyframes[i - 1].offset)
  assert.ok(result.keyframes.some(frame => frame.opacity === 1))
  assert.ok(result.duration >= 1200 && result.duration <= 3200)
})

test('crossing connections animate only inside the transformed viewport, including distant endpoints', () => {
  const result = visibleEdgeMotion('M-500,50 C-200,50 200,50 500,50', { x: -20, y: -10, zoom: 2 }, 160, 160)!
  assert.ok(result)
  const positions = result.keyframes.map(frame => position(frame.transform))
  assert.equal(positions[0][0], 10); assert.equal(positions.at(-1)![0], 90)
  assert.ok(positions.every(([, y]) => Math.abs(y - 50) < 1e-8))
  assert.ok(positions.every(([x, y]) => x >= 10 && x <= 90 && y >= 5 && y <= 85))
})

test('offscreen, invalid and very short connections allocate no motion', () => {
  assert.equal(visibleEdgeMotion('M0,500 C40,500 80,500 120,500', viewport, 200, 200), null)
  assert.equal(visibleEdgeMotion('M0,0 C1,0 2,0 3,0', viewport, 200, 200), null)
  for (const path of ['', 'M0,0 L100,0', 'M0,0 C1,2 3,4 5,Infinity']) assert.equal(visibleEdgeMotion(path, viewport, 200, 200), null)
  assert.equal(visibleEdgeMotion('M0,0 C50,0 100,0 150,0', { ...viewport, zoom: 0 }, 200, 200), null)
})

test('decimal curves stay continuous across sampled segments', () => {
  const result = visibleEdgeMotion('M0.1,0.2 C80.31,20.27 140.12,180.76 199.1,199.2', viewport, 200, 200)!
  assert.ok(result)
  assert.deepEqual(position(result.keyframes[0].transform), [0.1, 0.2])
  assert.deepEqual(position(result.keyframes.at(-1)!.transform), [199.1, 199.2])
  assert.equal(result.keyframes.length, 97, 'roundoff does not split a fully visible curve')
})
