import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import type { ProjectCanvasInfo } from './project-canvases'

export type ShotCanvasRequest = { canvasId: string; shotId: string; nodeId?: string; requestId: string }
const requestKey = (projectId: string) => `shot-canvas-open:${projectId}`

export function shotCanvasNode(nodes: CanvasNode[], shotId: string, assetId?: string | null) {
  const candidates = nodes.filter(node => !node.settings?.visual_profile_id &&
    (node.shot_id === shotId || !!assetId && node.asset_id === assetId))
  return candidates.find(node => node.type === 'generation' && node.settings?.modality === 'video')
    || candidates.find(node => node.type === 'generation') || candidates[0]
}

/** Prefer the user's current canvas. Check other canvases before importing a
 * missing shot so an existing graph is never duplicated in the default one. */
export async function findShotCanvasTarget(canvases: ProjectCanvasInfo[], preferredId: string | null,
  shotId: string, assetId: string | null, load: (canvas: ProjectCanvasInfo) => Promise<CanvasGraph>) {
  const preferred = canvases.find(canvas => canvas.id === preferredId) || canvases.find(canvas => canvas.is_default) || canvases[0]
  if (!preferred) throw new Error('项目没有可用画布')
  const ordered = [preferred, ...canvases.filter(canvas => canvas.id !== preferred.id)]
  let failed = false
  for (const canvas of ordered) {
    try {
      const graph = await load(canvas), node = shotCanvasNode(graph.nodes, shotId, assetId)
      if (node) return { canvasId: canvas.id, shotId, nodeId: node.id }
    } catch { failed = true }
  }
  if (failed) throw new Error('部分画布读取失败，请重试定位当前镜头')
  return { canvasId: preferred.id, shotId }
}

export function requestShotCanvas(projectId: string, request: ShotCanvasRequest) {
  window.sessionStorage.setItem(requestKey(projectId), JSON.stringify(request))
}
export function readShotCanvasRequest(projectId: string): ShotCanvasRequest | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(requestKey(projectId)) || '')
    return typeof value?.canvasId === 'string' && typeof value?.shotId === 'string' && typeof value?.requestId === 'string' ? value : null
  } catch { return null }
}
export function clearShotCanvasRequest(projectId: string, requestId: string) {
  if (readShotCanvasRequest(projectId)?.requestId === requestId) window.sessionStorage.removeItem(requestKey(projectId))
}
