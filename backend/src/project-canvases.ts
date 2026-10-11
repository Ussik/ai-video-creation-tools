import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { all, db, newId, now, one, required, run, type Project } from './db.js'

export type ProjectCanvasRecord = { id: string; project_id: string; name: string; position: number; is_default: number; viewport: string | null; created_at: string; updated_at: string }
type Graph = { revision: string; nodes: Array<{ id: string; x: number; y: number; width: number; settings: { visual_profile_id?: string } }>; edges: Array<{ id: string; source: string; target: string }> }
const id = z.string().min(1).max(100)
const params = z.object({ id, canvasId: id })
function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
export function defaultCanvas(projectId: string): ProjectCanvasRecord {
  required<Project>('projects', projectId)
  let canvas = one<ProjectCanvasRecord>('SELECT * FROM project_canvases WHERE project_id=? AND is_default=1', projectId)
  if (!canvas) {
    const timestamp = now()
    run('INSERT INTO project_canvases (id, project_id, name, position, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)', projectId, projectId, '画布 1', timestamp, timestamp)
    canvas = canvasRecord(projectId, projectId)
  }
  return canvas
}
export function canvasRecord(projectId: string, canvasId: string) {
  required<Project>('projects', projectId)
  const canvas = one<ProjectCanvasRecord>('SELECT * FROM project_canvases WHERE id=? AND project_id=?', canvasId, projectId)
  if (!canvas) fail('画布不存在或不属于当前项目', 404)
  return canvas
}
function metadata(canvas: ProjectCanvasRecord) {
  return { ...canvas, is_default: !!canvas.is_default, viewport: canvas.viewport ? JSON.parse(canvas.viewport) : null,
    node_count: one<{ total: number }>('SELECT COUNT(*) AS total FROM canvas_nodes WHERE project_id=? AND (canvas_id=? OR (canvas_id IS NULL AND ?=1))', canvas.project_id, canvas.id, canvas.is_default)!.total }
}
function touch(projectId: string) { run('UPDATE projects SET updated_at=? WHERE id=?', now(), projectId) }

export function registerProjectCanvasRoutes(app: FastifyInstance, context: { graph: (projectId: string, canvasId: string) => Graph; save: (projectId: string, canvasId: string, payload: unknown) => Graph }) {
  app.get('/api/projects/:id/canvases', async request => {
    const { id: projectId } = z.object({ id }).parse(request.params)
    defaultCanvas(projectId)
    return all<ProjectCanvasRecord>('SELECT * FROM project_canvases WHERE project_id=? ORDER BY position, created_at, id', projectId).map(metadata)
  })
  app.post('/api/projects/:id/canvases', async request => {
    const { id: projectId } = z.object({ id }).parse(request.params)
    const data = z.object({ name: z.string().trim().min(1).max(80).optional() }).strict().parse(request.body || {})
    return db.transaction(() => {
      defaultCanvas(projectId)
      const position = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM project_canvases WHERE project_id=?', projectId)!.next
      const existing = all<{ name: string }>('SELECT name FROM project_canvases WHERE project_id=?', projectId)
      let number = 1
      while (existing.some(item => item.name === `画布 ${number}`)) number++
      const canvasId = newId(), timestamp = now()
      run('INSERT INTO project_canvases (id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', canvasId, projectId, data.name || `画布 ${number}`, position, timestamp, timestamp)
      touch(projectId)
      return metadata(canvasRecord(projectId, canvasId))
    }).immediate()
  })
  app.get('/api/projects/:id/canvases/:canvasId', async request => {
    const { id: projectId, canvasId } = params.parse(request.params)
    return db.transaction(() => context.graph(projectId, canvasId))()
  })
  app.put('/api/projects/:id/canvases/:canvasId', async request => {
    const { id: projectId, canvasId } = params.parse(request.params)
    return context.save(projectId, canvasId, request.body)
  })
  app.patch('/api/projects/:id/canvases/:canvasId', async request => {
    const { id: projectId, canvasId } = params.parse(request.params)
    const data = z.object({ name: z.string().trim().min(1).max(80).optional(),
      viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(8) }).nullable().optional(),
    }).strict().parse(request.body)
    return db.transaction(() => {
      canvasRecord(projectId, canvasId)
      if (data.name !== undefined) { run('UPDATE project_canvases SET name=?, updated_at=? WHERE id=?', data.name, now(), canvasId); touch(projectId) }
      if (data.viewport !== undefined) run('UPDATE project_canvases SET viewport=? WHERE id=?', data.viewport ? JSON.stringify(data.viewport) : null, canvasId)
      return metadata(canvasRecord(projectId, canvasId))
    }).immediate()
  })
  app.delete('/api/projects/:id/canvases/:canvasId', async request => {
    const { id: projectId, canvasId } = params.parse(request.params)
    const data = z.object({ revision: z.string().length(64) }).strict().parse(request.body)
    return db.transaction(() => {
      const canvas = canvasRecord(projectId, canvasId)
      const others = all<ProjectCanvasRecord>('SELECT * FROM project_canvases WHERE project_id=? AND id<>? ORDER BY position', projectId, canvasId)
      if (!others.length) fail('项目至少保留一张画布')
      if (context.graph(projectId, canvasId).revision !== data.revision) fail('画布已更新，请刷新后再删除', 409)
      run('DELETE FROM canvas_edges WHERE project_id=? AND (canvas_id=? OR (canvas_id IS NULL AND ?=1))', projectId, canvasId, canvas.is_default)
      run('DELETE FROM canvas_nodes WHERE project_id=? AND (canvas_id=? OR (canvas_id IS NULL AND ?=1))', projectId, canvasId, canvas.is_default)
      run('DELETE FROM project_canvases WHERE id=?', canvasId)
      if (canvas.is_default) run('UPDATE project_canvases SET is_default=1 WHERE id=?', others[0]!.id)
      touch(projectId)
      return { canvas_id: others[0]!.id }
    }).immediate()
  })
  app.post('/api/projects/:id/canvases/:canvasId/move-nodes', async request => {
    const { id: projectId, canvasId } = params.parse(request.params)
    const data = z.object({ target_canvas_id: id, node_ids: z.array(id).min(1).max(500),
      revision: z.string().length(64), target_revision: z.string().length(64) }).strict().parse(request.body)
    return db.transaction(() => {
      canvasRecord(projectId, canvasId); canvasRecord(projectId, data.target_canvas_id)
      if (canvasId === data.target_canvas_id) fail('请选择其他画布')
      const source = context.graph(projectId, canvasId), target = context.graph(projectId, data.target_canvas_id)
      if (source.revision !== data.revision || target.revision !== data.target_revision) fail('画布已更新，请重新移动', 409)
      const selected = new Set(data.node_ids), moved = source.nodes.filter(node => selected.has(node.id))
      if (selected.size !== data.node_ids.length || moved.length !== selected.size) fail('请选择当前画布的节点')
      const internal = source.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target))
      if (target.nodes.length + moved.length > 500 || target.edges.length + internal.length > 1000) fail('目标画布容量不足')
      const profiles = new Set(target.nodes.map(node => node.settings.visual_profile_id).filter(Boolean))
      if (moved.some(node => node.settings.visual_profile_id && profiles.has(node.settings.visual_profile_id))) fail('目标画布已有相同设定，请使用已有节点')
      const dx = (target.nodes.length ? Math.max(...target.nodes.map(node => node.x + node.width)) + 160 : 80) - Math.min(...moved.map(node => node.x))
      const dy = 80 - Math.min(...moved.map(node => node.y))
      for (const edge of source.edges) {
        if (selected.has(edge.source) && selected.has(edge.target)) run('UPDATE canvas_edges SET canvas_id=?, position=? WHERE project_id=? AND id=?', data.target_canvas_id, target.edges.length + internal.indexOf(edge), projectId, edge.id)
        else if (selected.has(edge.source) || selected.has(edge.target)) run('DELETE FROM canvas_edges WHERE project_id=? AND id=?', projectId, edge.id)
      }
      for (const [index, node] of moved.entries()) run('UPDATE canvas_nodes SET canvas_id=?, position=?, x=?, y=? WHERE project_id=? AND id=?', data.target_canvas_id, target.nodes.length + index, node.x + dx, node.y + dy, projectId, node.id)
      run('UPDATE project_canvases SET updated_at=? WHERE id IN (?, ?)', now(), canvasId, data.target_canvas_id)
      touch(projectId)
      return { source: context.graph(projectId, canvasId), target: context.graph(projectId, data.target_canvas_id) }
    }).immediate()
  })
}
