import { api, json } from '../../shared/api/api'
import type { AssetTask, Job, Model, ProjectDetail, VisualBoardPreview, VisualProfile } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { imageGenerationDefaults, imageParameterValue, imagePreferencePrompt, imageRatioError, imageRequestResolution, imageResolutionClarity, modelDefaultResolution } from './canvas-model-parameters'
import { missingVisualReferences, visualBoardJobs } from './canvas-visual-profiles'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { visualProfileBaseReadiness, visualProfileLabel } from '../visuals/visual-profile-inheritance'
import type { PromptReferenceOverrides } from '@video-studio/shared/visuals/prompt-references'
import { disconnectedPromptReferenceIds } from './canvas-prompt-references'
import { stripVisualProfileBaseReference, withVisualProfileBaseReference } from './canvas-profile-reference-prompt'
import { resolveCanvasVisualBoardReferences } from './canvas-visual-board-references'
import { hasVisualBoardPromptContent, preserveAbsentVisualBoardPrimary } from '@video-studio/shared/visuals/visual-board-document'
import { isPromptSectionDocument, parsePromptSectionDocument, reconcilePromptSectionDocument, recoverLegacyPromptSectionDocument, serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { findPromptParameterConflicts } from '@video-studio/shared/visuals/prompt-parameter-conflicts'
import { rewriteCanvasPromptSections } from './canvas-prompt-composition'
import { withVisualProfilePrompt } from '@video-studio/shared/visuals/visual-profile-prompt'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { resolveCanvasProfileDisplayText } from './canvas-profile-display-text'

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
export async function prepareCanvasVisualBoard(node: CanvasNode, profile: VisualProfile, graph: CanvasGraph, detail: ProjectDetail, model: Model, promptDocument?: string) {
  const inheritance = visualProfileBaseReadiness(profile, detail)
  if (inheritance.error) throw new Error(inheritance.error)
  if (inheritance.waitingProfile) throw new Error(`请先生成并确认「${visualProfileLabel(inheritance.waitingProfile)}」的基础图，再生成当前状态`)
  const missing = missingVisualReferences(graph, node.id, detail, [model])
  if (missing.length) throw new Error(`请先补齐并确认参考图：${missing.map(reference => reference.name).join('、')}`)
  const references = resolveCanvasVisualBoardReferences(node, profile, graph, detail)
  if (references.error) throw new Error(references.error)
  const inputTexts = graph.edges.filter(edge => edge.target === node.id)
    .map(edge => graph.nodes.find(source => source.id === edge.source))
    .filter(source => source?.type === 'text').map(source => source!.text.trim()).filter(Boolean)
  const baseAssetId = inheritance.baseProfile?.board_asset_id
  const defaults = imageGenerationDefaults(model)
  const ratio = node.settings.ratio || defaults.ratio
  const clarity = imageParameterValue(model, 'clarity', node.settings.clarity || imageResolutionClarity(node.settings.resolution) || defaults.clarity)
  const configured = model.settings.resolutions
  const resolutions = Array.isArray(configured) && configured.some(value => typeof value === 'string')
    ? configured.filter((value): value is string => typeof value === 'string') : ['1K', '2K', '4K']
  const mode = references.assetIds.length ? 'reference' : 'text'
  const resolution = imageRequestResolution(model, node.settings.resolution || modelDefaultResolution(model, resolutions), { ratio, clarity, mode }) || null
  const quality = imageParameterValue(model, 'quality', node.settings.quality || defaults.quality)
  const background = imageParameterValue(model, 'background', node.settings.background || defaults.background)
  const savedSections = isPromptSectionDocument(node.settings.prompt_sections) ? node.settings.prompt_sections : undefined
  let document = promptDocument ?? (savedSections ? serializePromptSectionDocument(savedSections)
    : node.settings.prompt_document ? node.settings.profile_prompt_override : undefined)
  // Batch generation may prepare a node without ever opening its composer.
  // Refresh untouched template sections using that node's current controls.
  if (document !== undefined && promptDocument === undefined) {
    const display = (value: string) => resolveCanvasProfileDisplayText(value, profile, detail)
    const nextTemplate = withProjectStyle(imagePreferencePrompt(model, withVisualProfilePrompt('', {
      ...profile, definition: display(profile.definition), view_requirements: display(profile.view_requirements),
      state_delta: display(profile.state_delta || ''),
    }, references.assetIds.map(asset_id => {
      const source = references.sources.find(item => item.assetId === asset_id)
      const owner = detail.visual_profiles?.find(item => item.id === source?.profileId)
      return { asset_id, name: owner?.name || source?.label || detail.assets.find(item => item.id === asset_id)?.filename || '参考图片',
        variant: owner?.variant, definition: owner ? resolveCanvasProfileDisplayText(owner.definition, owner, detail) : undefined, role: source?.role }
    })), { ratio, resolution, clarity, quality, background }, mode), detail.project_visual_style)
    const tokenize = (value: string) => tokenizePromptReferenceNumbers(value, references.assetIds)
    const current = rewriteCanvasPromptSections(savedSections, tokenize)
      ?? parsePromptSectionDocument(tokenize(document), { sourceText: tokenize(node.settings.prompt_template || '') })
    const recovered = recoverLegacyPromptSectionDocument(current, tokenize(node.settings.prompt_template || ''))
    const sections = reconcilePromptSectionDocument(preserveAbsentVisualBoardPrimary(recovered, tokenize(nextTemplate)), tokenize(nextTemplate))
    if (sections.blocks.some(block => !block.deleted && block.pendingSourceText !== undefined)) {
      throw new Error('设定来源已更新，请打开此节点，在「来源与修改记录」中确认保留本节点修改或跟随项目')
    }
    document = serializePromptSectionDocument(sections)
  }
  const promptOverride = document ?? node.settings.prompt_body ?? node.settings.profile_prompt_override
  const parameterConflict = findPromptParameterConflicts(promptOverride || '', { modality: 'image', ratio, resolution, clarity, quality, background, mode })[0]
  if (parameterConflict) throw new Error(parameterConflict.message)
  if (promptOverride !== undefined && !hasVisualBoardPromptContent(stripVisualProfileBaseReference(promptOverride))) throw new Error('请输入设定图内容或本次补充要求')
  const input: { reference_profile_ids: string[]; reference_asset_ids: string[]; prompt_append: string; prompt_override?: string; prompt_document?: boolean; prompt_reference_overrides?: PromptReferenceOverrides } = {
    reference_profile_ids: references.referenceProfileIds, reference_asset_ids: references.referenceAssetIds,
    prompt_append: withVisualProfileBaseReference([...inputTexts, node.text.trim()].filter(Boolean).join('\n\n'),
      promptOverride === undefined ? baseAssetId : null),
    prompt_override: document ?? (promptOverride === undefined ? undefined : withVisualProfileBaseReference(promptOverride, baseAssetId)),
    ...(document !== undefined ? { prompt_document: true } : {}),
    prompt_reference_overrides: node.settings.prompt_reference_overrides }
  if (disconnectedPromptReferenceIds(input.prompt_override ?? input.prompt_append, references.rawAssetIds, input.prompt_reference_overrides).length) {
    throw new Error('提示词中的参考已断开，请重新连接、替换或移除失效引用')
  }
  const preview = await api<VisualBoardPreview>(`/visual-profiles/${profile.id}/board-preview`, json('POST', {
    ...input, model_id: model.id, expected_revision: profile.revision, ratio, resolution, clarity, quality, background,
  }))
  const ratioIssue = imageRatioError(model, resolution || '', ratio, preview.mode)
  if (ratioIssue) throw new Error(ratioIssue)
  const referenceIssue = imageReferenceConfigError(model.settings, preview.reference_asset_ids.length, preview.mode)
  if (referenceIssue) throw new Error(referenceIssue)
  return {
    candidateCount: node.settings.candidate_count || 1, nodeId: node.id, board: { profile, preview, input }, model,
    shot: { title: `${profile.name} · ${profile.variant}` }, referenceNames: preview.reference_names,
    request: { shot_id: '', model_id: model.id, mode: preview.mode,
      project_style_version: preview.project_style_version, project_visual_style: preview.project_visual_style, style_warnings: preview.style_warnings,
      prompt: document === undefined ? withProjectStyle(imagePreferencePrompt(model, preview.prompt, { ratio, resolution, clarity, quality, background }, preview.mode), preview.project_visual_style) : preview.prompt,
      ...(document !== undefined ? { prompt_document: true } : {}),
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
