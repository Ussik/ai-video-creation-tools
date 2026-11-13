export type OrganizeNode = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  shot_id?: string | null
  settings: { group_id?: string | null }
}

export type OrganizeEdge = { source: string; target: string }
export type OrganizeSize = { width: number; height: number }
export type OrganizePosition = { x: number; y: number }

const horizontalGap = 80
const rowGap = 70
const groupGap = 90
const origin = 80

function logicalGroup(node: OrganizeNode) {
  return node.settings.group_id || node.shot_id || `ungrouped:${node.type}`
}

function stableBarycenter(ids: string[], related: Map<string, Set<string>>, order: Map<string, number>, current: Map<string, number>) {
  return ids.slice().sort((a, b) => {
    const average = (id: string) => {
      const values = [...(related.get(id) || [])].map(value => current.get(value)).filter((value): value is number => value !== undefined)
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY
    }
    return average(a) - average(b) || order.get(a)! - order.get(b)!
  })
}

/** Lay each connected flow out as a left-to-right layered relationship block. */
export function organizeCanvasNodes<T extends OrganizeNode>(nodes: T[], edges: OrganizeEdge[],
  getSize: (node: T) => OrganizeSize, getShotOrder: (shotId: string) => number | undefined) {
  const positions = new Map<string, OrganizePosition>()
  const scriptNodes = nodes.filter(node => node.type === 'project_script_ref')
  const regularNodes = nodes.filter(node => node.type !== 'project_script_ref')
  const scriptWidth = Math.max(0, ...scriptNodes.map(node => getSize(node).width))
  let scriptY = origin
  for (const node of scriptNodes) {
    positions.set(node.id, { x: origin, y: scriptY })
    scriptY += getSize(node).height + rowGap
  }
  const startX = origin + (scriptNodes.length ? scriptWidth + horizontalGap : 0)

  const nodeById = new Map(regularNodes.map(node => [node.id, node]))
  const indexById = new Map(regularNodes.map((node, index) => [node.id, index]))
  const adjacency = new Map(regularNodes.map(node => [node.id, new Set<string>()]))
  const incoming = new Map(regularNodes.map(node => [node.id, new Set<string>()]))
  const outgoing = new Map(regularNodes.map(node => [node.id, new Set<string>()]))
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue
    adjacency.get(edge.source)!.add(edge.target)
    adjacency.get(edge.target)!.add(edge.source)
    outgoing.get(edge.source)!.add(edge.target)
    incoming.get(edge.target)!.add(edge.source)
  }

  // Discover edge-connected flows first so explicit relationships stay together,
  // even when a source asset's own shot metadata differs from the generation node.
  const components: T[][] = []
  const visited = new Set<string>()
  for (const node of regularNodes) {
    if (visited.has(node.id)) continue
    const stack = [node.id]
    const component: T[] = []
    visited.add(node.id)
    while (stack.length) {
      const id = stack.pop()!
      component.push(nodeById.get(id)!)
      for (const neighbor of adjacency.get(id) || []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        stack.push(neighbor)
      }
    }
    component.sort((a, b) => indexById.get(a.id)! - indexById.get(b.id)!)
    components.push(component)
  }

  const componentGroup = (component: T[]) => {
    // A generation anchors the grouping when connected assets carry older or
    // project-wide shot metadata of their own.
    const hasRelationships = component.some(node => (adjacency.get(node.id)?.size || 0) > 0)
    const anchor = component.find(node => node.type === 'generation' && node.settings.group_id)
      || component.find(node => node.type === 'generation' && node.shot_id)
      || component.find(node => node.settings.group_id)
      || component.find(node => node.shot_id)
      || component[0]
    const shotIds = component.flatMap(node => node.shot_id ? [node.shot_id] : [])
    const shotOrders = shotIds.map(getShotOrder).filter((value): value is number => value !== undefined)
    return {
      key: hasRelationships ? logicalGroup(anchor) : logicalGroup(component[0]),
      // A shared reference can connect nodes from different shots. Sort that
      // block by the earliest visible shot so it does not drift behind later
      // groups just because the generation node is the chosen anchor.
      shotOrder: shotOrders.length ? Math.min(...shotOrders) : Number.MAX_SAFE_INTEGER,
      first: Math.min(...component.map(node => indexById.get(node.id)!)),
    }
  }
  const groups = new Map<string, T[][]>()
  for (const component of components) {
    const key = componentGroup(component).key
    const group = groups.get(key) || []
    group.push(component)
    groups.set(key, group)
  }
  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const a = componentGroup(left[1][0]), b = componentGroup(right[1][0])
    return a.shotOrder - b.shotOrder || a.first - b.first
  })

  let y = origin
  for (const [, groupComponents] of orderedGroups) {
    groupComponents.sort((a, b) => componentGroup(a).first - componentGroup(b).first)
    for (const component of groupComponents) {
      const members = new Set(component.map(node => node.id))
      const remainingIncoming = new Map(component.map(node => [node.id,
        [...(incoming.get(node.id) || [])].filter(id => members.has(id)).length]))
      const ready = component.filter(node => remainingIncoming.get(node.id) === 0)
        .sort((a, b) => indexById.get(a.id)! - indexById.get(b.id)!)
      const ordered: T[] = []
      const pushReady = (node: T) => {
        const at = ready.findIndex(item => indexById.get(item.id)! > indexById.get(node.id)!)
        if (at < 0) ready.push(node)
        else ready.splice(at, 0, node)
      }
      while (ready.length) {
        const node = ready.shift()!
        ordered.push(node)
        for (const id of outgoing.get(node.id) || []) {
          if (!members.has(id)) continue
          const count = remainingIncoming.get(id)! - 1
          remainingIncoming.set(id, count)
          if (count === 0) pushReady(nodeById.get(id)!)
        }
      }
      // Canvas graphs should be acyclic, but malformed legacy cycles still get
      // deterministic coordinates and never make the organizer fail.
      if (ordered.length !== component.length) {
        const placed = new Set(ordered.map(node => node.id))
        ordered.push(...component.filter(node => !placed.has(node.id)))
      }

      const topoIndex = new Map(ordered.map((node, index) => [node.id, index]))
      const layerById = new Map<string, number>()
      for (const node of ordered) {
        const predecessors = [...(incoming.get(node.id) || [])].filter(id => members.has(id))
        const validPredecessors = predecessors.filter(id => (topoIndex.get(id) ?? -1) < (topoIndex.get(node.id) ?? 0))
        const layer = validPredecessors.length
          ? Math.max(...validPredecessors.map(id => layerById.get(id) || 0)) + 1
          : 0
        layerById.set(node.id, layer)
      }
      const maxLayer = Math.max(0, ...layerById.values())
      const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
      for (const node of component) layers[layerById.get(node.id) || 0].push(node.id)
      for (const layer of layers) layer.sort((a, b) => indexById.get(a)! - indexById.get(b)!)

      // Stable barycenter sweeps keep branches in the same order as their
      // predecessors/successors, which makes the visual expansion read like a
      // bracket instead of crossing through adjacent cards.
      for (let sweep = 0; sweep < 3; sweep += 1) {
        const orderById = new Map<string, number>()
        for (const layer of layers) layer.forEach((id, index) => orderById.set(id, index))
        for (let layerIndex = 1; layerIndex < layers.length; layerIndex += 1) {
          const predecessorMap = new Map(layers[layerIndex].map(id => [id,
            new Set([...(incoming.get(id) || [])].filter(value => members.has(value)))]))
          layers[layerIndex] = stableBarycenter(layers[layerIndex], predecessorMap, indexById, orderById)
        }
        for (const layer of layers) layer.forEach((id, index) => orderById.set(id, index))
        for (let layerIndex = layers.length - 2; layerIndex >= 0; layerIndex -= 1) {
          const successorMap = new Map(layers[layerIndex].map(id => [id,
            new Set([...(outgoing.get(id) || [])].filter(value => members.has(value)))]))
          layers[layerIndex] = stableBarycenter(layers[layerIndex], successorMap, indexById, orderById)
        }
      }

      const layerWidths = layers.map(layer => Math.max(0, ...layer.map(id => getSize(nodeById.get(id)!).width)))
      const layerX: number[] = []
      let x = startX
      for (const width of layerWidths) {
        layerX.push(x)
        x += width + horizontalGap
      }
      const layerHeights = layers.map(layer => layer.reduce((sum, id, index) => sum + getSize(nodeById.get(id)!).height + (index ? rowGap : 0), 0))
      const componentHeight = Math.max(220, ...layerHeights)
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
        const layer = layers[layerIndex]
        const stackHeight = layerHeights[layerIndex]
        let layerY = y + (componentHeight - stackHeight) / 2
        for (const id of layer) {
          const node = nodeById.get(id)!
          positions.set(id, { x: layerX[layerIndex], y: layerY })
          layerY += getSize(node).height + rowGap
        }
      }
      y += componentHeight + rowGap
    }
    if (groupComponents.length) y += groupGap - rowGap
  }
  return positions
}
