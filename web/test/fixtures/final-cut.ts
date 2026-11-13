import type { Asset, ProjectDetail } from '../../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../../src/features/canvas/ProjectCanvas'
import type { ProjectCanvasInfo } from '../../src/features/canvas/project-canvases'

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
  const scopes: Record<string, ProjectDetail> = {}
  const failures = new Map<string, string>()
  const delays = new Map<string, Promise<void>>()
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = []
  async function fetchFixture(url: unknown, init?: RequestInit): Promise<Response> {
    const requestPath = String(url), parsed = new URL(requestPath, 'http://localhost')
    const path = parsed.pathname, canvasId = parsed.searchParams.get('canvas_id'), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ path: requestPath, method, body })
    if (delays.has(requestPath)) await delays.get(requestPath)
    if (failures.has(requestPath)) return Response.json({ detail: failures.get(requestPath) }, { status: 422 })
    const activeDetail = canvasId ? scopes[canvasId] || detail : detail
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/models' || path === '/api/providers') return Response.json([])
    if (path === '/api/speech/config') return Response.json({ enabled: true, has_key: false, default_speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 0 })
    if (path === `/api/projects/${projectId}/speech`) return Response.json(detail.speech || { voices: [], lines: [], placements: [] })
    if (path === `/api/projects/${projectId}/audio-settings` && method === 'PUT') {
      detail.audio_settings = { music_gain: body.music_gain, duck_music: body.duck_music, duck_source: body.duck_source }
      if (body.ratio !== undefined) detail.ratio = body.ratio
      if (body.music_asset_id !== undefined) detail.music_asset_id = body.music_asset_id
      return Response.json(detail.audio_settings)
    }
    if (path === `/api/projects/${projectId}`) {
      if (method === 'PATCH') Object.assign(detail, body)
      return Response.json(canvasId ? { ...activeDetail, final_cut_canvas_id: canvasId } : detail)
    }
    if (path === `/api/projects/${projectId}/shot-management`) return Response.json({ revision: 'fixture-shot-state',
      shots: [], designs: [], canvases, scenes: [], trashed_assets: [] })
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
    if (path === `/api/projects/${projectId}/production-range` && method === 'PUT') { activeDetail.production_range = body; return Response.json(body) }
    if (path === `/api/projects/${projectId}/continuity/analyze` && method === 'POST') return Response.json({})
    if (path === `/api/projects/${projectId}/continuity`) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: 'fixture' })
    if (path === `/api/projects/${projectId}/cut-reviews`) return Response.json({ cuts: [] })
    const clipMatch = path.match(/^\/api\/timeline-clips\/([^/]+)$/)
    if (clipMatch && method === 'PATCH') { Object.assign(activeDetail.timeline_clips.find(clip => clip.id === clipMatch[1])!, body); return Response.json({}) }
    const selection = path.match(/^\/api\/shots\/([^/]+)\/selection$/)
    if (selection && method === 'PUT') {
      const shot = activeDetail.shots.find(shot => shot.id === selection[1])!, clip = activeDetail.timeline_clips.find(clip => clip.shot_id === shot.id)!
      shot.selected_asset_id = body.asset_id
      Object.assign(clip, { asset_id: body.asset_id, in_ms: 0, out_ms: 5000, source_duration_ms: body.asset_id === 'video' ? 6000 : null })
      return Response.json({})
    }
    const shotPosition = path.match(/^\/api\/shots\/([^/]+)$/)
    if (shotPosition && method === 'PATCH') { Object.assign(activeDetail.shots.find(shot => shot.id === shotPosition[1])!, body); return Response.json({}) }
    if (path === `/api/projects/${projectId}/export` && method === 'POST') return Response.json({ id: 'export' })
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  }
  return { detail, canvases, graphs, scopes, failures, delays, requests, fetchFixture, initialCanvasId: null as string | null }
}


export function redesignedFixture() {
  const data = fixture()
  const original = structuredClone(data.detail)
  const redesign = structuredClone(data.detail)
  redesign.shots = redesign.shots.map((shot, index) => ({ ...shot, id: `new-${shot.id}`, title: index ? '新方案 · 车窗回望' : '新方案 · 雨夜登车',
    design_id: 'design-2', selected_asset_id: `new-${shot.selected_asset_id}` }))
  redesign.assets = redesign.assets.map(asset => ({ ...asset, id: `new-${asset.id}`, shot_id: asset.shot_id ? `new-${asset.shot_id}` : null }))
  redesign.timeline_clips = redesign.timeline_clips.map((clip, index) => ({ ...clip, id: `new-${clip.id}`, shot_id: `new-${clip.shot_id}`,
    asset_id: `new-${clip.asset_id}`, in_ms: 0, out_ms: index ? 4000 : 2000 }))
  redesign.production_range = { start_shot_id: 'new-s2', end_shot_id: 'new-s2' }
  data.scopes[projectId] = original
  data.scopes.second = redesign
  Object.assign(data.detail, structuredClone(redesign), { historical_shots: original.shots.map(shot => ({ ...shot, superseded_by: 'design-2' })) })
  data.canvases[1] = { ...data.canvases[1], name: '方案 2 · 雨夜', design_id: 'design-2' }
  data.graphs[projectId].nodes = [canvasNode('old-shot-one', 's1'), canvasNode('old-shot-two', 's2')]
  data.graphs.second.nodes = [canvasNode('new-shot-one', 'new-s1'), canvasNode('new-shot-two', 'new-s2')]
  data.initialCanvasId = 'second'
  return data
}
