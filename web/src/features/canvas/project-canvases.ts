export type ProjectCanvasInfo = { id: string; project_id: string; name: string; is_default: boolean; design_id?: string | null; node_count: number; viewport: { x: number; y: number; zoom: number } | null }
export function canvasGraphPath(projectId: string, canvasId?: string) {
  return `/projects/${projectId}/${canvasId ? `canvases/${canvasId}` : 'canvas'}`
}
export function activeCanvasKey(projectId: string) { return `project-active-canvas:${projectId}` }
export function rememberedCanvas(projectId: string): string | null {
  try { return window.localStorage.getItem(activeCanvasKey(projectId)) } catch { return null }
}
export function rememberCanvas(projectId: string, canvasId: string) {
  try { window.localStorage.setItem(activeCanvasKey(projectId), canvasId) } catch { /* Storage may be disabled. */ }
}
export function preferredCanvas(canvases: ProjectCanvasInfo[], remembered: string | null) {
  return canvases.find(canvas => canvas.id === remembered) || canvases.find(canvas => canvas.is_default) || canvases[0]
}
