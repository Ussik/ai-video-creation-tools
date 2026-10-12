export type CanvasRectangle = { x: number; y: number; width: number; height: number }
type PlacedNode = CanvasRectangle & { id: string }
type NodeSize = Pick<CanvasRectangle, 'width' | 'height'>

export const canvasNodeGap = 48
const coordinateLimit = 1_000_000
const clamp = (value: number) => Math.max(-coordinateLimit, Math.min(coordinateLimit, value))

/** Find the nearest unoccupied top-left position, retaining a gap around cards. */
export function freeCanvasPosition(node: CanvasRectangle, occupied: CanvasRectangle[]): { x: number; y: number } {
  const origin = { x: clamp(node.x), y: clamp(node.y) }
  if (!occupied.length) return origin
  // A nearest free position is either at the requested y or on a boundary of
  // an expanded obstacle. At each y, merge its forbidden x intervals instead
  // of scanning an arbitrary grid that could miss narrow free spaces.
  const rows = [...new Set([origin.y, ...occupied.flatMap(other => [
    clamp(other.y - node.height - canvasNodeGap), clamp(other.y + other.height + canvasNodeGap),
  ])])].sort((a, b) => Math.abs(a - origin.y) - Math.abs(b - origin.y) || b - a)
  let best: { x: number; y: number } | null = null
  let distance = Infinity
  for (const y of rows) {
    const dy = y - origin.y
    if (dy * dy > distance) break
    const intervals = occupied.filter(other => y < other.y + other.height + canvasNodeGap
      && y > other.y - node.height - canvasNodeGap)
      .map(other => ({ left: other.x - node.width - canvasNodeGap, right: other.x + other.width + canvasNodeGap }))
      .sort((a, b) => a.left - b.left)
    const merged: typeof intervals = []
    for (const interval of intervals) {
      const last = merged[merged.length - 1]
      if (last && interval.left < last.right) last.right = Math.max(last.right, interval.right)
      else merged.push({ ...interval })
    }
    const blocked = merged.find(interval => origin.x > interval.left && origin.x < interval.right)
    let x = origin.x
    if (blocked) {
      const leftAvailable = blocked.left >= -coordinateLimit
      const rightAvailable = blocked.right <= coordinateLimit
      if (!leftAvailable && !rightAvailable) continue
      x = rightAvailable && (!leftAvailable || blocked.right - origin.x <= origin.x - blocked.left)
        ? blocked.right : blocked.left
    }
    const nextDistance = (x - origin.x) ** 2 + dy * dy
    if (nextDistance < distance) {
      best = { x, y }
      distance = nextDistance
      if (distance === 0) break
    }
  }
  // The persisted canvas is capped at 500 cards of at most 5000px. Its
  // coordinate range always leaves a free boundary among the rows above.
  if (!best) throw new Error('画布暂时没有可用位置，请调整节点后再添加')
  return best
}

/** Place only new IDs; edits, manual moves, existing overlaps and history stay intact. */
export function placeNewCanvasNodes<T extends PlacedNode>(previous: T[], next: T[], size: (node: T) => NodeSize = node => node): T[] {
  const ids = new Set(previous.map(node => node.id))
  if (next.every(node => ids.has(node.id))) return next
  const occupied = next.filter(node => ids.has(node.id)).map(node => {
    const { width, height } = size(node)
    return { x: node.x, y: node.y, width, height }
  })
  let moved = false
  const nodes = next.map(node => {
    if (ids.has(node.id)) return node
    const { width, height } = size(node)
    const dimensions = { width, height }
    const position = freeCanvasPosition({ ...node, ...dimensions }, occupied)
    const placed = position.x === node.x && position.y === node.y ? node : { ...node, ...position }
    occupied.push({ ...placed, ...dimensions })
    moved ||= placed !== node
    return placed
  })
  return moved ? nodes : next
}
