import { useEffect, useMemo, useRef, useState } from 'react'
import { videoAnalysisText, type VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import { api, json, type Asset, type ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph } from './ProjectCanvas'
import { resolveCanvasVideoAnalysisSource, videoAnalysisRangeIssue } from './canvas-video-analysis'

type Context = {
  detail: ProjectDetail
  canvasId: string
  graph: CanvasGraph | null
  getGraph: () => CanvasGraph | null | undefined
  models: { id: string }[]
  changeGraph: (update: (graph: CanvasGraph) => CanvasGraph) => void
  refresh: () => Promise<void>
  notice: (message: string) => void
}
type Run = { nodeId: string; phase: 'uploading' | 'analyzing'; started: number }

export function useCanvasVideoAnalysis(context: Context) {
  const latest = useRef(context); latest.current = context
  const request = useRef<{ nodeId: string; controller: AbortController } | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, Asset>>({})
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads
  const [durations, setDurations] = useState<Record<string, number>>({})
  const detail = useMemo(() => ({ ...context.detail, assets: [...context.detail.assets,
    ...Object.values(uploads).filter(asset => !context.detail.assets.some(item => item.id === asset.id))] }), [context.detail, uploads])
  const currentDetail = () => ({ ...latest.current.detail, assets: [...latest.current.detail.assets,
    ...Object.values(uploadsRef.current).filter(asset => !latest.current.detail.assets.some(item => item.id === asset.id))] })
  const error = (nodeId: string, message: string) => setErrors(current => ({ ...current, [nodeId]: message }))
  const cancel = () => { request.current?.controller.abort(); request.current = null; setRun(null) }
  useEffect(() => {
    setRun(null)
    setErrors({})
    return () => { request.current?.controller.abort(); request.current = null }
  }, [context.detail.id, context.canvasId])
  useEffect(() => {
    if (!run) return
    if (!context.graph || !context.graph.nodes.some(node => node.id === run.nodeId)) { cancel(); return }
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - run.started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [run, context.graph])
  const clearSource = (nodeId: string) => {
    if (request.current) return
    latest.current.changeGraph(graph => ({ ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? { ...node, asset_id: null } : node),
      edges: graph.edges.filter(edge => edge.target !== nodeId) }))
    error(nodeId, '')
  }
  const upload = async (nodeId: string, file: File) => {
    if (request.current) return
    if (!/\.(mp4|mov)$/i.test(file.name) || file.size > 300 * 1024 * 1024 || file.size <= 0) {
      error(nodeId, '请选择不超过 300 MB 的 MP4 或 MOV 视频'); return
    }
    const active = { nodeId, controller: new AbortController() }
    const canvasId = latest.current.canvasId, projectId = latest.current.detail.id
    request.current = active; error(nodeId, ''); setElapsed(0); setRun({ nodeId, phase: 'uploading', started: Date.now() })
    try {
      const form = new FormData(); form.append('file', file)
      const asset = await api<Asset>(`/projects/${latest.current.detail.id}/assets`, { method: 'POST', body: form, signal: active.controller.signal })
      if (request.current !== active || active.controller.signal.aborted || latest.current.canvasId !== canvasId || latest.current.detail.id !== projectId) return
      if (asset.kind !== 'video') throw new Error('上传文件未识别为视频，请更换文件')
      uploadsRef.current = { ...uploadsRef.current, [asset.id]: asset }; setUploads(uploadsRef.current)
      latest.current.changeGraph(graph => ({ ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? { ...node, asset_id: asset.id } : node),
        edges: graph.edges.filter(edge => edge.target !== nodeId) }))
      await latest.current.refresh()
    } catch (issue) {
      if (request.current === active && !active.controller.signal.aborted) error(nodeId, issue instanceof Error ? issue.message : String(issue))
    } finally { if (request.current === active) { request.current = null; setRun(null) } }
  }
  const analyze = async (nodeId: string) => {
    if (request.current) return
    const graph = latest.current.getGraph(), node = graph?.nodes.find(item => item.id === nodeId)
    if (!graph || node?.type !== 'video_analysis') return
    const source = resolveCanvasVideoAnalysisSource(node, graph, currentDetail())
    const model = latest.current.models.find(item => item.id === node.model_id)
    const start_ms = node.settings.video_analysis_start_ms || 0, end_ms = node.settings.video_analysis_end_ms ?? null
    const instructions = node.settings.video_analysis_instructions || '', fps = node.settings.video_analysis_fps ?? 2
    const issue = source.issue || (!model ? '请选择已配置豆包视频理解的文本模型' : '')
      || videoAnalysisRangeIssue(start_ms, end_ms, source.assetId ? durations[source.assetId] : undefined)
    if (issue || !source.assetId || !model) { error(nodeId, issue); return }
    const sourceAssetId = source.assetId, originalText = node.text, originalResult = JSON.stringify(node.settings.video_analysis_result)
    const active = { nodeId, controller: new AbortController() }
    const canvasId = latest.current.canvasId, projectId = latest.current.detail.id
    request.current = active; error(nodeId, ''); setElapsed(0); setRun({ nodeId, phase: 'analyzing', started: Date.now() })
    const timeout = window.setTimeout(() => active.controller.abort(new Error('视频反推超时，请缩小分析范围后重试')), 300_000)
    try {
      const result = await api<VideoPromptAnalysisResult>(`/projects/${latest.current.detail.id}/canvas/video-prompt-analysis`, {
        ...json('POST', { asset_id: sourceAssetId, model_id: model.id, instructions, start_ms, end_ms, fps }), signal: active.controller.signal,
      })
      if (request.current !== active || active.controller.signal.aborted || latest.current.canvasId !== canvasId || latest.current.detail.id !== projectId) return
      if (result.asset_id !== sourceAssetId || result.model_id !== model.id || result.start_ms !== start_ms
        || result.end_ms !== (end_ms ?? result.duration_ms) || result.fps !== fps || !result.shots?.length || !result.global_style?.trim()) {
        throw new Error('反推结果与当前视频或分析范围不匹配，请重试')
      }
      const newestGraph = latest.current.getGraph(), newest = newestGraph?.nodes.find(item => item.id === nodeId)
      if (!newestGraph || newest?.type !== 'video_analysis') return
      const newestSource = resolveCanvasVideoAnalysisSource(newest, newestGraph, currentDetail())
      if (newestSource.issue || newestSource.assetId !== sourceAssetId || newest.model_id !== model.id
        || (newest.settings.video_analysis_instructions || '') !== instructions || (newest.settings.video_analysis_start_ms || 0) !== start_ms
        || (newest.settings.video_analysis_end_ms ?? null) !== end_ms || (newest.settings.video_analysis_fps ?? 2) !== fps
        || newest.text !== originalText || JSON.stringify(newest.settings.video_analysis_result) !== originalResult) {
        throw new Error('视频、分析要求或人工内容已变化，本次结果未覆盖当前内容，请重新反推')
      }
      latest.current.changeGraph(current => ({ ...current, nodes: current.nodes.map(item => item.id === nodeId
        ? { ...item, text: videoAnalysisText(result), settings: { ...item.settings, video_analysis_result: result } } : item) }))
      setDurations(current => ({ ...current, [sourceAssetId]: result.duration_ms }))
      latest.current.notice(`已拆解 ${result.shots.length} 个镜头，可编辑提示词后创建视频生成节点`)
    } catch (issue) {
      if (request.current === active) error(nodeId, active.controller.signal.aborted
        ? '视频反推超时，请缩小分析范围后重试' : issue instanceof Error ? issue.message : String(issue))
    } finally {
      window.clearTimeout(timeout)
      if (request.current === active) { request.current = null; setRun(null) }
    }
  }
  return { detail, run, elapsed, errors, durations, upload, analyze, cancel, clearSource, clearError: (nodeId: string) => error(nodeId, ''),
    setDuration: (assetId: string, value: number) => setDurations(current => current[assetId] === value ? current : { ...current, [assetId]: value }) }
}
