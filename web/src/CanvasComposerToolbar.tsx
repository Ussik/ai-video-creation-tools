import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@mantine/core'
import { NodeToolbar, Position, useStore } from '@xyflow/react'

export interface CanvasComposerToolbarProps {
  nodeId: string
  children: ReactNode
  expanded?: boolean
  /** Space below the card in unscaled canvas pixels, e.g. a profile status. */
  bottomInset?: number
  onCollapse: () => void
}

export default function CanvasComposerToolbar({ nodeId, children, expanded = false, bottomInset = 0, onCollapse }: CanvasComposerToolbarProps) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const returnFocusRef = useRef(false)
  const zoom = useStore(state => state.transform[2])
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
    // NodeToolbar alone owns the position. Size limits depend on the canvas
    // dimensions, never the node's proximity to an edge or the current view.
    const sizeComposer = () => {
      const bounds = flow.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      anchor.style.setProperty('--pc-composer-max-width', `${Math.max(0, bounds.width - 48)}px`)
      anchor.style.setProperty('--pc-composer-max-height', `${Math.max(240, Math.min(420, bounds.height - 162))}px`)
    }
    const observer = new ResizeObserver(sizeComposer)
    observer.observe(flow)
    sizeComposer()
    return () => {
      observer.disconnect()
      anchor.style.removeProperty('--pc-composer-max-width')
      anchor.style.removeProperty('--pc-composer-max-height')
    }
  }, [anchor, expanded])

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

  return <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={24 + bottomInset * zoom} align="center"
    className="pc-node-toolbar" data-canvas-overlay>
    <div key={nodeId} ref={captureAnchor} className="pc-composer-anchor nodrag nowheel" data-canvas-overlay data-placement="bottom" style={{ pointerEvents: 'auto' }}>
      {children}
    </div>
  </NodeToolbar>
}
