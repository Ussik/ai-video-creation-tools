import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitImageNode, imageNodeMinimum } from '../src/canvas-image-layout'

test('portrait results remove side strips without cropping or enlarging the existing frame', () => {
  const size = fitImageNode({ width: 440, height: 420 }, { width: 1024, height: 1536 })
  assert.ok(Math.abs(size.height - 420) < 1e-10)
  assert.ok(size.width < 440)
  assert.ok(Math.abs((size.width - 2) / (size.height - 2) - 2 / 3) < 1e-10)
})

test('landscape, square and extreme ratios fit the complete image and remain resizable', () => {
  for (const [width, height] of [[1536, 1024], [1024, 1024], [2100, 900], [900, 2100]]) {
    const size = fitImageNode({ width: 440, height: 420 }, { width, height })
    assert.ok(size.width >= imageNodeMinimum.width && size.height >= imageNodeMinimum.height)
    assert.ok(size.width <= 440 && size.height <= 420)
    assert.ok(Math.abs((size.width - 2) / (size.height - 2) - width / height) < 1e-10)
    assert.equal(fitImageNode(size, { width, height }), size)
  }
})

test('refresh preserves fitted dimensions and invalid image loads do not change the node', () => {
  const custom = { width: 802, height: 1202 }
  assert.equal(fitImageNode(custom, { width: 1024, height: 1536 }), custom)
  for (const image of [{ width: 0, height: 0 }, { width: NaN, height: 1536 }, { width: 1024, height: Infinity }]) {
    assert.equal(fitImageNode(custom, image), custom)
  }
})
