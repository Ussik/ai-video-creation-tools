import type { Asset, ProjectDetail } from '../../src/api'
import type { CanvasGraph, CanvasNode } from '../../src/ProjectCanvas'
import type { ProjectCanvasInfo } from '../../src/project-canvases'

export const projectId = 'final-cut-fixture'
const timestamp = '2026-10-11T00:00:00Z'
export const stillUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#38352f"/><path d="M0 265L200 95L340 230L480 120L640 280V360H0" fill="#655f50"/><circle cx="470" cy="80" r="32" fill="#cbc1a6"/></svg>')}`
export function canvasNode(id: string, shotId: string | null = null, type: CanvasNode['type'] = 'generation'): CanvasNode {
  return { id, type, x: 900, y: 700, width: 440, height: 420, title: id, text: '', prompt: '角色走向站台',
    asset_id: null, shot_id: shotId, model_id: null, job_id: null, settings: type === 'generation' ? { modality: 'video' } : {} }
}
export function fixture() {
  const asset = (id: string, shotId: string, kind: Asset['kind']): Asset => ({ id, project_id: projectId, shot_id: shotId,
    kind, filename: `${id}.${kind === 'video' ? 'mp4' : kind === 'text' ? 'txt' : 'png'}`, source: 'generated',
    model_id: null, prompt: '站台镜头', remote_url: null, saved: true, created_at: timestamp, url: kind === 'image' ? stillUrl : 'data:video/mp4;base64,AAAA', text: kind === 'text' ? '提示词结果不应入片' : undefined })
  const detail: ProjectDetail = { id: projectId, name: '夜班列车 · 成片测试', brief: '浏览器独立模拟数据', ratio: '16:9', music_asset_id: null,
    created_at: timestamp, updated_at: timestamp, production_range: { start_shot_id: null, end_shot_id: null },
    script: { outline: '林晚赶上夜班列车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
    shots: ['s1', 's2'].map((id, position) => ({ id, project_id: projectId, position, title: position ? '回望站台' : '走向列车',
      prompt: '创作提示词仅在画布编辑', duration: 5, selected_asset_id: position ? 'still' : 'video', source_scene_id: null,
      start_state: '林晚站在站台边', end_state: '林晚走向车门', cut_note: '保持人物视线方向' })),
    assets: [asset('video', 's1', 'video'), asset('alternate', 's1', 'image'), asset('text-only', 's1', 'text'), asset('still', 's2', 'image')],
    timeline_clips: [{ id: 'c1', project_id: projectId, shot_id: 's1', asset_id: 'video', in_ms: 0, out_ms: 5000,
      source_duration_ms: 6000, source_audio_gain: 1, source_audio_fade_ms: 0 },
      { id: 'c2', project_id: projectId, shot_id: 's2', asset_id: 'still', in_ms: 0, out_ms: 3000,
        source_duration_ms: null, source_audio_gain: 1, source_audio_fade_ms: 0 }],
    asset_reviews: [], jobs: [], asset_tasks: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
  }
  const canvases: ProjectCanvasInfo[] = [
    { id: projectId, project_id: projectId, name: '画布 1', is_default: true, node_count: 1, viewport: { x: 20, y: 30, zoom: 0.8 } },
    { id: 'second', project_id: projectId, name: '视频制作', is_default: false, node_count: 2, viewport: { x: 20, y: 30, zoom: 0.8 } },
  ]
  const graphs: Record<string, CanvasGraph> = {
    [projectId]: { revision: 'default-rev', nodes: [canvasNode('notes', null, 'text')], edges: [] },
    second: { revision: 'second-rev', nodes: [canvasNode('video-node', 's1'), canvasNode('shot-two', 's2')], edges: [] },
  }
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = []
  async function fetchFixture(url: unknown, init?: RequestInit): Promise<Response> {
    const path = String(url), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ path, method, body })
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/models' || path === '/api/providers') return Response.json([])
    if (path === `/api/projects/${projectId}`) {
      if (method === 'PATCH') Object.assign(detail, body)
      return Response.json(detail)
    }
    if (path === `/api/projects/${projectId}/canvases`) return Response.json(canvases)
    if (path === `/api/projects/${projectId}/canvas`) {
      if (method === 'PUT') graphs[projectId] = { ...body, revision: 'saved-rev' } as CanvasGraph
      return Response.json(graphs[projectId])
    }
    const graphMatch = path.match(new RegExp(`^/api/projects/${projectId}/canvases/([^/]+)$`))
    if (graphMatch) {
      if (method === 'PUT') graphs[graphMatch[1]] = { ...body, revision: 'saved-rev' } as CanvasGraph
      return Response.json(method === 'PATCH' ? canvases.find(canvas => canvas.id === graphMatch[1]) : graphs[graphMatch[1]])
    }
    if (path === `/api/projects/${projectId}/continuity`) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: 'fixture' })
    if (path === `/api/projects/${projectId}/cut-reviews`) return Response.json({ cuts: [] })
    const clipMatch = path.match(/^\/api\/timeline-clips\/(c[12])$/)
    if (clipMatch && method === 'PATCH') { Object.assign(detail.timeline_clips.find(clip => clip.id === clipMatch[1])!, body); return Response.json({}) }
    const selection = path.match(/^\/api\/shots\/(s[12])\/selection$/)
    if (selection && method === 'PUT') {
      const shot = detail.shots.find(shot => shot.id === selection[1])!, clip = detail.timeline_clips.find(clip => clip.shot_id === shot.id)!
      shot.selected_asset_id = body.asset_id
      Object.assign(clip, { asset_id: body.asset_id, in_ms: 0, out_ms: 5000, source_duration_ms: body.asset_id === 'video' ? 6000 : null })
      return Response.json({})
    }
    if (path === `/api/projects/${projectId}/export` && method === 'POST') return Response.json({ id: 'export' })
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  }
  return { detail, canvases, graphs, requests, fetchFixture }
}
