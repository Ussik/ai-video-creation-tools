import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectDetail, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph } from '../src/features/canvas/ProjectCanvas'
import { createReferenceBatch, evaluateReferenceBatch, markReferenceBatchSubmitting, recordReferenceBatchSubmission,
  readReferenceBatch, writeReferenceBatch } from '../src/features/canvas/canvas-reference-batch'

const base = { id: 'base', project_id: 'p', kind: 'character', name: '林晚', variant: '基础', revision: 1,
  definition: '固定五官', view_requirements: '', board_asset_id: null } as VisualProfile
const state = { ...base, id: 'state', base_profile_id: 'base', variant: '雨衣', state_delta: '湿衣' }
const graph = { nodes: [{ id: 'target', settings: {} }], edges: [], revision: 'r' } as unknown as CanvasGraph
const detail = (): ProjectDetail => ({ id: 'p', assets: [], jobs: [], asset_tasks: [], visual_profiles: [base, state] }) as unknown as ProjectDetail
test('base approval unlocks state once; accepted jobs survive reload without duplicate submission', () => {
  const d = detail()
  let batch = createReferenceBatch({ projectId: 'p', canvasId: 'c', targetId: 'target', profileIds: ['state'] }, d)
  assert.deepEqual(evaluateReferenceBatch(batch, graph, d).ready, [{ profileId: 'base' }])
  batch = recordReferenceBatchSubmission(markReferenceBatchSubmitting(batch, 'base'), 'base', ['job'])
  assert.equal(evaluateReferenceBatch(batch, graph, d).ready.length, 0)
  d.visual_profiles = [{ ...base, revision: 2, board_asset_id: 'board' }, state]
  d.assets = [{ id: 'board', kind: 'image' }] as ProjectDetail['assets']
  assert.deepEqual(evaluateReferenceBatch(batch, graph, d).ready, [{ profileId: 'state' }])
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  writeReferenceBatch(batch, storage)
  assert.deepEqual(readReferenceBatch('p', 'c', storage), JSON.parse(JSON.stringify(batch)))
})
test('uncertain submissions and creative changes stop automatically; successful candidates require confirmation', () => {
  const d = detail(), batch = createReferenceBatch({ projectId: 'p', canvasId: 'c', targetId: 'target', profileIds: ['state'] }, d)
  assert.match(evaluateReferenceBatch(markReferenceBatchSubmitting(batch, 'base'), graph, d).blocked[0].message, /不确定/)
  d.visual_profiles = [{ ...base, definition: '新设计' }, state]
  assert.match(evaluateReferenceBatch(batch, graph, d).blocked[0].message, /变化/)
  const submitted = recordReferenceBatchSubmission(batch, 'base', ['job'])
  const current = detail(); current.jobs = [{ id: 'job', status: 'succeeded', result_asset_id: 'candidate' }] as ProjectDetail['jobs']
  assert.match(evaluateReferenceBatch(submitted, graph, current).waiting[0].message, /等待确认/)
})
