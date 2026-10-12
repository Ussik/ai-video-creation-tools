import type { Edge, Node, NodeChange } from '@xyflow/react'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import type { Shot } from '../../shared/api/api'

export const visibleCanvasThreshold = 32
export const compactCanvasZoom = 45

export function shouldVirtualizeCanvas(nodes: CanvasNode[], edgeCount: number): boolean {
  return nodes.length > visibleCanvasThreshold || edgeCount > 48
    || nodes.filter(node => node.type === 'image' || node.type === 'video' || node.type === 'generation').length >= 8
}

export function shallowEqual(left: object, right: object, ignored: string[] = []): boolean {
  if (left === right) return true
  const keys = Object.keys(left).filter(key => !ignored.includes(key))
  return keys.length === Object.keys(right).filter(key => !ignored.includes(key)).length
    && keys.every(key => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key])
}

/** Reuse unchanged controlled-node props so React Flow does not notify every card. */
export function reuseFlowNode<T extends Node>(previous: T | undefined, next: T): T {
  if (!previous) return next
  const candidate = { ...next,
    data: shallowEqual(previous.data, next.data) ? previous.data : next.data,
    position: shallowEqual(previous.position, next.position) ? previous.position : next.position,
    style: previous.style && next.style && shallowEqual(previous.style, next.style) ? previous.style : next.style,
    measured: previous.measured && next.measured && shallowEqual(previous.measured, next.measured) ? previous.measured : next.measured,
  }
  return shallowEqual(previous, candidate) ? previous : candidate
}

export function reuseFlowEdge<T extends Edge>(previous: T | undefined, next: T): T {
  if (!previous) return next
  const candidate = { ...next,
    data: previous.data && next.data && shallowEqual(previous.data, next.data) ? previous.data : next.data,
    style: previous.style && next.style && shallowEqual(previous.style, next.style) ? previous.style : next.style,
  }
  return shallowEqual(previous, candidate) ? previous : candidate
}

/** Local edits preserve references. Compare only replaced items, not the full document. */
export function sameCanvasContent(left: CanvasGraph, right: CanvasGraph): boolean {
  const sameItems = (before: object[], after: object[]) => before === after || before.length === after.length
    && before.every((item, index) => item === after[index] || JSON.stringify(item) === JSON.stringify(after[index]))
  return sameItems(left.nodes, right.nodes) && sameItems(left.edges, right.edges)
}

export function canvasPromptIndex(graph: CanvasGraph, shots: Shot[]) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const incoming = new Map<string, CanvasGraph['edges']>()
  for (const edge of graph.edges) {
    const edges = incoming.get(edge.target)
    if (edges) edges.push(edge)
    else incoming.set(edge.target, [edge])
  }
  return { nodes, incoming, shots: new Map(shots.map(shot => [shot.id, shot])) }
}

export function indexedCanvasPrompt(node: CanvasNode, index: ReturnType<typeof canvasPromptIndex>, scriptPrompt: () => string): string {
  if (node.settings.prompt_override) return node.text
  const connected = (index.incoming.get(node.id) || []).map(edge => index.nodes.get(edge.source))
    .map(source => source?.type === 'project_script_ref' ? scriptPrompt() : source?.type === 'text' ? source.text.trim() : '')
    .filter(Boolean)
  return [...connected, node.prompt.trim() || index.shots.get(node.shot_id || '')?.prompt.trim() || ''].filter(Boolean).join('\n\n')
}

/** Only fields read by automatic reference resolution; positions/text are irrelevant. */
export function canvasReferenceKey(nodes: CanvasNode[]): string {
  return JSON.stringify(nodes.map(node => [node.id, node.type, node.model_id, node.shot_id, node.asset_id,
    node.settings.modality, node.settings.mode, node.settings.visual_profile_id, node.settings.visual_profile_revision,
    node.settings.visual_reference_mode, node.settings.visual_dependencies, node.settings.excluded_visual_profile_ids]))
}

/** Apply a drag/resize batch in linear time while keeping unchanged node identities. */
export function updateCanvasGeometry(nodes: CanvasNode[], changes: NodeChange[], continuingDrag: boolean): CanvasNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const positions = new Map<string, { x: number; y: number }>()
  const dimensions = new Map<string, { width: number; height: number }>()
  const removed = new Set<string>()
  const groupChanges = new Map<string, Array<Extract<NodeChange, { type: 'position' }>>>()
  for (const change of changes) {
    if (change.type === 'remove') removed.add(change.id)
    if (change.type === 'dimensions' && change.dimensions) dimensions.set(change.id, change.dimensions)
    if (change.type !== 'position') continue
    if (change.position) positions.set(change.id, change.position)
    const group = byId.get(change.id)?.settings.group_id
    if (group) {
      const moves = groupChanges.get(group)
      if (moves) moves.push(change)
      else groupChanges.set(group, [change])
    }
  }
  const groupDeltas = new Map<string, { x: number; y: number }>()
  if (!changes.some(change => change.type === 'dimensions')) {
    for (const [group, moves] of groupChanges) {
      const change = moves[0], node = byId.get(change.id)!
      if (moves.length === 1 && change.position && (change.dragging === true || continuingDrag)) {
        groupDeltas.set(group, { x: change.position.x - node.x, y: change.position.y - node.y })
      }
    }
  }
  let changed = removed.size > 0
  const result: CanvasNode[] = []
  for (const node of nodes) {
    if (removed.has(node.id)) continue
    const delta = node.settings.group_id ? groupDeltas.get(node.settings.group_id) : undefined
    const position = positions.get(node.id) || (delta ? { x: node.x + delta.x, y: node.y + delta.y } : node)
    const size = dimensions.get(node.id)
    const width = size?.width || node.width, height = size?.height || node.height
    if (node.x === position.x && node.y === position.y && node.width === width && node.height === height) result.push(node)
    else { result.push({ ...node, x: position.x, y: position.y, width, height }); changed = true }
  }
  return changed ? result : nodes
}
