import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasGraph, CanvasNode } from '../src/ProjectCanvas'
import type { Shot } from '../src/api'
import { canvasPromptIndex, canvasReferenceKey, indexedCanvasPrompt, reuseFlowEdge, reuseFlowNode, sameCanvasContent, shouldVirtualizeCanvas, updateCanvasGeometry } from '../src/canvas-performance'

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type: 'text', x: 0, y: 0, width: 420, height: 340, title: '', text: '', prompt: '',
    asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {}, ...patch }
}

test('visibility pruning activates for link/media-heavy canvases before the old80-node limit', () => {
  const nodes = Array.from({ length: 54 }, (_, index) => node(String(index)))
  assert.equal(shouldVirtualizeCanvas(nodes, 155), true)
  assert.equal(shouldVirtualizeCanvas(nodes.slice(0, 10), 49), true)
  assert.equal(shouldVirtualizeCanvas(nodes.slice(0, 8).map(node => ({ ...node, type: 'video' })), 0), true)
  assert.equal(shouldVirtualizeCanvas(nodes.slice(0, 4), 2), false)
})

test('a 500-node drag batch preserves untouched identities, moves groups once and removes only requested nodes', () => {
  const nodes = Array.from({ length: 500 }, (_, index) => node(String(index), { x: index * 500 }))
  nodes[0].settings = { group_id: 'pair' }; nodes[1].settings = { group_id: 'pair' }
  const single = updateCanvasGeometry(nodes, [{ type: 'position', id: '0', position: { x: 24, y: 36 }, dragging: true }], false)
  assert.deepEqual(single.slice(0, 2).map(node => [node.x, node.y]), [[24, 36], [524, 36]])
  assert.ok(single.slice(2).every((node, index) => node === nodes[index + 2]))
  const multi = updateCanvasGeometry(nodes, [
    { type: 'position', id: '0', position: { x: 24, y: 36 }, dragging: true },
    { type: 'position', id: '1', position: { x: 524, y: 36 }, dragging: true },
  ], false)
  assert.deepEqual(multi.slice(0, 2).map(node => [node.x, node.y]), [[24, 36], [524, 36]], 'each group member receives one delta')
  assert.equal(updateCanvasGeometry(single, [{ type: 'position', id: '0', position: { x: 24, y: 36 }, dragging: false }], true), single)
  const removed = updateCanvasGeometry(single, [{ type: 'remove', id: '499' }], false)
  assert.equal(removed.length, 499)
  assert.ok(removed.every((node, index) => node === single[index]))
})

test('resize batches preserve existing grouped positions and ignore missing IDs and empty dimensions', () => {
  const nodes = [node('a', { settings: { group_id: 'pair' } }), node('b', { x: 500, settings: { group_id: 'pair' } })]
  const resized = updateCanvasGeometry(nodes, [
    { type: 'dimensions', id: 'a', dimensions: { width: 540, height: 360 } },
    { type: 'position', id: 'a', position: { x: -120, y: -20 } },
    { type: 'position', id: 'missing', position: { x: 50, y: 50 } },
  ], true)
  assert.deepEqual([resized[0].x, resized[0].y, resized[0].width, resized[0].height], [-120, -20, 540, 360])
  assert.equal(resized[1], nodes[1])
  assert.equal(updateCanvasGeometry(resized, [{ type: 'dimensions', id: 'a', dimensions: { width: 0, height: 0 } }], false), resized)
})

test('prompt index retains connection order, overrides, shot fallback and script context', () => {
  const nodes = [node('first', { text: '第一条\n' }), node('second', { text: ' 第二条 ' }), node('script', { type: 'project_script_ref' }),
    node('target', { type: 'generation', shot_id: 'shot', prompt: '' })]
  const graph: CanvasGraph = { nodes, revision: '', edges: [
    { id: '1', source: 'second', target: 'target' }, { id: '2', source: 'script', target: 'target' },
    { id: '3', source: 'first', target: 'target' }, { id: '4', source: 'missing', target: 'target' },
  ] }
  const index = canvasPromptIndex(graph, [{ id: 'shot', prompt: '镜头提示词' }] as Shot[])
  assert.equal(indexedCanvasPrompt(nodes[3], index, () => '剧本内容'), '第二条\n\n剧本内容\n\n第一条\n\n镜头提示词')
  assert.equal(indexedCanvasPrompt({ ...nodes[3], prompt: '节点提示词' }, index, () => '剧本内容').endsWith('节点提示词'), true)
  assert.equal(indexedCanvasPrompt({ ...nodes[3], text: '定稿', settings: { prompt_override: true } }, index, () => '剧本内容'), '定稿')
})

test('unchanged node/edge props are reused while content, selection, geometry and handlers still update', () => {
  const callback = () => {}
  const before: Node = { id: 'node', position: { x: 0, y: 0 }, selected: false,
    data: { text: '提示词', onChange: callback }, width: 420, height: 340, measured: { width: 420, height: 340 }, style: { width: 420, height: 340 } }
  const equal = { ...before, position: { ...before.position }, measured: { ...before.measured }, style: { ...before.style }, data: { ...before.data } }
  assert.equal(reuseFlowNode(before, equal), before)
  const moved = reuseFlowNode(before, { ...equal, position: { x: 12, y: 24 } })
  assert.notEqual(moved, before); assert.equal(moved.data, before.data)
  for (const changed of [{ ...equal, selected: true }, { ...equal, data: { ...equal.data, text: '新提示词' } },
    { ...equal, data: { ...equal.data, onChange: () => {} } }]) assert.notEqual(reuseFlowNode(before, changed), before)
  const edge: Edge = { id: 'edge', source: 'a', target: 'b', data: { related: false }, style: { stroke: '#aaa' } }
  assert.equal(reuseFlowEdge(edge, { ...edge, data: { ...edge.data }, style: { ...edge.style } }), edge)
  assert.notEqual(reuseFlowEdge(edge, { ...edge, hidden: true }), edge)
})

test('reference resolution cache ignores geometry/text and invalidates relevant reference inputs', () => {
  const original = node('node', { type: 'generation', settings: { modality: 'video', mode: 'reference', excluded_visual_profile_ids: ['optional'] } })
  const key = canvasReferenceKey([original])
  assert.equal(canvasReferenceKey([{ ...original, x: 120, y: 240, width: 540, text: '新提示词' }]), key)
  for (const changed of [{ ...original, asset_id: 'new' }, { ...original, shot_id: 'shot' },
    { ...original, settings: { ...original.settings, mode: 'first_frame' as const } },
    { ...original, settings: { ...original.settings, excluded_visual_profile_ids: [] } }]) assert.notEqual(canvasReferenceKey([changed]), key)
})

test('no-op local edits avoid complete serialization while nested document changes remain detectable', () => {
  const first = node('a'), second = node('b', { settings: { text_document: { type: 'doc', content: [{ type: 'paragraph' }] } } })
  const graph: CanvasGraph = { nodes: [first, second], edges: [], revision: 'original' }
  assert.equal(sameCanvasContent(graph, { ...graph, revision: 'new', nodes: [{ ...first }, second] }), true)
  const changed = { ...second, settings: { text_document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '新增内容' }] }] } } }
  assert.equal(sameCanvasContent(graph, { ...graph, nodes: [first, changed] }), false)
  assert.equal(sameCanvasContent(graph, { ...graph, nodes: [second, first] }), false)
})
