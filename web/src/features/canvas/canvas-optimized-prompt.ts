import { jobPromptRequest } from '@video-studio/shared/jobs/prompt-optimization'
import type { Job, Model, ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { extractPromptBody, getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'

export type OptimizedPromptDraft = { id: string; projectId: string; job: Job; prompt: string }

export function validateOptimizedPromptReferences(job: Job, detail: ProjectDetail) {
  const value = jobPromptRequest(job.request).reference_asset_ids
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  if (ids.some(id => !detail.assets.some(asset => asset.id === id && asset.kind === 'image'))) {
    throw new Error('原任务的部分参考图已不可用，请先在画布补齐参考图后再优化。')
  }
  return ids
}

/** Import a historical failure as a separate editable draft, never as a retry. */
export function addOptimizedPromptDraft(graph: CanvasGraph, request: OptimizedPromptDraft, detail: ProjectDetail, models: Model[]) {
  if (request.projectId !== detail.id || request.job.project_id !== detail.id) throw new Error('优化草稿不属于当前项目')
  const referenceIds = validateOptimizedPromptReferences(request.job, detail)
  const original = jobPromptRequest(request.job.request)
  const x = graph.nodes.length ? Math.max(...graph.nodes.map(node => node.x + node.width)) + 100 : 80
  const y = 80
  const stringValue = (key: string) => typeof original[key] === 'string' ? original[key] as string : undefined
  const prompt = tokenizePromptReferenceNumbers(request.prompt, referenceIds)
  const template = tokenizePromptReferenceNumbers(getManagedPromptBlocks(stringValue('prompt_template') || stringValue('prompt') || '').join('\n\n'), referenceIds)
  const node: CanvasNode = {
    id: request.id, type: 'generation', x, y, width: 440, height: 420, title: '图片生成 · 优化草稿',
    text: prompt, prompt, asset_id: null, job_id: null,
    shot_id: detail.shots.some(shot => shot.id === request.job.shot_id) ? request.job.shot_id : null,
    model_id: models.some(model => model.id === request.job.model_id && model.enabled) ? request.job.model_id : null,
    settings: { modality: 'image', mode: referenceIds.length ? 'reference' : 'text',
      ratio: stringValue('ratio'), resolution: stringValue('resolution'), clarity: stringValue('clarity'),
      quality: stringValue('quality'), background: stringValue('background'),
      // Keep the reviewed full prompt authoritative on import; rebuilding it
      // from shot/profile prose could reintroduce the rejected descriptions.
      visual_reference_mode: 'text_only', visual_dependencies: false, prompt_override: true,
      prompt_is_final: true, prompt_document: true, prompt_base: prompt, prompt_body: extractPromptBody({ prompt }),
      prompt_template: template, prompt_sections: parsePromptSectionDocument(prompt, { sourceText: template }) },
  }
  const references: CanvasNode[] = referenceIds.map((id, i) => ({
    id: `${request.id}-ref-${i}`, type: 'image', x: x - 520, y: y + i * 310, width: 400, height: 272,
    title: detail.assets.find(asset => asset.id === id)!.filename, text: '', prompt: '', asset_id: id,
    shot_id: null, model_id: null, job_id: null, settings: {},
  }))
  return { node, graph: { ...graph, nodes: [...graph.nodes, ...references, node],
    edges: [...graph.edges, ...references.map(reference => ({ id: `${reference.id}-edge`, source: reference.id, target: node.id, reference_asset_id: reference.asset_id! }))] } }
}
