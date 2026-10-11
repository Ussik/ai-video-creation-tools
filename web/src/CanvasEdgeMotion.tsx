import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from '@mantine/hooks'
import { ViewportPortal, useStore, useViewport } from '@xyflow/react'
import { canvasMotionBudget, visibleEdgeMotion } from './canvas-edge-motion'

type RegisterPath = (id: string, path: string) => () => void
const EdgeMotionContext = createContext<RegisterPath>(() => () => {})

export function useCanvasEdgeMotionPath(id: string, path: string, enabled: boolean) {
  const register = useContext(EdgeMotionContext)
  useEffect(() => { if (enabled) return register(id, path) }, [register, id, path, enabled])
}

function MotionDot({ id, plan, zoom, index }: { id: string; plan: NonNullable<ReturnType<typeof visibleEdgeMotion>>; zoom: number; index: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const dot = ref.current
    if (!dot?.animate) return
    const animation = dot.animate(plan.keyframes, { duration: plan.duration, iterations: Infinity, easing: 'linear' })
    animation.currentTime = index * 173 % plan.duration
    return () => animation.cancel()
  }, [plan, index])
  return <span ref={ref} className="pc-edge-motion-dot" data-edge-id={id} style={{ width: 6 / zoom, height: 6 / zoom, marginLeft: -3 / zoom, marginTop: -3 / zoom }} />
}

function MotionLayer({ paths }: { paths: Map<string, string> }) {
  const viewport = useViewport()
  const width = useStore(state => state.width), height = useStore(state => state.height)
  const reducedMotion = useReducedMotion()
  const [visible, setVisible] = useState(() => !document.hidden)
  const [cycle, setCycle] = useState(0)
  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const plans = useMemo(() => {
    if (!visible || reducedMotion) return []
    return [...paths].flatMap(([id, path]) => {
      const plan = visibleEdgeMotion(path, viewport, width, height)
      return plan ? [{ id, plan }] : []
    })
  }, [paths, viewport.x, viewport.y, viewport.zoom, width, height, visible, reducedMotion])
  useEffect(() => {
    setCycle(0)
    if (plans.length <= canvasMotionBudget) return
    // Dense connections rotate in small groups, with no per-frame JS work.
    const timer = window.setInterval(() => setCycle(value => value + canvasMotionBudget), 3200)
    return () => window.clearInterval(timer)
  }, [plans])
  if (!plans.length) return null
  const active = Array.from({ length: Math.min(canvasMotionBudget, plans.length) }, (_, index) => plans[(cycle + index) % plans.length])
  return <ViewportPortal><div className="pc-edge-motion-layer" aria-hidden="true">
    {active.map(({ id, plan }, index) => <MotionDot key={id} id={id} plan={plan} zoom={viewport.zoom} index={index} />)}
  </div></ViewportPortal>
}

export default function CanvasEdgeMotionProvider({ children }: { children: ReactNode }) {
  const [paths, setPaths] = useState(new Map<string, string>())
  const registry = useRef(new Map<string, string>())
  const frame = useRef<number | null>(null)
  const mounted = useRef(true)
  const publish = useCallback(() => {
    if (!mounted.current || frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      setPaths(new Map(registry.current))
    })
  }, [])
  useEffect(() => {
    mounted.current = true; publish()
    return () => {
      mounted.current = false
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [publish])
  const register = useCallback<RegisterPath>((id, path) => {
    registry.current.set(id, path); publish()
    return () => {
      if (registry.current.get(id) !== path) return
      registry.current.delete(id); publish()
    }
  }, [publish])
  return <EdgeMotionContext.Provider value={register}>{children}<MotionLayer paths={paths} /></EdgeMotionContext.Provider>
}
