import type { Asset, Shot, TimelineClip } from '../api/contracts.js'

type MediaAsset = Pick<Asset, 'id' | 'project_id' | 'shot_id' | 'kind' | 'filename' | 'created_at' | 'deleted_at'>

/** Adjacent accepted shots, scoped to one design. Ordering never depends on UI selection. */
export function adjacentStoryboardShots(shots: readonly Shot[], shot: Shot) {
  const compare = (left: Shot, right: Shot) => left.position - right.position || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const candidates = shots.filter(item => item.id !== shot.id && !item.deleted_at && !item.superseded_by
    && (!item.project_id || !shot.project_id || item.project_id === shot.project_id)
    && (item.design_id || null) === (shot.design_id || null)).sort(compare)
  return { previous: candidates.filter(item => compare(item, shot) < 0).at(-1) || null,
    next: candidates.find(item => compare(item, shot) > 0) || null }
}

/** A selected take and its accepted trim are evidence identities, not observations of its pixels. */
export function storyboardSelectedMedia(shot: Shot, assets: readonly MediaAsset[], clips: readonly TimelineClip[]) {
  const asset = assets.find(item => item.id === shot.selected_asset_id && !item.deleted_at
    && (!item.project_id || !shot.project_id || item.project_id === shot.project_id)
    && (!item.shot_id || item.shot_id === shot.id) && ['image', 'video'].includes(item.kind))
  const candidates = clips.filter(item => item.shot_id === shot.id && (!item.project_id || !shot.project_id || item.project_id === shot.project_id))
  const clip = candidates.length === 1 ? candidates[0] : undefined
  const valid = !!asset && !!clip && clip.asset_id === asset.id && Number.isSafeInteger(clip.in_ms)
    && Number.isSafeInteger(clip.out_ms) && clip.in_ms >= 0 && clip.out_ms - clip.in_ms >= 200
    && (asset.kind === 'image' ? clip.in_ms === 0 : clip.source_duration_ms !== null && clip.out_ms <= clip.source_duration_ms)
  return { selected_asset_id: shot.selected_asset_id || null,
    asset: asset ? { id: asset.id, kind: asset.kind, filename: asset.filename, created_at: asset.created_at } : null,
    clip: clip ? { id: clip.id, asset_id: clip.asset_id, in_ms: clip.in_ms, out_ms: clip.out_ms,
      source_duration_ms: clip.source_duration_ms, source_audio_gain: clip.source_audio_gain, source_audio_fade_ms: clip.source_audio_fade_ms } : null,
    range_status: valid ? 'accepted_trim' as const : candidates.length > 1 ? 'ambiguous' as const : 'unavailable' as const,
    tail_time_ms: valid ? asset.kind === 'image' ? 0 : Math.max(clip.in_ms, clip.out_ms - 50) : null }
}

export function storyboardContinuityContext(shots: readonly Shot[], shot: Shot | null | undefined,
  assets: readonly MediaAsset[], clips: readonly TimelineClip[]) {
  if (!shot) return { current: null, previous: null, next: null }
  const describe = (item: Shot | null) => item ? {
    id: item.id, title: item.title, position: item.position, source_scene_id: item.source_scene_id,
    same_scene: shot.source_scene_id && item.source_scene_id ? shot.source_scene_id === item.source_scene_id : null,
    start_state: item.start_state, end_state: item.end_state, cut_note: item.cut_note,
    image_prompt: item.image_prompt, video_prompt: item.video_prompt, audio_plan: item.audio_plan || null,
    continuity_plan: item.continuity_plan || null, duration: item.duration, storyboard_revision: item.storyboard_revision || 0,
    media: storyboardSelectedMedia(item, assets, clips),
  } : null
  const { previous, next } = adjacentStoryboardShots(shots, shot)
  return { current: describe(shot), previous: describe(previous), next: describe(next) }
}
