import { api, json } from '../../shared/api/api'
import type { AssetTask, Job, Model, ProjectDetail, VisualBoardPreview, VisualProfile } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { imageGenerationDefaults, imageParameterValue, imagePreferencePrompt, imageRatioError, imageRequestResolution, imageResolutionClarity, modelDefaultResolution } from './canvas-model-parameters'
import { missingVisualReferences, visualBoardJobs, visualBoardReferences } from './canvas-visual-profiles'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'

export function visualReferenceGenerating(profile: VisualProfile, node: CanvasNode | undefined, detail: ProjectDetail, submittedJobIds: string[] = []) {
  const jobs = visualBoardJobs(profile, detail.jobs)
  if (node?.job_id) {
    const job = detail.jobs.find(item => item.id === node.job_id)
    if (job && !jobs.some(item => item.id === job.id)) jobs.push(job)
  }
  if (jobs.some(job => job.status === 'running')) return 'running'
  if (jobs.some(job => job.status === 'queued')
    || detail.asset_tasks.some(task => task.id === profile.asset_task_id && task.status === 'generating')
    || submittedJobIds.some(id => !detail.jobs.some(job => job.id === id))) return 'queued'
  return null
}

/** Prepare a board from its own saved node, regardless of canvas selection. */
export async function prepareCanvasVisualBoard(node: CanvasNode, profile: VisualProfile, graph: CanvasGraph, detail: ProjectDetail, model: Model) {
  const missing = missingVisualReferences(graph, node.id, detail, [model])
  if (missing.length) throw new Error(`请先补齐并确认参考图：${missing.map(reference => reference.name).join('、')}`)
  const references = visualBoardReferences(graph, node.id, detail)
  const inputTexts = graph.edges.filter(edge => edge.target === node.id)
    .map(edge => graph.nodes.find(source => source.id === edge.source))
    .filter(source => source?.type === 'text').map(source => source!.text.trim()).filter(Boolean)
  const input: ReturnType<typeof visualBoardReferences> & { prompt_append: string; prompt_override?: string } = {
    ...references, prompt_append: [...inputTexts, node.text.trim()].filter(Boolean).join('\n\n'),
    prompt_override: node.settings.profile_prompt_override }
  const preview = await api<VisualBoardPreview>(`/visual-profiles/${profile.id}/board-preview`, json('POST', {
    ...input, model_id: model.id, expected_revision: profile.revision,
  }))
  const defaults = imageGenerationDefaults(model)
  const ratio = node.settings.ratio || defaults.ratio
  const clarity = imageParameterValue(model, 'clarity', node.settings.clarity || imageResolutionClarity(node.settings.resolution) || defaults.clarity)
  const configured = model.settings.resolutions
  const resolutions = Array.isArray(configured) && configured.some(value => typeof value === 'string')
    ? configured.filter((value): value is string => typeof value === 'string') : ['1K', '2K', '4K']
  const resolution = imageRequestResolution(model, node.settings.resolution || modelDefaultResolution(model, resolutions), { ratio, clarity, mode: preview.mode }) || null
  const ratioIssue = imageRatioError(model, resolution || '', ratio, preview.mode)
  if (ratioIssue) throw new Error(ratioIssue)
  const referenceIssue = imageReferenceConfigError(model.settings, preview.reference_asset_ids.length, preview.mode)
  if (referenceIssue) throw new Error(referenceIssue)
  const quality = imageParameterValue(model, 'quality', node.settings.quality || defaults.quality)
  const background = imageParameterValue(model, 'background', node.settings.background || defaults.background)
  return {
    candidateCount: node.settings.candidate_count || 1, nodeId: node.id, board: { profile, preview, input }, model,
    shot: { title: `${profile.name} · ${profile.variant}` }, referenceNames: preview.reference_names,
    request: { shot_id: '', model_id: model.id, mode: preview.mode,
      project_style_version: preview.project_style_version, project_visual_style: preview.project_visual_style, style_warnings: preview.style_warnings,
      prompt: withProjectStyle(imagePreferencePrompt(model, preview.prompt, { ratio, resolution, clarity, quality, background }, preview.mode), preview.project_visual_style),
      reference_asset_ids: preview.reference_asset_ids, reference_video_url: null, ratio, resolution, clarity, quality, background,
      duration: 1, generate_audio: false, draft: false },
  }
}

type Board = Awaited<ReturnType<typeof prepareCanvasVisualBoard>>['board']
type BoardParameters = Pick<Awaited<ReturnType<typeof prepareCanvasVisualBoard>>['request'], 'model_id' | 'project_style_version' | 'prompt' | 'ratio' | 'resolution'> & {
  clarity?: string | null; quality?: string | null; background?: string | null
}

export function enqueueCanvasVisualBoard({ profile, preview, input }: Board, parameters: BoardParameters, candidateCount: number) {
  const { model_id, project_style_version, prompt, ratio, resolution, clarity, quality, background } = parameters
  return api<{ job: Job; jobs: Job[]; task: AssetTask }>(`/visual-profiles/${profile.id}/generate`, json('POST', {
    ...input, model_id, project_style_version, prompt, ratio, resolution, clarity, quality, background,
    expected_revision: profile.revision, reference_signature: preview.reference_signature,
    candidate_count: candidateCount,
  }))
}
