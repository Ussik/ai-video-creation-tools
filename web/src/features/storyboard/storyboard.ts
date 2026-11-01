import type { Asset, Job, Model, ProjectDetail, ScriptArtifact, Shot } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from '../canvas/ProjectCanvas'

export type StoryboardKind = 'text' | 'image' | 'video'
export type StoryboardItem = {
  id: string
  kind: StoryboardKind
  title: string
  node?: CanvasNode
  artifact?: ScriptArtifact
  asset?: Asset
  shot?: Shot
  job?: Job
  overview?: boolean
  content: string
}

/** The board is a projection of saved documents and the same canvas graph. */
export function storyboardItems(detail: ProjectDetail, graph: CanvasGraph, models: Model[]): StoryboardItem[] {
  const assets = new Map(detail.assets.map(asset => [asset.id, asset]))
  const jobs = new Map(detail.jobs.map(job => [job.id, job]))
  const shots = new Map(detail.shots.map(shot => [shot.id, shot]))
  const modelKinds = new Map(models.map(model => [model.id, model.modality]))
  const scriptNode = graph.nodes.find(node => node.type === 'project_script_ref')
  const documents = [...(detail.script.artifacts || [])].filter(artifact => artifact.content.trim())
    .sort((a, b) => a.position - b.position || (a.episode_number || 0) - (b.episode_number || 0))
  const items: StoryboardItem[] = []
  if (scriptNode || documents.length || detail.script.outline.trim() || detail.script.characters.trim() || detail.script.scenes.length) {
    items.push({ id: scriptNode?.id || `script:${detail.id}`, kind: 'text', title: detail.name || '项目剧本',
      node: scriptNode, overview: true, content: detail.script.outline })
  }
  for (const artifact of documents) items.push({ id: `artifact:${artifact.id}`, kind: 'text',
    title: artifact.title, artifact, content: artifact.content })
  const orderedNodes = graph.nodes.map((node, index) => ({ node, index })).sort((a, b) => {
    const aShot = shots.get(a.node.shot_id || ''), bShot = shots.get(b.node.shot_id || '')
    if (aShot && bShot) return aShot.position - bShot.position || a.index - b.index
    return aShot ? -1 : bShot ? 1 : a.index - b.index
  })
  for (const { node } of orderedNodes) {
    if (node.type === 'project_script_ref' || node.settings.visual_profile_id) continue
    // A generated result node is also available through its generator card.
    // Keep older candidates and independently reused media, but avoid showing
    // the current result twice in the board and its preview gallery.
    if (node.asset_id && node.type !== 'generation' && node.type !== 'image_analysis' && graph.edges.some(edge => {
      if (edge.target !== node.id) return false
      const source = graph.nodes.find(item => item.id === edge.source && item.type === 'generation')
      return source && (source.asset_id || jobs.get(source.job_id || '')?.result_asset_id) === node.asset_id
    })) continue
    const shot = shots.get(node.shot_id || '')
    const job = jobs.get(node.job_id || '')
    // Prefer the node's pinned asset; fall back to a newly completed job.
    // Analysis owns an input image; its board output is the editable prompt.
    const asset = node.type === 'image_analysis' ? undefined : assets.get(node.asset_id || '') || assets.get(job?.result_asset_id || '')
    const kind = node.type === 'image_analysis' ? 'text' : node.type === 'generation'
      ? asset?.kind || node.settings.modality || modelKinds.get(node.model_id || '') || 'image'
      : node.type
    if (kind !== 'text' && kind !== 'image' && kind !== 'video') continue
    items.push({ id: node.id, kind, node, shot, asset, job,
      title: node.title || shot?.title || asset?.filename || (kind === 'text' ? '文本节点' : '媒体节点'),
      content: kind === 'text' && node.type === 'generation' ? asset?.text || '' : node.text,
    })
  }
  return items
}

export function storyboardStatus(item: StoryboardItem): string {
  if (item.job?.status === 'queued') return '排队中'
  if (item.job?.status === 'running') return '生成中'
  if (item.job?.status === 'failed') return '生成失败'
  if (item.asset) return item.kind === 'text' ? '文本已生成' : '素材可预览'
  if (item.kind === 'text') return item.content.trim() || item.overview ? '创作文本' : '空白文本'
  return item.node?.type === 'generation' ? '尚未生成' : '素材不可用'
}

export function storyboardContext(item: StoryboardItem, detail: ProjectDetail): string {
  const body = item.overview ? [detail.script.outline, detail.script.characters].filter(Boolean).join('\n\n')
    : item.kind === 'text' ? item.content : storyboardPrompt(item)
  return `参考故事板「${item.title}」${item.artifact?.episode_number ? `（第 ${item.artifact.episode_number} 集）` : ''}：\n${body.slice(0, 5500)}`
}

export function storyboardPrompt(item: StoryboardItem): string {
  if (item.job?.request) {
    try {
      const request = JSON.parse(item.job.request)
      if (typeof request.prompt === 'string' && request.prompt.trim()) return request.prompt
    } catch { /* Older task records may not contain a JSON request. */ }
  }
  return (item.node?.settings.prompt_override ? item.node.text : '')
    || item.asset?.prompt || item.node?.prompt || item.shot?.prompt || ''
}
