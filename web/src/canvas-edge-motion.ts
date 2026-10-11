import type { Viewport } from '@xyflow/react'

type Point = { x: number; y: number }
type Bounds = { left: number; top: number; right: number; bottom: number }
export const canvasMotionBudget = 24

function clipLine(start: Point, end: Point, bounds: Bounds): Point[] {
  const dx = end.x - start.x, dy = end.y - start.y
  let from = 0, to = 1
  for (const [p, q] of [[-dx, start.x - bounds.left], [dx, bounds.right - start.x], [-dy, start.y - bounds.top], [dy, bounds.bottom - start.y]]) {
    if (p === 0) { if (q < 0) return []; continue }
    const t = q / p
    if (p < 0) from = Math.max(from, t)
    else to = Math.min(to, t)
    if (from > to) return []
  }
  return [from === 0 ? start : { x: start.x + dx * from, y: start.y + dy * from },
    to === 1 ? end : { x: start.x + dx * to, y: start.y + dy * to }]
}

/** Sample the actual React Flow cubic once, clipping motion to the visible part.
 * Native transform keyframes avoid animating/repainting the SVG stroke itself. */
export function visibleEdgeMotion(path: string, viewport: Viewport, width: number, height: number) {
  if (!(viewport.zoom > 0) || width <= 0 || height <= 0 || !/^M[^A-Za-z]*C[^A-Za-z]*$/i.test(path.replace(/e[+-]?\d+/gi, ''))) return null
  const values = path.match(/-?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi)?.map(Number)
  if (!values || values.length !== 8 || values.some(value => !Number.isFinite(value))) return null
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values
  const bounds = { left: -viewport.x / viewport.zoom, top: -viewport.y / viewport.zoom,
    right: (width - viewport.x) / viewport.zoom, bottom: (height - viewport.y) / viewport.zoom }
  if (Math.max(x0, x1, x2, x3) < bounds.left || Math.min(x0, x1, x2, x3) > bounds.right
    || Math.max(y0, y1, y2, y3) < bounds.top || Math.min(y0, y1, y2, y3) > bounds.bottom) return null
  const point = (t: number): Point => {
    const u = 1 - t
    return { x: u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
      y: u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3 }
  }
  const runs: Point[][] = []
  let start = point(0), run: Point[] = []
  for (let step = 1; step <= 96; step++) {
    const end = point(step / 96), clipped = clipLine(start, end, bounds)
    if (clipped.length) {
      if (!run.length) run.push(clipped[0])
      run.push(clipped[1])
      if (clipped[1].x !== end.x || clipped[1].y !== end.y) { runs.push(run); run = [] }
    } else if (run.length) { runs.push(run); run = [] }
    start = end
  }
  if (run.length) runs.push(run)
  const measured = runs.map(points => {
    const distances = [0]
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
    return { points, distances, length: distances.at(-1)! }
  }).sort((a, b) => b.length - a.length)
  const visible = measured[0]
  if (!visible || visible.length * viewport.zoom < 12) return null
  // Duplicate clipped endpoints have no distance; omit them so offsets increase.
  const keyframes = visible.points.flatMap((position, index) => {
    if (index && visible.distances[index] === visible.distances[index - 1]) return []
    const offset = visible.distances[index] / visible.length
    return [{ transform: `translate(${position.x}px, ${position.y}px)`, offset,
      opacity: Math.min(1, offset * 12, (1 - offset) * 12) }]
  })
  return { keyframes, duration: Math.max(1200, Math.min(3200, visible.length * viewport.zoom / 140 * 1000)) }
}
