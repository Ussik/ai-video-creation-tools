export type ScreenRect = { left: number; top: number; right: number; bottom: number }
export type ComposerSize = { width: number; height: number; minHeight?: number }
type ComposerLayoutOptions = { topInset?: number; bottomInset?: number; minScale?: number }
export type ComposerPlacement = {
  rect: ScreenRect
  area: ScreenRect
  maxWidth: number
  maxHeight: number
  side: 'bottom' | 'right' | 'left' | 'top'
  /** Only cramped viewports need to reframe the view, never the saved node. */
  reframe?: { node: ScreenRect; scale: number }
}
const gap = 24
const minWidth = 320
const minHeight = 240
const width = (rect: ScreenRect) => rect.right - rect.left
const height = (rect: ScreenRect) => rect.bottom - rect.top
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export function composerRectInArea(size: ComposerSize, node: ScreenRect, area: ScreenRect, side: ComposerPlacement['side']): ScreenRect {
  const w = Math.min(size.width, width(area)), h = Math.min(size.height, height(area))
  const left = clamp(side === 'right' ? area.left : side === 'left' ? area.right - w : (node.left + node.right - w) / 2, area.left, area.right - w)
  const top = clamp(side === 'bottom' ? area.top : side === 'top' ? area.bottom - h : (node.top + node.bottom - h) / 2, area.top, area.bottom - h)
  return { left, top, right: left + w, bottom: top + h }
}

export function composerCanvasBounds(canvas: ScreenRect, sidebar?: ScreenRect, options: ComposerLayoutOptions = {}): ScreenRect {
  const sidebarVisible = sidebar && sidebar.right > canvas.left && sidebar.left < canvas.right
    && sidebar.bottom > canvas.top && sidebar.top < canvas.bottom && width(sidebar) > 0
  const left = Math.min(canvas.right - 20, Math.max(canvas.left + 20, sidebarVisible ? sidebar.right + 16 : canvas.left + 20))
  const top = Math.min(canvas.bottom, canvas.top + (options.topInset ?? 72))
  return { left, top, right: Math.max(left, canvas.right - 20), bottom: Math.max(top, canvas.bottom - (options.bottomInset ?? 90)) }
}

/** Keep a normal editor outside its node, even when its text is very long. */
export function placeCanvasComposer(size: ComposerSize, node: ScreenRect, canvas: ScreenRect, sidebar?: ScreenRect, options: ComposerLayoutOptions = {}): ComposerPlacement | null {
  if (![size.width, size.height, ...Object.values(node), ...Object.values(canvas),
    ...(sidebar ? Object.values(sidebar) : []), ...Object.values(options), ...(size.minHeight === undefined ? [] : [size.minHeight])].every(Number.isFinite)
    || size.width <= 0 || size.height <= 0 || width(node) <= 0 || height(node) <= 0 || width(canvas) <= 40 || height(canvas) <= 0) return null
  const safe = composerCanvasBounds(canvas, sidebar, options)
  if (width(safe) < Math.min(minWidth, width(canvas) - 40) || height(safe) < minHeight) return null
  const editorMinHeight = Math.min(Math.max(minHeight, size.minHeight ?? minHeight), height(safe) - gap - 48)
  const candidates: Array<{ side: ComposerPlacement['side']; area: ScreenRect }> = [
    { side: 'bottom', area: { ...safe, top: Math.max(safe.top, node.bottom + gap) } },
    { side: 'right', area: { ...safe, left: Math.max(safe.left, node.right + gap) } },
    { side: 'left', area: { ...safe, right: Math.min(safe.right, node.left - gap) } },
    { side: 'top', area: { ...safe, bottom: Math.min(safe.bottom, node.top - gap) } },
  ]
  const fit = (side: ComposerPlacement['side'], area: ScreenRect, target: ScreenRect): ComposerPlacement => {
    return { rect: composerRectInArea(size, target, area, side), area, maxWidth: width(area), maxHeight: height(area), side }
  }
  // Retain the familiar below-node placement when it really fits. A reduced
  // side panel beats pushing the full-size editor across the selected image.
  const complete = candidates.find(({ area }) => width(area) >= size.width && height(area) >= size.height)
  if (complete) return fit(complete.side, complete.area, node)
  const compact = candidates.filter(({ area }) => width(area) >= Math.min(minWidth, width(safe)) && height(area) >= editorMinHeight)
    .sort((a, b) => Math.min(size.width, width(b.area)) * Math.min(size.height, height(b.area))
      - Math.min(size.width, width(a.area)) * Math.min(size.height, height(a.area)))
  if (compact[0]) return fit(compact[0].side, compact[0].area, node)

  // On a small screen or at high zoom there is no non-overlapping rectangle.
  // Frame the node and editor together rather than altering the node's size.
  const stacked = width(safe) < minWidth + gap + 240
  const editorWidth = stacked ? width(safe) : Math.min(size.width, Math.max(minWidth, width(safe) * 0.46))
  const editorHeight = stacked ? Math.min(size.height, Math.max(editorMinHeight, height(safe) * 0.55)) : height(safe)
  const preview = stacked ? { ...safe, bottom: safe.bottom - editorHeight - gap }
    : { ...safe, right: safe.right - editorWidth - gap }
  const scale = Math.max(clamp(options.minScale ?? 0, 0, 1), Math.min(1, width(preview) / width(node), height(preview) / height(node)))
  // Respect the canvas zoom floor. An exceptionally large node may extend
  // offscreen, but its visible portion still stays clear of the editor.
  const nodeLeft = Math.min(preview.right - width(node) * scale, preview.left + (width(preview) - width(node) * scale) / 2)
  const nodeTop = Math.min(preview.bottom - height(node) * scale, preview.top + (height(preview) - height(node) * scale) / 2)
  const framedNode = { left: nodeLeft, top: nodeTop, right: nodeLeft + width(node) * scale, bottom: nodeTop + height(node) * scale }
  const area = stacked ? { ...safe, top: safe.bottom - editorHeight } : { ...safe, left: safe.right - editorWidth }
  return { ...fit(stacked ? 'bottom' : 'right', area, framedNode), reframe: { node: framedNode, scale } }
}
