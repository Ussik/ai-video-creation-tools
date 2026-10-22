import { resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import type { PromptReferenceOverrides } from '@video-studio/shared/visuals/prompt-references'
import type { Job, ProjectDetail, VisualProfile } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { visualBoardReferences, visualJobRequest } from './canvas-visual-profiles'
import { visualProfileBaseReadiness, visualProfileLabel } from '../visuals/visual-profile-inheritance'

export type CanvasVisualBoardReference = {
  assetId: string
  role: 'base' | 'manual'
  profileId?: string
  nodeId?: string
  label: string
}

export type CanvasVisualBoardReferences = {
  /** The actual submission order, after replacements and deduplication. */
  assetIds: string[]
  rawAssetIds: string[]
  requiredAssetIds: string[]
  referenceProfileIds: string[]
  referenceAssetIds: string[]
  sources: CanvasVisualBoardReference[]
  replacements: PromptReferenceOverrides
  error?: string
}

/** Match prepareBoard: required base, manual profiles, then fixed asset inputs.
 * Automatic display edges and shot bindings do not add inputs to a profile board.
 */
export function resolveCanvasVisualBoardReferences(node: CanvasNode, profile: VisualProfile, graph: CanvasGraph, detail: ProjectDetail): CanvasVisualBoardReferences {
  const result: CanvasVisualBoardReferences = { assetIds: [], rawAssetIds: [], requiredAssetIds: [],
    referenceProfileIds: [], referenceAssetIds: [], sources: [], replacements: {} }
  try {
    const inheritance = visualProfileBaseReadiness(profile, detail)
    if (inheritance.error) throw new Error(inheritance.error)
    const base = inheritance.baseProfile
    if (base?.board_asset_id) result.requiredAssetIds = [base.board_asset_id]
    const manual = visualBoardReferences(graph, node.id, detail)
    result.referenceProfileIds = manual.reference_profile_ids
    result.referenceAssetIds = manual.reference_asset_ids
    const profiles = manual.reference_profile_ids.flatMap(id => detail.visual_profiles?.find(item => item.id === id) || [])
    result.rawAssetIds = [...new Set([...(base?.board_asset_id ? [base.board_asset_id] : []),
      ...profiles.flatMap(item => item.board_asset_id || []), ...manual.reference_asset_ids])]
    const resolved = resolvePromptReferences({ prompt: '', referenceAssetIds: result.rawAssetIds,
      overrides: node.settings.prompt_reference_overrides, requiredAssetIds: result.requiredAssetIds })
    result.assetIds = resolved.referenceAssetIds
    result.replacements = resolved.replacements
    const image = (id: string) => detail.assets.find(asset => asset.id === id && asset.kind === 'image')
    result.sources = result.assetIds.map(assetId => {
      const isBase = base?.board_asset_id === assetId
      // A replacement is an explicit asset choice. Do not present it as the
      // originating profile's current board/version when it is a different image.
      const sourceProfile = isBase ? base : profiles.find(item => item.board_asset_id === assetId)
      const edge = graph.edges.find(item => item.target === node.id && (item.reference_asset_id === assetId ||
        !item.reference_asset_id && !!sourceProfile && graph.nodes.some(source => source.id === item.source && source.settings.visual_profile_id === sourceProfile.id)))
      const sourceNode = graph.nodes.find(item => item.id === edge?.source)
      return { assetId, role: isBase ? 'base' as const : 'manual' as const,
        ...(sourceProfile ? { profileId: sourceProfile.id } : {}), ...(sourceNode ? { nodeId: sourceNode.id } : {}),
        label: sourceProfile ? `${visualProfileLabel(sourceProfile)} · v${sourceProfile.revision}` : image(assetId)?.filename || sourceNode?.title || '参考图片' }
    })
    if (result.assetIds.some(id => !image(id))) throw new Error('参考图片已不存在，请移除或重新选择参考')
    if (inheritance.waitingProfile) throw new Error(`请先生成并确认「${visualProfileLabel(inheritance.waitingProfile)}」的基础图，再生成当前状态`)
  } catch (error) { result.error = error instanceof Error ? error.message : '参考图片无效' }
  return result
}

function savedAssetIds(request: Record<string, unknown>): string[] | undefined {
  const ids = request.reference_asset_ids
  return Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string') ? ids : undefined
}

export type ProfileReferenceSnapshot = { job: Job; assetIds: string[]; baseSignature?: string }

/** The running request is frozen. Names/roles were not saved in older requests,
 * so callers must not label an old asset as today's confirmed profile version.
 */
export function activeProfileReferenceSnapshot(profile: VisualProfile, detail: Pick<ProjectDetail, 'jobs'>): ProfileReferenceSnapshot | undefined {
  for (const job of [...detail.jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (job.status !== 'queued' && job.status !== 'running') continue
    const request = visualJobRequest(job)
    if (request.visual_reference_view || request.visual_profile_id !== profile.id) continue
    const assetIds = savedAssetIds(request)
    if (assetIds) return { job, assetIds, ...(typeof request.visual_base_signature === 'string' ? { baseSignature: request.visual_base_signature } : {}) }
  }
  return undefined
}

export type ProfileCandidateReferenceState = {
  status: 'current' | 'changed' | 'unknown' | 'pending' | 'missing' | 'blocked'
  reasons: Array<'base' | 'images' | 'order'>
  message?: string
  job?: Job
}

/** Compare the displayed image's successful request, never a later node job. */
export function profileCandidateReferenceState(input: {
  profile: VisualProfile
  detail: Pick<ProjectDetail, 'assets' | 'jobs'>
  displayedAssetId?: string | null
  references: CanvasVisualBoardReferences
  generating?: boolean
  currentBaseSignature?: string
}): ProfileCandidateReferenceState {
  const { profile, detail, displayedAssetId, references } = input
  if (input.generating || activeProfileReferenceSnapshot(profile, detail)) return { status: 'pending', reasons: [] }
  if (!displayedAssetId || !detail.assets.some(asset => asset.id === displayedAssetId && asset.kind === 'image')) return { status: 'missing', reasons: [] }
  const job = [...detail.jobs].filter(item => {
    const request = visualJobRequest(item)
    return item.status === 'succeeded' && item.result_asset_id === displayedAssetId && request.visual_profile_id === profile.id && !request.visual_reference_view
  }).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (!job) return { status: 'unknown', reasons: [] }
  if (references.error) return { status: 'blocked', reasons: [], job }
  const request = visualJobRequest(job), previous = savedAssetIds(request)
  if (!previous) return { status: 'unknown', reasons: [], job }
  const reasons: ProfileCandidateReferenceState['reasons'] = []
  const baseChanged = typeof request.visual_base_signature === 'string' && !!input.currentBaseSignature
    ? request.visual_base_signature !== input.currentBaseSignature
    : displayedAssetId === profile.board_asset_id && profile.base_reference_status === 'needs_review'
  if (baseChanged) reasons.push('base')
  if (JSON.stringify(previous) !== JSON.stringify(references.assetIds)) {
    const sameImages = previous.length === references.assetIds.length && previous.every(id => references.assetIds.includes(id))
    reasons.push(sameImages ? 'order' : 'images')
  }
  if (!reasons.length) return { status: 'current', reasons, job }
  const message = reasons.includes('base') ? '当前候选使用的基础版本已更新，可重新生成候选图'
    : reasons.includes('images') ? '当前候选使用的参考图片与当前选择不同，可重新生成候选图'
      : '当前候选的参考图顺序与当前选择不同，可重新生成候选图'
  return { status: 'changed', reasons, message, job }
}
