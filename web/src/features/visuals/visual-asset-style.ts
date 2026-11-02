import type { ProjectDetail } from '../../shared/api/api'
import { isEffectiveVisualStyle, styleReferenceWarning } from '@video-studio/shared/visuals/visual-style'
import { visualJobRequest } from '../canvas/canvas-visual-profiles'

type ReferenceOwner = {
  profile_id: string
  board_asset_id?: string | null
  board_style_version?: string | null
  reference_assets?: Array<{ asset_id: string; style_version?: string | null }>
}

/** Generation provenance remains custom after a human review. A matching
 * confirmed owner and review record determine whether it still needs attention. */
export function visualAssetStyleWarning(detail: Pick<ProjectDetail, 'jobs' | 'visual_profiles' | 'project_visual_style'>,
  assetId: string, index: number, bindings: ReferenceOwner[] = [], profileId?: string): string | null {
  const style = detail.project_visual_style
  const job = detail.jobs.find(item => item.status === 'succeeded' && item.result_asset_id === assetId)
  const request = visualJobRequest(job)
  const effective = isEffectiveVisualStyle(request.effective_visual_style) ? request.effective_visual_style : undefined
  const needsReview = effective && ['custom', 'removed', 'unknown'].includes(effective.origin)
  const reviewed = (ownerId: string) => !needsReview || Array.isArray(request.visual_style_reviews)
    && request.visual_style_reviews.some(review => review && typeof review === 'object'
      && review.profile_id === ownerId && review.style_version === style?.version)
  const profiles = (detail.visual_profiles || []).filter(profile => !profileId || profile.id === profileId)
  if (profiles.some(profile => reviewed(profile.id) && (profile.board_asset_id === assetId
    && profile.board_style_version === style?.version && profile.board_style_status !== 'needs_review'
    || profile.reference_assets?.some(reference => reference.asset_id === assetId && reference.status === 'confirmed'
      && reference.style_version === style?.version)
    || needsReview && profile.candidate_asset_ids?.includes(assetId)))) return null
  if (bindings.some(binding => (!profileId || binding.profile_id === profileId) && reviewed(binding.profile_id)
    && (binding.board_asset_id === assetId && binding.board_style_version === style?.version
      || binding.reference_assets?.some(reference => reference.asset_id === assetId && reference.style_version === style?.version)))) return null
  return styleReferenceWarning(style, request.project_style_version, index, effective)
}
