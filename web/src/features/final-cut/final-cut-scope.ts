import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Job, type ProjectDetail } from '../../shared/api/api'
import { preferredCanvas, rememberedCanvas, type ProjectCanvasInfo } from '../canvas/project-canvases'

export function finalCutPath(path: string, canvasId?: string | null) {
  return canvasId ? `${path}${path.includes('?') ? '&' : '?'}canvas_id=${encodeURIComponent(canvasId)}` : path
}

/** Ordinary canvases share the original scheme; each redesign has its own. */
export function finalCutCanvases(canvases: ProjectCanvasInfo[]) {
  const scopes = new Map<string, ProjectCanvasInfo>()
  for (const canvas of canvases) {
    const key = canvas.design_id || ''
    if (!scopes.has(key) || canvas.is_default) scopes.set(key, canvas)
  }
  return [...scopes.values()]
}

export function finalCutCanvas(canvases: ProjectCanvasInfo[], canvasId: string | null) {
  const preferred = preferredCanvas(canvases, canvasId)
  return finalCutCanvases(canvases).find(canvas => (canvas.design_id || null) === (preferred?.design_id || null))
}

export function exportBelongsToFinalCut(job: Job, canvasId: string | null, canvases: ProjectCanvasInfo[]) {
  try {
    const request = JSON.parse(job.request)
    const exportedCanvasId = typeof request.final_cut_canvas_id === 'string' ? request.final_cut_canvas_id : null
    if (!exportedCanvasId) return !canvases.find(canvas => canvas.id === canvasId)?.design_id
    const selected = canvases.find(canvas => canvas.id === canvasId)
    const exported = canvases.find(canvas => canvas.id === exportedCanvasId)
    return !!selected && !!exported && (selected.design_id || null) === (exported.design_id || null)
  } catch { return false }
}

type Selection = { projectId: string; canvasId: string }
type Snapshot = Selection & { detail: ProjectDetail }

export function useFinalCutScope(projectId: string | null, enabled: boolean) {
  const [catalog, setCatalog] = useState<{ projectId: string; canvases: ProjectCanvasInfo[] } | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const context = useRef({ projectId, enabled, selection })
  context.current = { projectId, enabled, selection }
  const request = useRef(0)
  const entry = useRef(0)
  const activeCanvasId = enabled && selection?.projectId === projectId ? selection.canvasId : null
  const canvases = catalog?.projectId === projectId ? catalog.canvases : []
  const detail = enabled && snapshot?.projectId === projectId && snapshot.canvasId === activeCanvasId ? snapshot.detail : null

  const refresh = useCallback(async (requestedProjectId?: string) => {
    const current = context.current
    if (!current.enabled || !current.projectId || current.selection?.projectId !== current.projectId ||
      requestedProjectId && requestedProjectId !== current.projectId) return
    const { projectId: id, canvasId } = current.selection
    const sequence = ++request.current
    const isCurrent = () => {
      const next = context.current
      return sequence === request.current && next.enabled && next.projectId === id &&
        next.selection?.projectId === id && next.selection.canvasId === canvasId
    }
    setLoading(true)
    try {
      const next = await api<ProjectDetail>(finalCutPath(`/projects/${id}`, canvasId))
      if (!isCurrent()) return
      if (next.id !== id || next.final_cut_canvas_id !== canvasId) throw new Error('成片方案返回不匹配，请重新选择方案')
      setSnapshot({ projectId: id, canvasId, detail: next })
      setError(null)
      return next
    } catch (caught) {
      if (isCurrent()) {
        setSnapshot(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally { if (isCurrent()) setLoading(false) }
  }, [])

  useEffect(() => {
    const sequence = ++entry.current
    request.current += 1
    setSnapshot(null)
    setSelection(null)
    setError(null)
    if (!enabled || !projectId) { setLoading(false); return }
    setLoading(true)
    void api<ProjectCanvasInfo[]>(`/projects/${projectId}/canvases`).then(next => {
      if (sequence !== entry.current) return
      const selected = finalCutCanvas(next, rememberedCanvas(projectId))
      if (!selected) throw new Error('项目没有可用的成片方案')
      setCatalog({ projectId, canvases: next })
      setSelection({ projectId, canvasId: selected.id })
    }).catch(caught => {
      if (sequence !== entry.current) return
      setCatalog(null)
      setError(caught instanceof Error ? caught.message : String(caught))
      setLoading(false)
    })
    return () => { entry.current += 1; request.current += 1 }
  }, [enabled, projectId, catalogRetry])

  useEffect(() => {
    if (!activeCanvasId) return
    void refresh()
    return () => { request.current += 1 }
  }, [activeCanvasId, refresh])

  function choose(canvasId: string | null) {
    if (!canvasId || canvasId === activeCanvasId || !projectId || !finalCutCanvases(canvases).some(canvas => canvas.id === canvasId)) return
    request.current += 1
    setSnapshot(null)
    setError(null)
    setLoading(true)
    setSelection({ projectId, canvasId })
  }

  function retry() {
    if (activeCanvasId) void refresh()
    else setCatalogRetry(current => current + 1)
  }

  return { canvasId: activeCanvasId, canvases, choices: finalCutCanvases(canvases), detail, error, loading, choose, refresh, retry }
}
