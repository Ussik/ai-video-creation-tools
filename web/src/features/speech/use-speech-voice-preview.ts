import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechStandardVoice } from '@video-studio/shared/media/speech-voices'

type PreviewState = { key: string | null; speaker: string | null; status: 'idle' | 'loading' | 'playing' | 'error'; error: string }
const idle: PreviewState = { key: null, speaker: null, status: 'idle', error: '' }

/** One official sample at a time, independent of saved roles and paid synthesis. */
export function useSpeechVoicePreview(enabled: boolean) {
  const [state, setState] = useState<PreviewState>(idle)
  const active = useRef<{ audio: HTMLAudioElement; key: string; speaker: string } | null>(null)
  const dispose = useCallback(() => {
    const audio = active.current?.audio
    active.current = null
    if (!audio) return
    audio.onplaying = audio.onwaiting = audio.onended = audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }, [])
  const stop = useCallback(() => { dispose(); setState(idle) }, [dispose])
  useEffect(() => { if (!enabled) stop(); return dispose }, [enabled, dispose, stop])

  const toggle = useCallback((key: string, voice: SpeechStandardVoice) => {
    if (!enabled) return
    if (active.current?.key === key && active.current.speaker === voice.speaker) { stop(); return }
    dispose()
    const audio = new Audio()
    active.current = { audio, key, speaker: voice.speaker }
    const current = () => active.current?.audio === audio
    const update = (status: PreviewState['status']) => { if (current()) setState({ key, speaker: voice.speaker, status, error: '' }) }
    const fail = () => {
      if (!current()) return
      dispose()
      setState({ key, speaker: voice.speaker, status: 'error', error: '官方样音暂时无法播放，请检查网络后重试。' })
    }
    audio.onplaying = () => update('playing')
    audio.onwaiting = () => update('loading')
    audio.onended = () => { if (current()) stop() }
    audio.onerror = fail
    audio.preload = 'none'
    audio.src = voice.sample_url
    update('loading')
    try { void audio.play().then(() => update('playing')).catch(fail) } catch { fail() }
  }, [enabled, dispose, stop])
  return { ...state, toggle, stop }
}
export type SpeechVoicePreview = ReturnType<typeof useSpeechVoicePreview>
