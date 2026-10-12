import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, canvasNode, projectId } from './fixtures/final-cut'
import { findShotCanvasTarget, shotCanvasNode } from '../src/features/canvas/canvas-shot-navigation'

test('shot lookup excludes visual profiles and prioritizes video generation nodes', () => {
  const profile = canvasNode('profile', 's1'); profile.settings.visual_profile_id = 'profile'
  const image = canvasNode('image', 's1'); image.settings.modality = 'image'
  const video = canvasNode('video', 's1')
  assert.equal(shotCanvasNode([profile, canvasNode('media', 's1', 'image'), image, video], 's1')?.id, 'video')
  const media = canvasNode('selected', null, 'video'); media.asset_id = 'chosen'
  assert.equal(shotCanvasNode([profile, media], 's1', 'chosen')?.id, 'selected')
  const legacy = { ...canvasNode('legacy', 's1'), settings: undefined }
  assert.equal(shotCanvasNode([legacy as unknown as ReturnType<typeof canvasNode>], 's1')?.id, 'legacy')
})
test('lookup searches preferred canvas first, then finds the existing node elsewhere', async () => {
  const data = fixture(), reads: string[] = []
  const target = await findShotCanvasTarget(data.canvases, projectId, 's1', 'video', async canvas => {
    reads.push(canvas.id); return data.graphs[canvas.id]
  })
  assert.deepEqual(target, { canvasId: 'second', shotId: 's1', nodeId: 'video-node' })
  assert.deepEqual(reads, [projectId, 'second'])
  reads.length = 0
  await findShotCanvasTarget(data.canvases, 'second', 's1', null, async canvas => { reads.push(canvas.id); return data.graphs[canvas.id] })
  assert.deepEqual(reads, ['second'])
})
test('lookup allows targeted import only after successfully checking all canvases', async () => {
  const data = fixture()
  const empty = async () => ({ revision: 'r', nodes: [], edges: [] })
  assert.deepEqual(await findShotCanvasTarget(data.canvases, 'second', 's1', null, empty), { canvasId: 'second', shotId: 's1' })
  await assert.rejects(findShotCanvasTarget(data.canvases, projectId, 's1', null, async canvas => {
    if (canvas.id === 'second') throw new Error('network error')
    return empty()
  }), /部分画布读取失败/)
})
