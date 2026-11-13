import { useEffect, useMemo, useState } from 'react'
import { api, type Asset, type ProjectDetail } from '../../shared/api/api'
import { canvasGraphPath } from '../canvas/project-canvases'
import { finalCutAssetStates, type FinalCutAssetNode } from './final-cut-asset-status'

type Snapshot = { path: string; nodes: FinalCutAssetNode[]; loading: boolean; error: string }

/** Read the same current media versions that the source canvas displays. */
export function useFinalCutAssetStates(detail: ProjectDetail, canvasId?: string | null, assets: Asset[] = detail.assets) {
  const path = canvasGraphPath(detail.id, canvasId || undefined)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(current => ({ path, nodes: current?.path === path ? current.nodes : [], loading: true, error: '' }))
    void api<{ nodes: FinalCutAssetNode[] }>(path, { signal: controller.signal }).then(graph => {
      if (!controller.signal.aborted) setSnapshot({ path, nodes: graph.nodes, loading: false, error: '' })
    }).catch(error => {
      if (!controller.signal.aborted) setSnapshot({ path, nodes: [], loading: false,
        error: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [path, detail, attempt])
  const current = snapshot?.path === path ? snapshot : null
  const states = useMemo(() => finalCutAssetStates({ ...detail, assets }, current?.nodes), [detail, assets, current?.nodes])
  return { states, loading: !current || current.loading, error: current?.error || '', retry: () => setAttempt(value => value + 1) }
}
