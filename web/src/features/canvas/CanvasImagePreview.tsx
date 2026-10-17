import { ActionIcon, Button, Group, Loader } from '@mantine/core'
import { CircleAlert, Maximize, Minus, Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { clampImageView, imageFitScale, imagePreviewMaxScale, zoomImageView, type ImageSize, type ImageView } from './canvas-image-viewport'

const fitView: ImageView = { scale: 0, x: 0, y: 0 }

export default function CanvasImagePreview({ src, alt }: { src: string; alt: string }) {
  const stage = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState<ImageSize>({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 })
  const [view, setView] = useState<ImageView>(fitView)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const fit = imageFitScale(image, viewport)
  const current = (value: ImageView) => value.scale ? clampImageView(value, image, viewport) : { scale: fit, x: 0, y: 0 }
  const display = current(view)
  const ready = image.width > 0 && viewport.width > 0 && !failed
  const minScale = Math.min(0.1, fit)
  const canPan = ready && (image.width * display.scale > viewport.width || image.height * display.scale > viewport.height)

  useLayoutEffect(() => {
    const element = stage.current!
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = stage.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (!image.width || !viewport.width || !event.deltaY) return
      const rect = element.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1)
      const factor = Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002)
      setView(value => {
        const base = value.scale ? clampImageView(value, image, viewport) : { scale: imageFitScale(image, viewport), x: 0, y: 0 }
        return zoomImageView(base, base.scale * factor, { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }, image, viewport)
      })
    }
    // A non-passive listener prevents the modal or underlying canvas from zooming.
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [image, viewport])

  function zoom(scale: number) {
    if (ready) setView(value => zoomImageView(current(value), scale, { x: 0, y: 0 }, image, viewport))
  }
  function point(event: PointerEvent<HTMLDivElement>) { return { x: event.clientX, y: event.clientY } }
  function endPointer(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(pointers.current.size > 0)
  }
  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const before = [...pointers.current.values()]
    const previous = pointers.current.get(event.pointerId)
    if (!previous || !ready) return
    pointers.current.set(event.pointerId, point(event))
    const after = [...pointers.current.values()]
    setView(value => {
      let next = current(value)
      if (before.length === 2 && after.length === 2) {
        const distance = (points: typeof before) => Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y)
        const oldDistance = distance(before)
        const rect = stage.current!.getBoundingClientRect()
        const oldCenter = { x: (before[0]!.x + before[1]!.x) / 2, y: (before[0]!.y + before[1]!.y) / 2 }
        const center = { x: (after[0]!.x + after[1]!.x) / 2, y: (after[0]!.y + after[1]!.y) / 2 }
        if (oldDistance) next = zoomImageView(next, next.scale * distance(after) / oldDistance,
          { x: oldCenter.x - rect.left - rect.width / 2, y: oldCenter.y - rect.top - rect.height / 2 }, image, viewport)
        return clampImageView({ ...next, x: next.x + center.x - oldCenter.x, y: next.y + center.y - oldCenter.y }, image, viewport)
      }
      return clampImageView({ ...next, x: next.x + event.clientX - previous.x, y: next.y + event.clientY - previous.y }, image, viewport)
    })
  }

  return <div className="pc-image-preview">
    <div ref={stage} className={`pc-image-preview-viewport${canPan ? ' is-pannable' : ''}${dragging ? ' is-dragging' : ''}`}
      tabIndex={0} role="region" aria-label="图片详情查看器"
      onDoubleClick={event => {
        if (!ready) return
        if (Math.abs(display.scale - fit) > 0.001) setView(fitView)
        else {
          const rect = event.currentTarget.getBoundingClientRect()
          setView(value => zoomImageView(current(value), Math.min(imagePreviewMaxScale, Math.max(1, fit * 2)),
            { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }, image, viewport))
        }
      }}
      onKeyDown={event => {
        if (!ready || event.ctrlKey || event.metaKey || event.altKey) return
        const moves: Record<string, [number, number]> = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }
        if (event.key === '+' || event.key === '=') zoom(display.scale * 1.25)
        else if (event.key === '-') zoom(display.scale / 1.25)
        else if (event.key === '0') setView(fitView)
        else if (event.key === '1') zoom(1)
        else if (moves[event.key]) {
          const [x, y] = moves[event.key]!
          setView(value => { const base = current(value); return clampImageView({ ...base, x: base.x + x, y: base.y + y }, image, viewport) })
        } else return
        event.preventDefault()
      }}
      onPointerDown={event => {
        if (!ready || event.button !== 0 || pointers.current.size >= 2) return
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        pointers.current.set(event.pointerId, point(event))
        setDragging(true)
        event.preventDefault()
      }}
      onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
      <img src={src} alt={alt} draggable={false} decoding="async"
        onLoad={event => setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
        style={{ width: image.width, height: image.height, visibility: ready ? 'visible' : 'hidden',
          transform: `translate(-50%, -50%) translate(${display.x}px, ${display.y}px) scale(${display.scale})` }} />
      {!ready && <div className="pc-image-preview-status" role="status">
        {failed ? <><CircleAlert size={24} /><span>图片加载失败，请关闭后重试</span></> : <Loader size="sm" color="gray" />}
      </div>}
    </div>
    <div className="pc-image-preview-toolbar">
      <div className="pc-image-preview-info">
        {ready && <span>{image.width} × {image.height}</span>}
        <span className="pc-image-preview-hint">滚轮缩放 · 拖动查看 · 双击切换</span>
      </div>
      <Group gap={4} wrap="nowrap" aria-label="图片缩放控制">
        <ActionIcon variant="subtle" color="gray" size={30} aria-label="缩小图片" title="缩小（-）" disabled={!ready || display.scale <= minScale} onClick={() => zoom(display.scale / 1.25)}><Minus size={16} /></ActionIcon>
        <span className="pc-image-preview-scale" aria-live="polite">{ready ? `${Math.round(display.scale * 100)}%` : '—'}</span>
        <ActionIcon variant="subtle" color="gray" size={30} aria-label="放大图片" title="放大（+）" disabled={!ready || display.scale >= imagePreviewMaxScale} onClick={() => zoom(display.scale * 1.25)}><Plus size={16} /></ActionIcon>
        <span className="pc-image-preview-divider" />
        <Button variant="subtle" color="gray" size="compact-sm" disabled={!ready} title="按原始像素查看（1）" onClick={() => zoom(1)}>100%</Button>
        <Button variant="subtle" color="gray" size="compact-sm" disabled={!ready} leftSection={<Maximize size={14} />} title="重置为适应窗口（0）" onClick={() => setView(fitView)}>适应窗口</Button>
      </Group>
    </div>
  </div>
}
