import type { VideoContinuityReview } from '@video-studio/shared/media/video-continuity-review'
import { storyboardContinuityContext } from '@video-studio/shared/storyboard/storyboard-media-context'
import type { ProjectDetail } from '../../shared/api/api'
import type { GenerationRequest } from './ProjectCanvas'
import { allProjectShots } from './canvas-design-scope'
import { imageVideoContentSignature } from './canvas-image-video-context'

export interface CanvasContinuityResult { report: VideoContinuityReview; acknowledged: boolean }

export function canvasContinuitySource(detail: ProjectDetail, request: GenerationRequest, modifyAudio = false) {
  const shots = allProjectShots(detail), shot = shots.find(item => item.id === request.shot_id)
  const context = storyboardContinuityContext(shots, shot, detail.assets, detail.timeline_clips || [])
  const storyboardId = request.storyboard_reference_asset_id
    || (['first_frame', 'first_last_frame'].includes(request.mode) ? request.reference_asset_ids[0] : null) || null
  const storyboard = detail.assets.find(item => item.id === storyboardId)
  return { context, storyboardId, signature: imageVideoContentSignature({ project: detail.id,
    prompt: request.prompt, duration: request.duration, mode: request.mode, target: request.model_id, generateAudio: request.generate_audio,
    modifyAudio, referenceIds: request.reference_asset_ids, referenceVideo: request.reference_video_url,
    context, storyboard: storyboard ? { id: storyboard.id, prompt: storyboard.prompt, url: storyboard.url, created_at: storyboard.created_at } : null }) }
}

export function canvasContinuityBlocks(result: CanvasContinuityResult | undefined, signature: string) {
  return !!result && result.report.source_signature === signature && !result.acknowledged
    && result.report.findings.some(item => item.severity === 'error')
}
