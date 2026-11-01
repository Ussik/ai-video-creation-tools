import { wrapEditingCutCaption, type EditingCut, type EditingCutInput } from '@video-studio/shared/media/editing-cut'
import type { SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'
import type { Asset, Shot, TimelineClip } from '../../shared/api/api'

export function editingCutInput(cut: EditingCut): EditingCutInput {
  const { name, source_canvas_id, revision, ratio, clips, speech, music_asset_id, audio_settings, captions } = cut
  return { name, source_canvas_id, revision, ratio, clips, speech, music_asset_id, audio_settings, captions }
}

export function editingCutPreview(cut: EditingCut, assets: Asset[], durations: ReadonlyMap<string, number> = new Map()) {
  const shots: Shot[] = cut.clips.map((clip, position) => ({ id: clip.id, project_id: cut.project_id, position,
    title: clip.title, prompt: '', duration: (clip.out_ms - clip.in_ms) / 1000, selected_asset_id: clip.asset_id,
    source_scene_id: null, start_state: '', end_state: '', cut_note: '' }))
  const clips: TimelineClip[] = cut.clips.map(clip => ({ ...clip, project_id: cut.project_id, shot_id: clip.id,
    source_duration_ms: assets.find(asset => asset.id === clip.asset_id)?.kind === 'image' ? null : durations.get(clip.asset_id) ?? null }))
  const speechAudio: SpeechAudioClip[] = cut.speech.map(audio => ({ ...audio, project_id: cut.project_id,
    line_id: audio.id, shot_id: null, offset_ms: audio.start_ms, end_ms: audio.start_ms + audio.out_ms - audio.in_ms,
    text: audio.label, voice_name: audio.label || '配音', stale: false }))
  return { shots, clips, speechAudio }
}

/** Drafts may put audio/subtitles beyond the picture; export must resolve that. */
export function editingCutIssues(cut: EditingCut, assets: Asset[], durations: ReadonlyMap<string, number>, exporting = false): string[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const issues: string[] = []
  const duration = cut.clips.reduce((total, clip) => total + Math.max(0, clip.out_ms - clip.in_ms), 0)
  if (!cut.name.trim()) issues.push('请为剪辑命名')
  if (exporting && !cut.clips.length) issues.push('先添加至少一个画面片段')
  for (const [i, clip] of cut.clips.entries()) {
    const asset = byId.get(clip.asset_id)
    if (!asset || !['video', 'image'].includes(asset.kind)) issues.push(`片段 ${i + 1} 的画面素材已不可用`)
    else if (clip.in_ms < 0 || clip.out_ms <= clip.in_ms || clip.out_ms - clip.in_ms < 200) issues.push(`片段 ${i + 1} 需保留至少 0.2 秒`)
    else if (asset.kind === 'image' && clip.in_ms !== 0) issues.push(`静帧 ${i + 1} 的入点需为 0`)
    else if (durations.has(asset.id) && clip.out_ms > durations.get(asset.id)!) issues.push(`片段 ${i + 1} 的出点超过原素材时长`)
    if (!Number.isFinite(clip.source_audio_gain) || clip.source_audio_gain < 0 || clip.source_audio_gain > 2 ||
      !Number.isSafeInteger(clip.source_audio_fade_ms) || clip.source_audio_fade_ms < 0 || clip.source_audio_fade_ms > 500) issues.push(`片段 ${i + 1} 的原声音量或淡变无效`)
  }
  for (const [i, audio] of cut.speech.entries()) {
    if (byId.get(audio.asset_id)?.kind !== 'audio') issues.push(`配音 ${i + 1} 的音频素材已不可用`)
    else if (audio.start_ms < 0 || audio.in_ms < 0 || audio.out_ms <= audio.in_ms) issues.push(`配音 ${i + 1} 的播放位置或取段无效`)
    else if (durations.has(audio.asset_id) && audio.out_ms > durations.get(audio.asset_id)!) issues.push(`配音 ${i + 1} 的出点超过音频时长`)
    else if (exporting && audio.start_ms + audio.out_ms - audio.in_ms > duration) issues.push(`配音 ${i + 1} 超出成片，请调整位置或取段`)
    if (!Number.isFinite(audio.gain) || audio.gain < 0 || audio.gain > 2) issues.push(`配音 ${i + 1} 的音量需为 0–200%`)
  }
  for (const [i, caption] of cut.captions.entries()) {
    if (!caption.text.trim() || caption.start_ms < 0 || caption.end_ms <= caption.start_ms) issues.push(`字幕 ${i + 1} 需有正文和有效时间`)
    else if (exporting && caption.end_ms > duration) issues.push(`字幕 ${i + 1} 超出成片，请调整时间`)
    else if (exporting && wrapEditingCutCaption(caption.text, cut.ratio).split('\n').length > 4) issues.push(`字幕 ${i + 1} 超过 4 行，请拆成多条字幕`)
  }
  if (cut.music_asset_id && byId.get(cut.music_asset_id)?.kind !== 'audio') issues.push('背景配乐素材已不可用')
  if (!Number.isFinite(cut.audio_settings.music_gain) || cut.audio_settings.music_gain < 0 || cut.audio_settings.music_gain > 1) issues.push('配乐音量需为 0–100%')
  return issues
}

export function editingCutExportId(request: string): string | null {
  try { const data = JSON.parse(request); return typeof data.editing_cut_id === 'string' ? data.editing_cut_id : null }
  catch { return null }
}

export function editingCutExportRevision(request: string): number | null {
  try {
    const revision: unknown = JSON.parse(request).editing_cut_revision
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : null
  } catch { return null }
}
