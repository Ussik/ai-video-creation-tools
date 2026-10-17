import { sliceSpeechAudio, type SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'
import type { Asset, AssetReview, Shot, TimelineClip } from '../../shared/api/api'

interface PartialTimelinePreviewInput {
  shots: ReadonlyArray<Shot>
  clips: ReadonlyArray<TimelineClip>
  assets: ReadonlyArray<Asset>
  assetReviews: ReadonlyArray<AssetReview>
  speechAudio?: ReadonlyArray<SpeechAudioClip>
}

export interface PartialTimelinePreview {
  shots: Shot[]
  clips: TimelineClip[]
  missingShots: Shot[]
  audio: SpeechAudioClip[]
  durationMs: number
  complete: boolean
}

interface RetainedInterval { startMs: number; endMs: number; previewStartMs: number }

/** Build a disposable preview without changing the production range or its audio placements. */
export function buildPartialTimelinePreview({ shots, clips, assets, assetReviews, speechAudio = [] }: PartialTimelinePreviewInput): PartialTimelinePreview {
  const orderedShots = [...new Map(shots.map(shot => [shot.id, shot])).values()].sort((a, b) => a.position - b.position)
  // Keep the same last-clip-per-shot interpretation as resolveSpeechTimeline.
  const clipByShot = new Map(clips.map(clip => [clip.shot_id, clip]))
  const assetById = new Map(assets.map(asset => [asset.id, asset]))
  const rejected = new Map<string, Set<string>>()
  for (const review of assetReviews) {
    if (review.status !== 'rejected') continue
    const assetIds = rejected.get(review.shot_id) ?? new Set<string>()
    assetIds.add(review.asset_id)
    rejected.set(review.shot_id, assetIds)
  }
  const result: PartialTimelinePreview = { shots: [], clips: [], missingShots: [], audio: [], durationMs: 0, complete: false }
  const intervals: RetainedInterval[] = []
  const clipIds = new Set<string>()
  let originalStartMs = 0

  for (const shot of orderedShots) {
    const clip = clipByShot.get(shot.id)
    const asset = clip ? assetById.get(clip.asset_id) : undefined
    const clipDuration = clip ? clip.out_ms - clip.in_ms : 0
    const usable = !!clip && !!asset && !!shot.selected_asset_id && clip.asset_id === shot.selected_asset_id &&
      clip.project_id === shot.project_id && asset.project_id === shot.project_id &&
      !!asset.url?.trim() && !rejected.get(shot.id)?.has(asset.id) && !clipIds.has(clip.id) &&
      (asset.kind === 'image' || asset.kind === 'video') &&
      Number.isFinite(clip.in_ms) && Number.isFinite(clip.out_ms) && clip.in_ms >= 0 && clipDuration >= 200 &&
      (clip.source_duration_ms === null || Number.isFinite(clip.source_duration_ms) && clip.out_ms <= clip.source_duration_ms) &&
      (asset.kind === 'image' ? clip.in_ms === 0 && clip.out_ms <= 30000 : clip.source_duration_ms !== null)

    if (usable) {
      result.shots.push(shot)
      result.clips.push(clip)
      clipIds.add(clip.id)
      const previous = intervals.at(-1)
      if (previous && previous.endMs === originalStartMs) previous.endMs += clipDuration
      else intervals.push({ startMs: originalStartMs, endMs: originalStartMs + clipDuration, previewStartMs: result.durationMs })
      result.durationMs += clipDuration
    } else result.missingShots.push(shot)

    // speechAudio was resolved on this original timeline. Even a rejected clip still
    // occupies its edited duration there; only absent clips use the planned duration.
    const plannedDuration = Number.isFinite(shot.duration) ? Math.max(0, shot.duration * 1000) : 0
    originalStartMs += clip && Number.isFinite(clipDuration) ? Math.max(0, clipDuration) : plannedDuration
  }

  result.complete = orderedShots.length > 0 && result.missingShots.length === 0
  if (result.complete) result.audio = speechAudio.map(item => ({ ...item }))
  else result.audio = intervals.flatMap((interval, intervalIndex) =>
    sliceSpeechAudio(speechAudio, interval.startMs, interval.endMs).map((item, audioIndex) => ({
      ...item,
      // A line spanning a removed gap becomes multiple media elements. Each keeps
      // its corresponding source in/out points and needs its own playback ref.
      id: `${item.id}:preview:${intervalIndex}:${audioIndex}`,
      start_ms: item.start_ms + interval.previewStartMs,
      end_ms: item.end_ms + interval.previewStartMs,
    })))
  return result
}
