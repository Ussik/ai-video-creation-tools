export interface AudioMixSettings {
  music_gain: number
  duck_music: boolean
  duck_source: boolean
}

export const defaultAudioMix: AudioMixSettings = { music_gain: 0.24, duck_music: true, duck_source: true }

export interface SpeechPlacement {
  id: string
  project_id: string
  line_id: string
  shot_id: string | null
  asset_id: string
  offset_ms: number
  in_ms: number
  out_ms: number
  gain: number
  text: string
  voice_name: string
  stale: boolean
}

export interface SpeechAudioClip extends SpeechPlacement {
  start_ms: number
  end_ms: number
  fade_in_ms?: number
  fade_out_ms?: number
}

export interface SpeechTimelineIssue { placement_id: string; message: string }

/** Anchor to the shot's edited start, independent of its source-material in point. */
export function resolveSpeechTimeline(
  shots: ReadonlyArray<{ id: string; position: number; duration: number }>,
  clips: ReadonlyArray<{ shot_id: string; in_ms: number; out_ms: number }>,
  placements: ReadonlyArray<SpeechPlacement>,
) {
  const byShot = new Map(clips.map(clip => [clip.shot_id, clip]))
  const starts = new Map<string, number>()
  let duration_ms = 0
  for (const shot of [...shots].sort((a, b) => a.position - b.position)) {
    starts.set(shot.id, duration_ms)
    const clip = byShot.get(shot.id)
    duration_ms += clip ? Math.max(0, clip.out_ms - clip.in_ms) : shot.duration * 1000
  }
  const audio: SpeechAudioClip[] = []
  const issues: SpeechTimelineIssue[] = []
  for (const placement of placements) {
    if (placement.shot_id && !starts.has(placement.shot_id)) continue // Outside this production range.
    const name = placement.voice_name || '配音'
    const start_ms = (starts.get(placement.shot_id || '') ?? 0) + placement.offset_ms
    const end_ms = start_ms + placement.out_ms - placement.in_ms
    let message = ''
    if (!placement.shot_id) message = `${name}的入片镜头已不存在，请重新设置播放位置`
    else if (placement.stale) message = `${name}的入片配音与当前台词或选用版本不一致，请更新配音`
    else if (!Number.isSafeInteger(placement.in_ms) || !Number.isSafeInteger(placement.out_ms) || placement.in_ms < 0 || placement.out_ms <= placement.in_ms || !Number.isSafeInteger(placement.offset_ms)) message = `${name}的音频区间无效`
    else if (!Number.isFinite(placement.gain) || placement.gain < 0 || placement.gain > 2) message = `${name}的配音音量无效`
    else if (start_ms < 0 || end_ms > duration_ms) message = `${name}的配音超出本次成片范围，请调整位置或扩展制作范围`
    if (message) issues.push({ placement_id: placement.id, message })
    audio.push({ ...placement, start_ms, end_ms })
  }
  return { audio, issues, duration_ms, shot_starts: starts }
}

/** The same speech intervals drive browser preview and FFmpeg volume expressions. */
export function speechIntervals(audio: ReadonlyArray<SpeechAudioClip>): Array<[number, number]> {
  const result: Array<[number, number]> = []
  for (const item of [...audio].filter(item => item.gain > 0).sort((a, b) => a.start_ms - b.start_ms)) {
    const previous = result.at(-1)
    if (previous && item.start_ms <= previous[1]) previous[1] = Math.max(previous[1], item.end_ms)
    else result.push([item.start_ms, item.end_ms])
  }
  return result
}

export function speechDuckingLevel(intervals: ReadonlyArray<readonly [number, number]>, timeMs: number): number {
  return intervals.some(([start, end]) => timeMs >= start && timeMs < end) ? 0.25 : 1
}

export function sliceSpeechAudio(audio: ReadonlyArray<SpeechAudioClip>, startMs: number, endMs: number): SpeechAudioClip[] {
  return audio.filter(item => item.start_ms < endMs && item.end_ms > startMs).map(item => {
    const start = Math.max(startMs, item.start_ms), end = Math.min(endMs, item.end_ms)
    return { ...item, start_ms: start - startMs, end_ms: end - startMs,
      in_ms: item.in_ms + start - item.start_ms, out_ms: item.in_ms + end - item.start_ms,
      fade_in_ms: start > item.start_ms ? 0 : item.fade_in_ms ?? Math.min(15, (item.end_ms - item.start_ms) / 2),
      fade_out_ms: end < item.end_ms ? 0 : item.fade_out_ms ?? Math.min(15, (item.end_ms - item.start_ms) / 2) }
  })
}

export interface SpeechVoice { id: string; name: string; speaker: string; instructions: string; speech_rate: number }
export interface SpeechTake {
  id: string; line_id: string; job_id: string | null; asset_id: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null
  text: string; speaker: string; instructions: string; context_text: string; speech_rate: number
  created_at: string; url: string | null; filename: string | null; duration_ms?: number | null
}
export interface SpeechLineDraft { voice_id: string | null; scene_id: string | null; text: string; instructions: string; context_text: string }
export interface SpeechLine extends SpeechLineDraft {
  id: string; project_id: string; position: number; selected_asset_id: string | null
  created_at: string; updated_at: string; takes: SpeechTake[]; selected_is_stale?: boolean
  source_status?: 'current' | 'changed' | 'removed' | 'manual'
}
export interface SpeechData { voices: SpeechVoice[]; lines: SpeechLine[]; placements?: SpeechPlacement[] }

export function isSpeechTakeCurrent(take: Pick<SpeechTake, 'text' | 'speaker' | 'instructions' | 'context_text' | 'speech_rate'>, line: SpeechLineDraft, voice?: SpeechVoice): boolean {
  return !!voice && take.text === line.text && take.speaker === voice.speaker &&
    (take.instructions || '') === [voice.instructions, line.instructions].filter(Boolean).join('\n') &&
    (take.context_text || '') === line.context_text && (take.speech_rate || 0) === voice.speech_rate
}
