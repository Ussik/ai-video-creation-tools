import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NodeToolbar, Position, useReactFlow } from '@xyflow/react'

type ScreenRect = { left: number; top: number; right: number; bottom: number }
type CanvasViewport = { x: number; y: number; zoom: number }
type ComposerNodeBounds = { x: number; y: number; width: number; height: number }
export interface CanvasComposerToolbarProps {
  nodeId: string
  children: ReactNode
  expanded?: boolean
  revealKey?: number
}

/** Translate a screen-sized composer into its available canvas area. */
export function composerViewportShift(composer: ScreenRect, canvas: ScreenRect, sidebar?: ScreenRect): { x: number; y: number } {
  if (![...Object.values(composer), ...Object.values(canvas)].every(Number.isFinite)) return { x: 0, y: 0 }
  const sidebarVisible = sidebar && sidebar.right > canvas.left && sidebar.left < canvas.right
    && sidebar.bottom > canvas.top && sidebar.top < canvas.bottom && sidebar.right > sidebar.left
  const left = Math.min(canvas.right - 20, Math.max(canvas.left + 20, sidebarVisible ? sidebar.right + 16 : canvas.left + 20))
  const right = Math.max(left, canvas.right - 20)
  const top = Math.min(canvas.bottom, canvas.top + 72)
  const bottom = Math.max(top, canvas.bottom - 90)
  const shift = (start: number, end: number, safeStart: number, safeEnd: number) => {
    if (end - start > safeEnd - safeStart) return safeStart - start
    if (start < safeStart) return safeStart - start
    if (end > safeEnd) return safeEnd - end
    return 0
  }
  return { x: shift(composer.left, composer.right, left, right), y: shift(composer.top, composer.bottom, top, bottom) }
}

/** Fit both the node and its fixed-size composer, without ever zooming in. */
export function composerViewportFit(viewport: CanvasViewport, node: ComposerNodeBounds,
  composer: { width: number; height: number }, canvas: ScreenRect, sidebar?: ScreenRect): CanvasViewport {
  if (![...Object.values(viewport), ...Object.values(node), ...Object.values(composer), ...Object.values(canvas)].every(Number.isFinite)
    || node.width <= 0 || node.height <= 0 || composer.width <= 0 || composer.height <= 0 || viewport.zoom <= 0) return viewport
  const titleHeight = 36
  const toolbarGap = 24
  const availableHeight = Math.max(0, canvas.bottom - canvas.top - 72 - 90)
  const nodeSpace = Math.max(0, availableHeight - titleHeight - toolbarGap - composer.height)
  const zoom = Math.min(viewport.zoom, Math.max(0.1, nodeSpace / node.height))
  const centerX = node.x + node.width / 2
  const centerY = node.y + node.height / 2
  const next = {
    zoom,
    x: viewport.x + centerX * (viewport.zoom - zoom),
    y: viewport.y + centerY * (viewport.zoom - zoom),
  }
  const screenCenterX = canvas.left + centerX * zoom + next.x
  const screenNodeTop = canvas.top + node.y * zoom + next.y
  // The horizontal bounds belong to the unscaled composer. The vertical
  // bounds include the node and its title, preventing a fix for the composer
  // from hiding the image/video above the viewport.
  const shift = composerViewportShift({
    left: screenCenterX - composer.width / 2,
    right: screenCenterX + composer.width / 2,
    top: screenNodeTop - titleHeight,
    bottom: screenNodeTop + node.height * zoom + toolbarGap + composer.height,
  }, canvas, sidebar)
  return { ...next, x: next.x + shift.x, y: next.y + shift.y }
}

export default function CanvasComposerToolbar({ nodeId, children, expanded = false, revealKey = 0 }: CanvasComposerToolbarProps) {
  const { getNode, getViewport, setViewport } = useReactFlow()
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!anchor) return
    const flow = anchor.closest<HTMLElement>('.pc-flow')
    if (!flow) return
    let active = true
    let observedWidth = -1
    let observedHeight = -1

    const alignComposer = () => {
      frameRef.current = null
      if (!active || !anchor.isConnected) return
      const rect = anchor.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      observedWidth = rect.width
      observedHeight = rect.height
      const bounds = flow.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const sidebar = flow.closest('.project-canvas')?.querySelector<HTMLElement>('.pc-canvas-sidebar')
      const sidebarRect = sidebar?.getBoundingClientRect()
      const viewport = getViewport()
      const visibleSidebar = sidebarRect?.width && sidebarRect.height ? sidebarRect : undefined
      const node = getNode(nodeId)
      let next: CanvasViewport
      if (node && (node.height || node.measured?.height) && (node.width || node.measured?.width)) {
        next = composerViewportFit(viewport, { ...node.position,
          width: node.width || node.measured!.width!, height: node.height || node.measured!.height!,
        }, rect, bounds, visibleSidebar)
      } else {
        const shift = composerViewportShift(rect, bounds, visibleSidebar)
        next = { ...viewport, x: viewport.x + shift.x, y: viewport.y + shift.y }
      }
      if (Math.abs(next.x - viewport.x) < 1 && Math.abs(next.y - viewport.y) < 1 && Math.abs(next.zoom - viewport.zoom) < 0.001) return
      // NodeToolbar cancels viewport zoom for the composer itself. Zooming out
      // only reduces the node while preserving the editor's readable size.
      void setViewport(next, { duration: 0 })
    }
    const scheduleAlignment = () => {
      if (!active) return
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(alignComposer)
    }
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(item => item.target === anchor)
      if (!entry) return
      const { width, height } = anchor.getBoundingClientRect()
      if (Math.abs(width - observedWidth) < 0.5 && Math.abs(height - observedHeight) < 0.5) return
      observedWidth = width
      observedHeight = height
      scheduleAlignment()
    })
    observer.observe(anchor)
    scheduleAlignment()
    return () => {
      active = false
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    // Pan/zoom and textarea scroll are intentionally not dependencies: after
    // the initial reveal the user is free to move around the canvas.
  }, [anchor, nodeId, expanded, revealKey, getNode, getViewport, setViewport])

  return <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={24} align="center"
    className="pc-node-toolbar" data-canvas-overlay>
    <div key={nodeId} ref={setAnchor} className="pc-composer-anchor nodrag nowheel" data-canvas-overlay style={{ pointerEvents: 'auto' }}>
      {children}
    </div>
  </NodeToolbar>
}
