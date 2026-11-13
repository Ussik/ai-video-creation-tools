import assert from 'node:assert/strict'
import { test } from 'node:test'
import { organizeCanvasNodes, type OrganizeEdge, type OrganizeNode, type OrganizePosition, type OrganizeSize } from '../src/features/canvas/canvas-organize-layout'

function node(id: string, type: string, shot = 'shot-a'): OrganizeNode {
  return { id, type, x: 0, y: 0, width: 100, height: 80, shot_id: shot, settings: { group_id: shot } }
}

const size = (_node: OrganizeNode): OrganizeSize => ({ width: 100, height: 80 })
const shotOrder = (id: string) => id === 'shot-a' ? 0 : id === 'shot-b' ? 1 : undefined

function layout(nodes: OrganizeNode[], edges: OrganizeEdge[]) {
  return organizeCanvasNodes(nodes, edges, size, shotOrder)
}

function assertNoOverlap(nodes: OrganizeNode[], positions: Map<string, OrganizePosition>) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const left = nodes[i], right = nodes[j]
    const a = positions.get(left.id)!, b = positions.get(right.id)!
    assert.ok(a.x + size(left).width <= b.x || b.x + size(right).width <= a.x
      || a.y + size(left).height <= b.y || b.y + size(right).height <= a.y,
    `Nodes overlap: ${left.id} and ${right.id}`)
  }
}

test('places a connected input, generation and result on one horizontal row', () => {
  const nodes = [node('input', 'image'), node('generation', 'generation'), node('result', 'video')]
  const positions = layout(nodes, [{ source: 'input', target: 'generation' }, { source: 'generation', target: 'result' }])
  assert.equal(positions.get('input')!.y, positions.get('generation')!.y)
  assert.equal(positions.get('generation')!.y, positions.get('result')!.y)
  assert.ok(positions.get('input')!.x < positions.get('generation')!.x)
  assert.ok(positions.get('generation')!.x < positions.get('result')!.x)
  assertNoOverlap(nodes, positions)
})

test('fans multiple inputs and results out horizontally without overlap', () => {
  const nodes = [node('input-1', 'image'), node('input-2', 'image'), node('generation', 'generation'),
    node('result-1', 'image'), node('result-2', 'video')]
  const edges = [
    { source: 'input-1', target: 'generation' }, { source: 'input-2', target: 'generation' },
    { source: 'generation', target: 'result-1' }, { source: 'generation', target: 'result-2' },
  ]
  const positions = layout(nodes, edges)
  for (const id of ['input-1', 'input-2']) assert.ok(positions.get(id)!.x < positions.get('generation')!.x)
  for (const id of ['result-1', 'result-2']) assert.ok(positions.get(id)!.x > positions.get('generation')!.x)
  assert.equal(positions.get('input-1')!.x, positions.get('input-2')!.x)
  assert.equal(positions.get('result-1')!.x, positions.get('result-2')!.x)
  assert.notEqual(positions.get('input-1')!.y, positions.get('input-2')!.y)
  assert.notEqual(positions.get('result-1')!.y, positions.get('result-2')!.y)
  assertNoOverlap(nodes, positions)
})

test('puts independent generation flows in separate rows and stacks shot groups in order', () => {
  const nodes = [node('input-a', 'image'), node('generation-a', 'generation'), node('result-a', 'image'),
    node('input-b', 'image', 'shot-b'), node('generation-b', 'generation', 'shot-b'), node('result-b', 'video', 'shot-b')]
  const edges = [
    { source: 'input-a', target: 'generation-a' }, { source: 'generation-a', target: 'result-a' },
    { source: 'input-b', target: 'generation-b' }, { source: 'generation-b', target: 'result-b' },
  ]
  const positions = layout(nodes, edges)
  assert.ok(positions.get('generation-a')!.y < positions.get('generation-b')!.y)
  assert.equal(positions.get('input-a')!.y, positions.get('generation-a')!.y)
  assert.equal(positions.get('input-b')!.y, positions.get('generation-b')!.y)
  assertNoOverlap(nodes, positions)
})

test('keeps shared sources and disconnected script cards visible with deterministic coordinates', () => {
  const nodes = [node('shared', 'image'), node('generation-a', 'generation'), node('generation-b', 'generation'),
    node('script', 'project_script_ref', null), node('orphan-image', 'image', null)]
  const edges = [{ source: 'shared', target: 'generation-a' }, { source: 'shared', target: 'generation-b' }]
  const first = layout(nodes, edges)
  const second = layout(nodes, edges)
  assert.equal(first.size, nodes.length)
  assert.deepEqual([...first], [...second])
  assert.ok(first.get('shared')!.x < first.get('generation-a')!.x)
  assert.ok(first.get('script')!.x + size(nodes[3]).width < first.get('shared')!.x)
  assert.ok(first.get('orphan-image')!.y > first.get('generation-b')!.y)
  assertNoOverlap(nodes, first)
})

test('fans a shared source into ordered generation/result branches without crossing cards', () => {
  const nodes = [node('shared', 'image'), node('generation-a', 'generation'), node('generation-b', 'generation'),
    node('result-a', 'image'), node('result-b', 'video')]
  const edges = [
    { source: 'shared', target: 'generation-a' }, { source: 'shared', target: 'generation-b' },
    { source: 'generation-a', target: 'result-a' }, { source: 'generation-b', target: 'result-b' },
  ]
  const positions = layout(nodes, edges)
  assert.ok(positions.get('shared')!.x < positions.get('generation-a')!.x)
  assert.ok(positions.get('shared')!.x < positions.get('generation-b')!.x)
  assert.ok(positions.get('generation-a')!.x < positions.get('result-a')!.x)
  assert.ok(positions.get('generation-b')!.x < positions.get('result-b')!.x)
  assert.equal(positions.get('generation-a')!.y, positions.get('result-a')!.y)
  assert.equal(positions.get('generation-b')!.y, positions.get('result-b')!.y)
  assert.notEqual(positions.get('generation-a')!.y, positions.get('generation-b')!.y)
  assertNoOverlap(nodes, positions)
})

test('keeps a multi-stage generation pipeline in one left-to-right row', () => {
  const nodes = [node('input', 'image'), node('generation-a', 'generation'), node('intermediate', 'image'),
    node('generation-b', 'generation'), node('final', 'video')]
  const edges = [
    { source: 'input', target: 'generation-a' }, { source: 'generation-a', target: 'intermediate' },
    { source: 'intermediate', target: 'generation-b' }, { source: 'generation-b', target: 'final' },
  ]
  const positions = layout(nodes, edges)
  for (const node of nodes) assert.equal(positions.get(node.id)!.y, positions.get('input')!.y)
  for (const edge of edges) assert.ok(positions.get(edge.source)!.x < positions.get(edge.target)!.x)
  assertNoOverlap(nodes, positions)
})

test('uses generation grouping when connected source metadata belongs to another shot', () => {
  const source = node('source', 'image', 'shot-b')
  const generation = node('generation', 'generation', 'shot-a')
  const result = node('result', 'video', 'shot-a')
  const nodes = [source, generation, result]
  const positions = layout(nodes, [{ source: source.id, target: generation.id }, { source: generation.id, target: result.id }])
  assert.equal(positions.get(source.id)!.y, positions.get(generation.id)!.y)
  assert.equal(positions.get(generation.id)!.y, positions.get(result.id)!.y)
  assert.ok(positions.get(source.id)!.x < positions.get(generation.id)!.x)
  assert.ok(positions.get(generation.id)!.x < positions.get(result.id)!.x)
})
