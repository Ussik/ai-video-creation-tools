import type { Asset, ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { visualNodeAsset } from './canvas-visual-profiles'

export type CanvasImageAnalysisSource = { assetId?: string; sourceNodeId?: string; issue?: string }

/** Analysis accepts one image. Conflicting uploads/connections need an explicit
 * choice; graph order never silently decides which image is sent to the model. */
export function resolveCanvasImageAnalysisSource(node: CanvasNode, graph: CanvasGraph,
  detail: Pick<ProjectDetail, 'id' | 'assets' | 'visual_profiles'>): CanvasImageAnalysisSource {
  const image = (id: string): Asset | undefined => detail.assets.find(asset => asset.id === id && asset.kind === 'image'
    && (!asset.project_id || !detail.id || asset.project_id === detail.id))
  const sources = new Map<string, string | undefined>()
  if (node.asset_id) {
    if (!image(node.asset_id)) return { issue: '上传的图片已失效或不属于当前项目，请重新选择图片' }
    sources.set(node.asset_id, undefined)
  }
  for (const edge of graph.edges.filter(edge => edge.target === node.id)) {
    const source = graph.nodes.find(item => item.id === edge.source)
    if (!source || source.id === node.id || !['image', 'generation'].includes(source.type)
      || source.type === 'generation' && source.settings.modality && source.settings.modality !== 'image') {
      return { issue: '图片反推仅支持连接图片节点，请移除无效连线' }
    }
    // Keep the chosen image version when a source profile has a newer candidate.
    const assetId = edge.reference_asset_id || visualNodeAsset(source, detail, true)?.id
    if (!assetId || !image(assetId)) return { issue: `参考节点「${source.title || '图片'}」尚无可用图片，请先生成或选择图片` }
    if (!sources.has(assetId) || !sources.get(assetId)) sources.set(assetId, source.id)
  }
  if (sources.size > 1) return { issue: '图片反推一次只分析一张图片，请保留一张上传图片或一条图片连线' }
  const entry = [...sources][0]
  if (!entry) return { issue: '请上传一张图片，或连接已有图片节点' }
  return { assetId: entry[0], ...(entry[1] ? { sourceNodeId: entry[1] } : {}) }
}

/** Keep an editable result visible while making a changed source explicit. */
export function imageAnalysisSourceChanged(node: CanvasNode, assetId?: string): boolean {
  return !!node.text.trim() && !!node.settings.image_analysis_source_asset_id
    && node.settings.image_analysis_source_asset_id !== assetId
}
