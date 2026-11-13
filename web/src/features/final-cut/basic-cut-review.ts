import type { EditingCut } from '@video-studio/shared/media/editing-cut'
import { sliceSpeechAudio } from '@video-studio/shared/media/speech-timeline'
import type { Asset } from '../../shared/api/api'
import { editingCutPreview } from './editing-cut-preview'

/** Bind a manual review to the exact picture order, source versions and mix. */
export function basicCutReviewSignature(cut: EditingCut, fromId: string, toId: string, assets: Asset[]): string {
  const used = new Set([...cut.clips.map(item => item.asset_id), ...cut.speech.map(item => item.asset_id), cut.music_asset_id])
  return JSON.stringify({ cut: cut.id, fromId, toId, ratio: cut.ratio, clips: cut.clips, speech: cut.speech,
    music: cut.music_asset_id, mix: cut.audio_settings, captions: cut.captions,
    media: assets.filter(asset => used.has(asset.id)).map(asset => [asset.id, asset.url, asset.created_at]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) })
}

export function basicCutReviewCandidate(cut: EditingCut, index: number, fromOut: number, toIn: number, assets: Asset[], durations: ReadonlyMap<string, number>) {
  const from = cut.clips[index], to = cut.clips[index + 1]
  const fromAsset = assets.find(asset => asset.id === from?.asset_id), toAsset = assets.find(asset => asset.id === to?.asset_id)
  const fromMax = durations.get(from?.asset_id) ?? from?.out_ms ?? 0
  const valid = !!from && !!to && !!fromAsset?.url && !!toAsset?.url && ['image', 'video'].includes(fromAsset.kind) && ['image', 'video'].includes(toAsset.kind)
    && Number.isSafeInteger(fromOut) && Number.isSafeInteger(toIn) && fromOut - from.in_ms >= 200 && to.out_ms - toIn >= 200
    && fromOut <= fromMax && toIn >= 0 && (fromAsset.kind !== 'image' || fromOut === from.out_ms)
    && (toAsset.kind !== 'image' || toIn === 0)
  if (!valid) return null
  const proposed = { ...cut, clips: cut.clips.map((clip, i) => i === index ? { ...clip, out_ms: fromOut } : i === index + 1 ? { ...clip, in_ms: toIn } : clip) }
  const timeline = editingCutPreview(proposed, assets, durations)
  const beforeMs = proposed.clips.slice(0, index).reduce((sum, clip) => sum + clip.out_ms - clip.in_ms, 0)
  const fromLength = fromOut - from.in_ms, toLength = to.out_ms - toIn
  const startMs = beforeMs + Math.max(0, fromLength - 1200), endMs = beforeMs + fromLength + Math.min(1200, toLength)
  const originalClips = timeline.clips.slice(index, index + 2)
  const clips = originalClips.map((clip, i) => {
    return { ...clip, in_ms: i === 0 ? Math.max(clip.in_ms, clip.out_ms - 1200) : clip.in_ms,
      out_ms: i === 1 ? Math.min(clip.out_ms, clip.in_ms + 1200) : clip.out_ms,
      // Cropping a review window must not add fades absent from the real edit.
      source_audio_envelope_in_ms: clip.in_ms, source_audio_envelope_out_ms: clip.out_ms }
  })
  return { proposed, clips, shots: timeline.shots.slice(index, index + 2), speechAudio: sliceSpeechAudio(timeline.speechAudio, startMs, endMs),
    musicOffsetMs: startMs, captions: cut.captions.filter(item => item.start_ms < endMs && item.end_ms > startMs)
      .map(item => ({ ...item, start_ms: Math.max(startMs, item.start_ms) - startMs, end_ms: Math.min(endMs, item.end_ms) - startMs })),
    fromFrameMs: Math.max(from.in_ms, fromOut - 42), toFrameMs: toIn, deltaMs: fromOut - from.out_ms - (toIn - to.in_ms) }
}
