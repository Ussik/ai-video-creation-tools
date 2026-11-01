import { VIDEO_ANALYSIS_MAX_DURATION_MS, type VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import { supportsDoubaoVideoAnalysis } from '@video-studio/shared/models/video-analysis-settings'
import type { Asset, Model, ProjectDetail, Provider } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { visualNodeAsset } from './canvas-visual-profiles'

export type CanvasVideoAnalysisSource = { assetId?: string; sourceNodeId?: string; issue?: string }

export function videoAnalysisModels(models: Model[], providers: Provider[]): { id: string; label: string; is_default?: boolean }[] {
  return models.flatMap(model => model.enabled && supportsDoubaoVideoAnalysis(model)
    && providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter === 'http')
    ? [{ id: model.id, label: model.name, ...(model.is_default ? { is_default: true } : {}) }] : [])
}

/** Pin one concrete video version; neither graph order nor a new generation
 * silently changes the selected source. */
export function resolveCanvasVideoAnalysisSource(node: CanvasNode, graph: CanvasGraph,
  detail: Pick<ProjectDetail, 'id' | 'assets' | 'visual_profiles'>): CanvasVideoAnalysisSource {
  const video = (id: string): Asset | undefined => detail.assets.find(asset => asset.id === id && asset.kind === 'video'
    && (!asset.project_id || !detail.id || asset.project_id === detail.id))
  const sources = new Map<string, string | undefined>()
  if (node.asset_id) {
    if (!video(node.asset_id)) return { issue: '上传的视频已失效或不属于当前项目，请重新选择视频' }
    sources.set(node.asset_id, undefined)
  }
  for (const edge of graph.edges.filter(edge => edge.target === node.id)) {
    const source = graph.nodes.find(item => item.id === edge.source)
    if (!source || source.id === node.id || !['video', 'generation'].includes(source.type)
      || source.type === 'generation' && source.settings.modality && source.settings.modality !== 'video') {
      return { issue: '视频反推仅支持连接视频节点，请移除无效连线' }
    }
    const assetId = edge.reference_asset_id || visualNodeAsset(source, detail)?.id
    if (!assetId || !video(assetId)) return { issue: `参考节点「${source.title || '视频'}」尚无可用视频，请先生成或选择视频` }
    if (!sources.has(assetId) || !sources.get(assetId)) sources.set(assetId, source.id)
  }
  if (sources.size > 1) return { issue: '视频反推一次只分析一个视频，请保留一个上传视频或一条视频连线' }
  const entry = [...sources][0]
  if (!entry) return { issue: '请上传一个视频，或连接已有视频节点' }
  return { assetId: entry[0], ...(entry[1] ? { sourceNodeId: entry[1] } : {}) }
}

export function videoAnalysisRangeIssue(startMs: number, endMs: number | null, durationMs?: number): string {
  if (!Number.isSafeInteger(startMs) || startMs < 0 || endMs !== null && (!Number.isSafeInteger(endMs) || endMs < 0)) return '请输入有效的开始和结束时间'
  const knownDuration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined
  const end = endMs ?? knownDuration
  if (end === undefined) return ''
  if (end <= startMs) return '结束时间必须晚于开始时间'
  if (knownDuration !== undefined && (startMs >= knownDuration || end > knownDuration)) return '分析范围超出视频时长'
  if (end - startMs < 1000) return '请至少选择 1 秒视频进行分析'
  if (end - startMs > VIDEO_ANALYSIS_MAX_DURATION_MS) return `每次最多分析 ${VIDEO_ANALYSIS_MAX_DURATION_MS / 1000} 秒，请选择较短片段`
  return ''
}

export function videoAnalysisSourceChanged(result: VideoPromptAnalysisResult | undefined, assetId?: string): boolean {
  return !!result && result.asset_id !== assetId
}

export function videoAnalysisTime(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs))
  return `${Math.floor(total / 60_000)}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}.${String(Math.floor(total % 1000 / 10)).padStart(2, '0')}`
}
