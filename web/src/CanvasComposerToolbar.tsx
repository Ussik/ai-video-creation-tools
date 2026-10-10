import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@mantine/core'
import { NodeToolbar, Position, useReactFlow, useStoreApi } from '@xyflow/react'
import { composerRectInArea, placeCanvasComposer } from './canvas-composer-placement'

export interface CanvasComposerToolbarProps {
  nodeId: string
  children: ReactNode
  expanded?: boolean
  revealKey?: number
  onCollapse: () => void
  onRequestSpace?: () => void
}

export default function CanvasComposerToolbar({ nodeId, children, expanded = false, revealKey = 0, onCollapse, onRequestSpace }: CanvasComposerToolbarProps) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const returnFocusRef = useRef(false)
  const requestSpaceRef = useRef(onRequestSpace)
  requestSpaceRef.current = onRequestSpace
  const store = useStoreApi()
  const { getViewport, setViewport } = useReactFlow()
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

  useLayoutEffect(() => {
    if (expanded || !anchor) return
    const flow = anchor.closest<HTMLElement>('.pc-flow')
    if (!flow) return
    const nodeElement = Array.from(flow.querySelectorAll<HTMLElement>('.react-flow__node')).find(element => element.dataset.id === nodeId)
    const panel = anchor.querySelector<HTMLElement>('.pc-prompt-composer')
    if (!nodeElement || !panel) return
    let active = true
    let reframing = false
    let offset = { x: 0, y: 0 }
    const preferredWidth = panel.getBoundingClientRect().width
    const body = panel.querySelector<HTMLElement>('.pc-prompt-composer-body')
    const canvas = flow.closest<HTMLElement>('.project-canvas')
    const chrome = Array.from(canvas?.querySelectorAll<HTMLElement>('.pc-toolbar, .pc-create-dock, .pc-flow-utility, .pc-node-list-toggle') || [])

    const alignComposer = () => {
      frameRef.current = null
      if (!active || !anchor.isConnected || reframing) return
      const bounds = flow.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const sidebar = canvas?.querySelector<HTMLElement>('.pc-canvas-sidebar')
      const sidebarRect = sidebar?.getBoundingClientRect()
      const visibleSidebar = sidebarRect?.width && sidebarRect.height ? sidebarRect : undefined
      const nodeRect = nodeElement.getBoundingClientRect()
      // Labels and profile status live just outside the rounded card.
      const label = nodeElement.querySelector<HTMLElement>('.pc-node-label')?.getBoundingClientRect()
      const foot = nodeElement.querySelector<HTMLElement>('.pc-node-foot')?.getBoundingClientRect()
      const protectedNode = { left: nodeRect.left, right: nodeRect.right,
        top: Math.min(nodeRect.top, label?.top ?? nodeRect.top),
        bottom: Math.max(nodeRect.bottom, foot?.bottom ?? nodeRect.bottom) }
      const panelStyle = getComputedStyle(panel)
      const minHeight = (panel.querySelector('.pc-prompt-composer-head')?.getBoundingClientRect().height || 0)
        + (panel.querySelector('.pc-prompt-composer-foot')?.getBoundingClientRect().height || 0)
        + parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom) + 2 * parseFloat(panelStyle.rowGap) + 96
      const size = { width: preferredWidth, minHeight, height: Math.max(240, minHeight,
        panel.getBoundingClientRect().height + (body ? body.scrollHeight - body.clientHeight : 0)) }
      const current = getViewport()
      const options = { topInset: 72, bottomInset: 90, minScale: Math.min(1, store.getState().minZoom / current.zoom) }
      for (const element of chrome) {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        if (element.classList.contains('pc-toolbar')) options.topInset = Math.max(options.topInset, rect.bottom - bounds.top + 16)
        else options.bottomInset = Math.max(options.bottomInset, bounds.bottom - rect.top + 16)
      }
      const placement = placeCanvasComposer(size, protectedNode, bounds, visibleSidebar, options)
      if (!placement) {
        anchor.style.visibility = 'hidden'
        if (visibleSidebar && placeCanvasComposer(size, protectedNode, bounds, undefined, options)) requestSpaceRef.current?.()
        return
      }
      if (placement.reframe) {
        const { scale, node } = placement.reframe
        const target = {
          x: current.x * scale + node.left - bounds.left - (protectedNode.left - bounds.left) * scale,
          y: current.y * scale + node.top - bounds.top - (protectedNode.top - bounds.top) * scale,
          zoom: current.zoom * scale,
        }
        // Fractional DOM measurements can request a virtually identical view.
        // Do not hide the editor or write the viewport again in that case.
        if (Math.abs(target.x - current.x) > 0.5 || Math.abs(target.y - current.y) > 0.5
          || Math.abs(target.zoom - current.zoom) > 0.0001) {
          anchor.style.visibility = 'hidden'
          reframing = true
          void setViewport(target, { duration: 0 }).finally(() => { reframing = false; if (active) scheduleAlignment() })
          return
        }
      }
      anchor.style.setProperty('--pc-composer-max-width', `${placement.maxWidth}px`)
      anchor.style.setProperty('--pc-composer-max-height', `${placement.maxHeight}px`)
      const rect = anchor.getBoundingClientRect()
      const target = composerRectInArea({ width: rect.width, height: rect.height }, protectedNode, placement.area, placement.side)
      offset = { x: target.left - (rect.left - offset.x), y: target.top - (rect.top - offset.y) }
      anchor.style.transform = `translate(${offset.x}px, ${offset.y}px)`
      anchor.style.visibility = 'visible'
      anchor.dataset.placement = placement.side
    }
    const scheduleAlignment = () => {
      if (!active) return
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(alignComposer)
    }
    const observer = new ResizeObserver(scheduleAlignment)
    observer.observe(anchor)
    observer.observe(flow)
    observer.observe(nodeElement)
    chrome.forEach(element => observer.observe(element))
    if (body) observer.observe(body)
    const geometry = () => {
      const state = store.getState()
      const node = state.nodeLookup.get(nodeId)
      return [...state.transform, node?.internals.positionAbsolute.x, node?.internals.positionAbsolute.y,
        node?.measured.width, node?.measured.height]
    }
    let previousGeometry = geometry()
    const unsubscribe = store.subscribe(() => {
      // React Flow mutates nodeLookup in place, so old/new Map references do
      // not reveal movement. Compare saved geometry instead of node data.
      const currentGeometry = geometry()
      if (currentGeometry.every((value, index) => value === previousGeometry[index])) return
      previousGeometry = currentGeometry
      scheduleAlignment()
    })
    const mutation = new MutationObserver(scheduleAlignment)
    if (flow.parentElement) mutation.observe(flow.parentElement, { childList: true })
    scheduleAlignment()
    return () => {
      active = false
      observer.disconnect()
      mutation.disconnect()
      unsubscribe()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      anchor.style.removeProperty('transform')
      anchor.style.removeProperty('--pc-composer-max-width')
      anchor.style.removeProperty('--pc-composer-max-height')
      anchor.style.removeProperty('visibility')
    }
  }, [anchor, nodeId, expanded, revealKey, store, getViewport, setViewport])

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
