import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectDetail, Shot } from '../src/shared/api/api'
import { allProjectShots, canvasDesignShots } from '../src/features/canvas/canvas-design-scope'

test('historical shot metadata remains browseable while default imports stay in the canvas design', () => {
  const legacy = { id: 'legacy', title: '历史镜头', design_id: null, superseded_by: 'new' } as Shot
  const oldDesign = { id: 'old-design-shot', design_id: 'old', superseded_by: 'new' } as Shot
  const current = { id: 'new-shot', design_id: 'new' } as Shot
  const other = { id: 'other-active', design_id: 'other' } as Shot
  const detail = { shots: [current, other], historical_shots: [legacy, oldDesign] } as Pick<ProjectDetail, 'shots' | 'historical_shots'>
  assert.deepEqual(allProjectShots(detail).map(shot => shot.id), ['legacy', 'old-design-shot', 'new-shot', 'other-active'])
  assert.deepEqual(canvasDesignShots(detail).map(shot => shot.id), ['legacy'])
  assert.deepEqual(canvasDesignShots(detail, 'old').map(shot => shot.id), ['old-design-shot'])
  assert.deepEqual(canvasDesignShots(detail, 'new').map(shot => shot.id), ['new-shot'])
  assert.deepEqual(canvasDesignShots(detail, 'empty'), [])
  assert.equal(allProjectShots({ shots: [legacy] })[0], legacy)
})

test('a newer active snapshot wins over a duplicated historical shot without mixing design scopes', () => {
  const historical = { id: 'same', title: '旧标题', design_id: 'current' } as Shot
  const current = { ...historical, title: '已更新标题' }
  const detail = { shots: [current], historical_shots: [historical] }
  assert.deepEqual(allProjectShots(detail), [current])
  assert.deepEqual(canvasDesignShots(detail, 'current'), [current])
})
