import type { AudioMixSettings } from './speech-timeline.js'

/** One use of a visual asset. Array order defines the cut; assets may repeat. */
export interface EditingCutClip {
  id: string
  asset_id: string
  title: string
  in_ms: number
  out_ms: number
  source_audio_gain: number
  source_audio_fade_ms: number
}

/** Independent audio reference; replacing it never changes a speech-line selection. */
export interface EditingCutSpeech {
  id: string
  asset_id: string
  label: string
  start_ms: number
  in_ms: number
  out_ms: number
  gain: number
}

export interface EditingCutCaption {
  id: string
  start_ms: number
  end_ms: number
  text: string
}

export interface EditingCutInput {
  name: string
  source_canvas_id: string | null
  revision: number
  ratio: '16:9' | '9:16'
  clips: EditingCutClip[]
  speech: EditingCutSpeech[]
  music_asset_id: string | null
  audio_settings: AudioMixSettings
  captions: EditingCutCaption[]
}

export interface EditingCut extends EditingCutInput {
  id: string
  project_id: string
  created_at: string
  updated_at: string
}

export function editingCutDurationMs(cut: Pick<EditingCutInput, 'clips'>): number {
  return cut.clips.reduce((sum, clip) => sum + Math.max(0, clip.out_ms - clip.in_ms), 0)
}

/** Keep the same readable caption line breaks in the player and rendered file. */
export function wrapEditingCutCaption(text: string, ratio: EditingCutInput['ratio']): string {
  const maxWidth = ratio === '9:16' ? 8 : 27
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\t/g, '  ')
  return clean.split('\n').map(paragraph => {
    const lines: string[] = []
    let line = '', width = 0
    for (const character of paragraph) {
      const nextWidth = /^[\x20-\x7e]$/.test(character) ? 0.55 : 1
      if (line && width + nextWidth > maxWidth) {
        lines.push(line.trimEnd())
        line = ''
        width = 0
      }
      line += character
      width += nextWidth
    }
    lines.push(line.trimEnd())
    return lines.join('\n')
  }).join('\n')
}
