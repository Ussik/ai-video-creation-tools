import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ProjectDetail } from '../../shared/api/api'
import { shareProjectSnapshot } from '../../features/projects/project-snapshot'

export function useProjectDetailRefresh(projectId: string | null) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const activeProjectId = useRef(projectId)
  const scope = useRef(0)
  const request = useRef(0)
  const mounted = useRef(true)

  // Update before effects run so a saved callback cannot refresh the old
  // project during the render that switches to a new one.
  if (activeProjectId.current !== projectId) {
    activeProjectId.current = projectId
    scope.current += 1
    request.current += 1
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      scope.current += 1
      request.current += 1
    }
  }, [projectId])

  const refreshDetail = useCallback(async (id = activeProjectId.current): Promise<ProjectDetail | undefined> => {
    // Reject stale explicit IDs before advancing the sequence: an old action
    // must neither fetch its former project nor supersede a current request.
    if (!id || !mounted.current || id !== activeProjectId.current) return
    const requestScope = scope.current
    const requestId = ++request.current
    const isCurrent = () => mounted.current && id === activeProjectId.current &&
      requestScope === scope.current && requestId === request.current

    let next: ProjectDetail
    try {
      next = await api<ProjectDetail>(`/projects/${id}`)
    } catch (error) {
      if (isCurrent()) throw error
      return
    }
    if (!isCurrent() || next.id !== id) return
    setDetail(previous => isCurrent() ? shareProjectSnapshot(previous, next) : previous)
    return next
  }, [])

  return { detail: detail?.id === projectId ? detail : null, setDetail, refreshDetail }
}
