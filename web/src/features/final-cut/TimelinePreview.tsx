import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { Film, Pause, Play, RotateCcw } from 'lucide-react'
import type { Asset, Shot } from '../../shared/api/api'
import './timeline-preview.css'

export interface TimelineClip {
  id: string
  project_id: string
  shot_id: string
  asset_id: string
  in_ms: number
  out_ms: number
  source_duration_ms: number | null
  source_audio_gain: number
  source_audio_fade_ms: number
}

interface TimelinePreviewProps {
  clips: TimelineClip[]
  assets: Asset[]
  shots: Shot[]
  ratio: '16:9' | '9:16'
  musicAsset?: Asset | null
}

interface PreviewClip {
  clip: TimelineClip
  asset: Asset
  shot: Shot
  key: string
  durationMs: number
}

interface Cursor {
  index: number
  offsetMs: number
  playing: boolean
}

const initialCursor: Cursor = { index: 0, offsetMs: 0, playing: false }

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const fraction = Math.floor((Math.max(0, ms) % 1000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${fraction}`
}

function sourceAudioLevel(clip: PreviewClip, offsetMs: number): number {
  const fadeMs = Math.min(clip.clip.source_audio_fade_ms, clip.durationMs / 2)
  const fadeLevel = fadeMs > 0
    ? Math.min(1, offsetMs / fadeMs, (clip.durationMs - offsetMs) / fadeMs)
    : 1
  return clip.clip.source_audio_gain * Math.max(0, fadeLevel)
}

export default function TimelinePreview({ clips, assets, shots, ratio, musicAsset }: TimelinePreviewProps) {
  const orderedShots = useMemo(() => [...shots].sort((a, b) => a.position - b.position), [shots])
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const shotById = useMemo(() => new Map(shots.map((shot) => [shot.id, shot])), [shots])
  const orderedClips = useMemo(() => [...clips].sort((a, b) => {
    const position = (shotById.get(a.shot_id)?.position ?? Infinity) - (shotById.get(b.shot_id)?.position ?? Infinity)
    return position || clips.indexOf(a) - clips.indexOf(b)
  }), [clips, shotById])

  const resolved = useMemo(() => orderedClips.flatMap((clip): PreviewClip[] => {
    const asset = assetById.get(clip.asset_id)
    const shot = shotById.get(clip.shot_id)
    if (!asset || !shot || !asset.url || (asset.kind !== 'video' && asset.kind !== 'image')) return []
    if (!Number.isFinite(clip.in_ms) || !Number.isFinite(clip.out_ms) || clip.in_ms < 0 || clip.out_ms <= clip.in_ms) return []
    if (clip.source_duration_ms !== null && clip.out_ms > clip.source_duration_ms + 100) return []
    return [{
      clip, asset, shot,
      key: `${clip.id}:${clip.asset_id}:${clip.in_ms}:${clip.out_ms}:${asset.url}`,
      durationMs: clip.out_ms - clip.in_ms,
    }]
  }), [orderedClips, assetById, shotById])

  const coveredShots = new Set(resolved.map(({ shot }) => shot.id))
  const missingShots = orderedShots.filter((shot) => !coveredShots.has(shot.id))
  const incomplete = orderedShots.length === 0 || missingShots.length > 0 || resolved.length !== clips.length
  const totalMs = resolved.reduce((sum, item) => sum + item.durationMs, 0)
  const signature = resolved.map((item) => item.key).join('|')
  const audioSignature = resolved.map((item) => `${item.key}:${item.clip.source_audio_gain}:${item.clip.source_audio_fade_ms}`).join('|')
  const musicKey = musicAsset?.kind === 'audio' && musicAsset.url
    ? `${musicAsset.id}:${musicAsset.url}`
    : ''
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const cursorRef = useRef(cursor)
  const [readyKeys, setReadyKeys] = useState<Set<string>>(() => new Set())
  const [mediaError, setMediaError] = useState<string | null>(null)
  const videoRefs = useRef(new Map<string, HTMLVideoElement>())
  const audioContextRef = useRef<AudioContext | null>(null)
  const videoGainRefs = useRef(new WeakMap<HTMLVideoElement, GainNode>())
  const musicRef = useRef<HTMLAudioElement | null>(null)
  const previousSignature = useRef(signature)
  const lastUiUpdate = useRef(0)

  function commit(next: Cursor) {
    cursorRef.current = next
    setCursor(next)
  }

  useEffect(() => {
    if (previousSignature.current === `${signature}:${musicKey}`) return
    previousSignature.current = `${signature}:${musicKey}`
    videoRefs.current.forEach((video) => video.pause())
    musicRef.current?.pause()
    if (musicRef.current) musicRef.current.currentTime = 0
    setReadyKeys((previous) => new Set([...previous].filter((key) => resolved.some((item) => item.key === key))))
    setMediaError(null)
    commit(initialCursor)
  }, [signature, musicKey])

  useEffect(() => () => {
    videoRefs.current.forEach((video) => video.pause())
    musicRef.current?.pause()
    void audioContextRef.current?.close().catch(() => {})
  }, [])

  const current = resolved[cursor.index]
  const next = resolved[cursor.index + 1]
  const currentReady = !!current && readyKeys.has(current.key)
  const absoluteMs = resolved.slice(0, cursor.index).reduce((sum, item) => sum + item.durationMs, 0) + cursor.offsetMs

  function ensureVideoGain(video: HTMLVideoElement): GainNode | null {
    const existing = videoGainRefs.current.get(video)
    if (existing) return existing
    const context = audioContextRef.current
    if (!context || context.state !== 'running') return null
    try {
      const gain = context.createGain()
      context.createMediaElementSource(video).connect(gain).connect(context.destination)
      videoGainRefs.current.set(video, gain)
      return gain
    } catch {
      return null
    }
  }

  function syncSourceAudio(item: PreviewClip, offsetMs: number) {
    if (item.asset.kind !== 'video') return
    const video = videoRefs.current.get(item.key)
    if (!video) return
    const level = sourceAudioLevel(item, offsetMs)
    const gain = videoGainRefs.current.get(video) ?? (level > 1 ? ensureVideoGain(video) : null)
    video.muted = false
    if (gain) {
      video.volume = 1
      gain.gain.value = level
    } else {
      video.volume = Math.min(1, level)
    }
  }

  function resumeSourceAudio() {
    if (!resolved.some((item) => item.asset.kind === 'video' && item.clip.source_audio_gain > 1) ||
        typeof AudioContext === 'undefined') return
    try {
      const context = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = context
      void context.resume().then(() => {
        if (context.state !== 'running') return
        const item = resolved[cursorRef.current.index]
        if (item) syncSourceAudio(item, cursorRef.current.offsetMs)
      }).catch(() => {
        // Keep normal media-element playback available if the browser blocks Web Audio.
      })
    } catch {
      // Normal 0–100% playback remains usable without an AudioContext.
    }
  }

  function syncMusicToTimeline(offsetMs: number) {
    const music = musicRef.current
    if (!music || !musicKey) return
    const timelineSeconds = Math.max(0, Math.min(totalMs, offsetMs)) / 1000
    const loopDuration = Number.isFinite(music.duration) && music.duration > 0 ? music.duration : 0
    const targetSeconds = loopDuration > 0 ? timelineSeconds % loopDuration : timelineSeconds
    try {
      if (Math.abs(music.currentTime - targetSeconds) > 0.12) music.currentTime = targetSeconds
    } catch {
      // Browsers can reject a seek before the audio metadata is available.
    }
  }

  function startMusic(offsetMs: number) {
    const music = musicRef.current
    if (!music || !musicKey) return
    music.volume = 0.24
    syncMusicToTimeline(offsetMs)
    void music.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      // The video preview remains usable if a browser delays audio startup;
      // the media error handler reports an actual broken audio source.
    })
  }

  function pauseMusic() {
    musicRef.current?.pause()
  }

  useEffect(() => {
    const music = musicRef.current
    if (!music || !musicKey) return
    if (incomplete || mediaError || !cursor.playing || !current || !currentReady) {
      pauseMusic()
      return
    }
    startMusic(absoluteMs)
  }, [cursor.index, cursor.playing, currentReady, incomplete, mediaError, signature, musicKey])

  useEffect(() => {
    if (!current || current.asset.kind !== 'video') return
    const video = videoRefs.current.get(current.key)
    if (!video || incomplete || mediaError || !cursor.playing || cursor.offsetMs >= current.durationMs - 20) {
      video?.pause()
      return
    }
    if (!currentReady) return
    syncSourceAudio(current, cursorRef.current.offsetMs)
    resumeSourceAudio()
    void video.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (cursorRef.current.index !== cursor.index || !cursorRef.current.playing) return
      commit({ ...cursorRef.current, playing: false })
      setMediaError('浏览器无法播放当前素材，请检查视频格式或素材地址。')
    })
    return () => video.pause()
  }, [cursor.index, cursor.playing, currentReady, incomplete, mediaError, signature])

  useEffect(() => {
    if (current) syncSourceAudio(current, cursorRef.current.offsetMs)
  }, [cursor.index, audioSignature])

  useEffect(() => {
    if (!cursor.playing || incomplete || mediaError) return
    let frame = 0
    const start = performance.now()
    const startOffset = cursorRef.current.offsetMs

    const tick = (now: number) => {
      const live = cursorRef.current
      const item = resolved[live.index]
      if (!live.playing || !item) return
      if (!readyKeys.has(item.key)) {
        frame = requestAnimationFrame(tick)
        return
      }

      const video = item.asset.kind === 'video' ? videoRefs.current.get(item.key) : undefined
      const offset = video
        ? Math.max(0, Math.min(item.durationMs, video.currentTime * 1000 - item.clip.in_ms))
        : Math.max(0, Math.min(item.durationMs, startOffset + now - start))
      if (video) syncSourceAudio(item, offset)

      if (offset >= item.durationMs - 20) {
        video?.pause()
        const following = resolved[live.index + 1]
        if (!following || readyKeys.has(following.key)) {
          commit(following
            ? { index: live.index + 1, offsetMs: 0, playing: true }
            : { index: live.index, offsetMs: item.durationMs, playing: false })
          return
        }
        if (live.offsetMs !== item.durationMs) commit({ ...live, offsetMs: item.durationMs })
      } else if (now - lastUiUpdate.current > 70) {
        lastUiUpdate.current = now
        commit({ ...live, offsetMs: offset })
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [cursor.index, cursor.playing, readyKeys, incomplete, mediaError, signature, audioSignature])

  function markReady(key: string) {
    setReadyKeys((previous) => previous.has(key) ? previous : new Set(previous).add(key))
  }

  function handleVideoMetadata(item: PreviewClip, video: HTMLVideoElement) {
    if (Number.isFinite(video.duration) && item.clip.out_ms > video.duration * 1000 + 100) {
      setMediaError(`“${item.shot.title}”的素材短于时间线出点，请调整片段范围。`)
      commit({ ...cursorRef.current, playing: false })
      return
    }
    video.currentTime = item.clip.in_ms / 1000
    if (item.clip.in_ms === 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) markReady(item.key)
  }

  function handleVideoReady(item: PreviewClip, video: HTMLVideoElement) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        Math.abs(video.currentTime * 1000 - item.clip.in_ms) <= 100) markReady(item.key)
  }

  function handlePlayPause() {
    if (incomplete || mediaError || !current) return
    if (cursor.playing) {
      pauseMusic()
      commit({ ...cursorRef.current, playing: false })
      return
    }
    if (cursor.index === resolved.length - 1 && cursor.offsetMs >= current.durationMs - 20) {
      restart()
      return
    }
    const video = current.asset.kind === 'video' ? videoRefs.current.get(current.key) : undefined
    if (video) {
      syncSourceAudio(current, cursor.offsetMs)
      resumeSourceAudio()
    }
    if (video) void video.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (cursorRef.current.index !== cursor.index || !cursorRef.current.playing) return
      commit({ ...cursorRef.current, playing: false })
      setMediaError('浏览器无法播放当前素材。')
    })
    startMusic(absoluteMs)
    commit({ ...cursorRef.current, playing: true })
  }

  function restart() {
    if (incomplete || mediaError || !resolved.length) return
    videoRefs.current.forEach((video) => video.pause())
    pauseMusic()
    syncMusicToTimeline(0)
    const first = resolved[0]
    const mounted = videoRefs.current.get(first.key)
    if (mounted) {
      syncSourceAudio(first, 0)
      resumeSourceAudio()
      setReadyKeys((previous) => {
        const updated = new Set(previous)
        updated.delete(first.key)
        return updated
      })
      mounted.currentTime = first.clip.in_ms / 1000
      if (mounted.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          Math.abs(mounted.currentTime * 1000 - first.clip.in_ms) <= 100) markReady(first.key)
    }
    commit({ index: 0, offsetMs: 0, playing: true })
    if (readyKeys.has(first.key)) startMusic(0)
  }

  const visibleItems = [current, next].filter((item): item is PreviewClip => !!item)

  return <section className="timeline-preview" aria-label="成片连续预览">
    <div className={`timeline-preview-stage ${ratio === '9:16' ? 'is-portrait' : ''}`}>
      {!incomplete && visibleItems.map((item) => item.asset.kind === 'video'
        ? <video
          key={item.key}
          ref={(node) => { if (node) videoRefs.current.set(item.key, node); else videoRefs.current.delete(item.key) }}
          className={`timeline-preview-media ${current?.key === item.key ? 'is-active' : ''}`}
          src={item.asset.url}
          preload="auto"
          playsInline
          onLoadedMetadata={(event) => handleVideoMetadata(item, event.currentTarget)}
          onCanPlay={(event) => handleVideoReady(item, event.currentTarget)}
          onSeeked={(event) => handleVideoReady(item, event.currentTarget)}
          onError={() => { setMediaError(`“${item.shot.title}”的素材无法加载。`); commit({ ...cursorRef.current, playing: false }) }}
        />
        : <img
          key={item.key}
          className={`timeline-preview-media ${current?.key === item.key ? 'is-active' : ''}`}
          src={item.asset.url}
          alt={item.shot.title}
          onLoad={() => markReady(item.key)}
          onError={() => { setMediaError(`“${item.shot.title}”的图片无法加载。`); commit({ ...cursorRef.current, playing: false }) }}
        />)}
      {incomplete && <div className="timeline-preview-message"><Film size={30} strokeWidth={1.5} /><strong>时间线尚未完整</strong><span>{orderedShots.length === 0 ? '请先创建分镜。' : `${missingShots.length} 个分镜缺少有效片段，请补齐后预览整片。`}</span></div>}
      {!incomplete && !mediaError && !currentReady && <div className="timeline-preview-message"><span>正在准备画面…</span></div>}
      {!incomplete && mediaError && <div className="timeline-preview-message is-error"><strong>无法继续预览</strong><span>{mediaError}</span></div>}
    </div>
    {musicKey && <audio
      ref={musicRef}
      hidden
      src={musicAsset?.url}
      preload="auto"
      loop
      onLoadedMetadata={() => {
        if (musicRef.current) musicRef.current.volume = 0.24
        if (cursorRef.current.playing && currentReady && !incomplete && !mediaError) startMusic(absoluteMs)
      }}
      onError={() => { setMediaError('项目配乐无法加载，请检查音频素材。'); pauseMusic(); commit({ ...cursorRef.current, playing: false }) }}
    />}
    <div className="timeline-preview-transport">
      <div className="timeline-preview-buttons">
        <Tooltip label={cursor.playing ? '暂停预览' : '播放预览'}><ActionIcon variant="default" size="lg" aria-label={cursor.playing ? '暂停预览' : '播放预览'} disabled={incomplete || !!mediaError} onClick={handlePlayPause}>{cursor.playing ? <Pause size={18} /> : <Play size={18} />}</ActionIcon></Tooltip>
        <Tooltip label="从头播放"><ActionIcon variant="subtle" size="lg" aria-label="从头播放" disabled={incomplete || !!mediaError} onClick={restart}><RotateCcw size={17} /></ActionIcon></Tooltip>
      </div>
      <span className="timeline-preview-clock" aria-live="off">{formatTime(incomplete ? 0 : absoluteMs)} / {formatTime(incomplete ? 0 : totalMs)}</span>
      <span className="timeline-preview-shot" title={current?.shot.title}>{incomplete ? '等待完整时间线' : current ? `${String(cursor.index + 1).padStart(2, '0')} · ${current.shot.title}` : ''}</span>
    </div>
    <div className="timeline-preview-progress" role="progressbar" aria-label="预览进度" aria-valuemin={0} aria-valuemax={incomplete ? 0 : totalMs} aria-valuenow={incomplete ? 0 : Math.min(absoluteMs, totalMs)}><span style={{ width: `${totalMs && !incomplete ? Math.min(100, absoluteMs / totalMs * 100) : 0}%` }} /></div>
  </section>
}
