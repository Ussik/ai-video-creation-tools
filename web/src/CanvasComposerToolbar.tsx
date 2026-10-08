import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@mantine/core'
import { NodeToolbar, Position } from '@xyflow/react'

type ScreenRect = { left: number; top: number; right: number; bottom: number }
export interface CanvasComposerToolbarProps {
  nodeId: string
  children: ReactNode
  expanded?: boolean
  revealKey?: number
  onCollapse: () => void
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

export default function CanvasComposerToolbar({ nodeId, children, expanded = false, revealKey = 0, onCollapse }: CanvasComposerToolbarProps) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const returnFocusRef = useRef(false)
  const captureAnchor = useCallback((element: HTMLDivElement | null) => {
    setAnchor(element)
    // Keep the app's theme ancestry without mounting under the transformed
    // React Flow viewport. Retain the target when the normal editor unmounts.
    if (element) setPortalTarget(element.closest<HTMLElement>('.project-canvas'))
  }, [])

  useEffect(() => {
    if (expanded) returnFocusRef.current = true
    else if (anchor && returnFocusRef.current) {
      anchor.querySelector('textarea')?.focus({ preventScroll: true })
      returnFocusRef.current = false
    }
  }, [expanded, anchor])

  useEffect(() => {
    if (expanded || !anchor) return
    const flow = anchor.closest<HTMLElement>('.pc-flow')
    if (!flow) return
    let active = true
    let observedWidth = -1
    let observedHeight = -1
    let offset = { x: 0, y: 0 }

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
      const visibleSidebar = sidebarRect?.width && sidebarRect.height ? sidebarRect : undefined
      // Measure the original toolbar anchor so resizing/reopening cannot
      // accumulate offsets. NodeToolbar keeps these distances in screen pixels.
      const next = composerViewportShift({
        left: rect.left - offset.x, right: rect.right - offset.x,
        top: rect.top - offset.y, bottom: rect.bottom - offset.y,
      }, bounds, visibleSidebar)
      if (Math.abs(next.x - offset.x) < 0.5 && Math.abs(next.y - offset.y) < 0.5) return
      offset = next
      // Reveal only the editor; opening it must never move or zoom the canvas.
      anchor.style.transform = `translate(${offset.x}px, ${offset.y}px)`
    }
    const scheduleAlignment = () => {
      if (!active) return
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(alignComposer)
    }
    const observer = new ResizeObserver(entries => {
      if (entries.some(item => item.target === flow)) {
        scheduleAlignment()
        return
      }
      const entry = entries.find(item => item.target === anchor)
      if (!entry) return
      const { width, height } = anchor.getBoundingClientRect()
      if (Math.abs(width - observedWidth) < 0.5 && Math.abs(height - observedHeight) < 0.5) return
      observedWidth = width
      observedHeight = height
      scheduleAlignment()
    })
    observer.observe(anchor)
    observer.observe(flow)
    scheduleAlignment()
    return () => {
      active = false
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      anchor.style.removeProperty('transform')
    }
    // Pan/zoom and textarea scroll are intentionally not dependencies: after
    // the initial reveal the user is free to move around the canvas.
  }, [anchor, nodeId, expanded, revealKey])

  if (expanded) return <Modal opened onClose={onCollapse} centered withCloseButton={false}
    attributes={{ content: { 'aria-label': '创作区' } }} size="min(1120px, calc(100vw - 48px))" padding={0} radius={24} xOffset={24} yOffset={24}
    zIndex={210} portalProps={{ target: portalTarget || undefined }}
    closeOnEscape={false} returnFocus={false} transitionProps={{ duration: 0 }}
    overlayProps={{ backgroundOpacity: 0.64, blur: 3 }}
    styles={{ content: { border: 0, boxShadow: 'none' } }}
    classNames={{ root: 'pc-composer-modal-root', content: 'pc-composer-modal-content', body: 'pc-composer-modal-body' }}
    data-canvas-overlay onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onKeyDownCapture={event => {
      // Let an open nested menu consume Escape first. Capture the closed-menu
      // case too, since select/parameter triggers stop keyboard propagation.
      if (event.key !== 'Escape' || event.nativeEvent.isComposing
        || event.currentTarget.querySelector('[aria-expanded="true"]:not(.pc-composer-expand)')) return
      event.stopPropagation()
      onCollapse()
    }}>
    {children}
  </Modal>

  return <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={24} align="center"
    className="pc-node-toolbar" data-canvas-overlay>
    <div key={nodeId} ref={captureAnchor} className="pc-composer-anchor nodrag nowheel" data-canvas-overlay style={{ pointerEvents: 'auto' }}>
      {children}
    </div>
  </NodeToolbar>
}
