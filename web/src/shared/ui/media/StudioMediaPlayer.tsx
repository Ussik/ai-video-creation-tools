import { useRef, useState } from 'react'
import type { AudioHTMLAttributes, Ref, VideoHTMLAttributes } from 'react'
import { useMergedRef } from '@mantine/hooks'
import { ActionIcon, Menu, Slider, Tooltip } from '@mantine/core'
import { Download, Maximize, Pause, Play, Settings2, Volume2, VolumeX } from 'lucide-react'

type Props = (VideoHTMLAttributes<HTMLVideoElement> | AudioHTMLAttributes<HTMLAudioElement>) & {
  kind?: 'video' | 'audio'
  ref?: Ref<HTMLVideoElement | HTMLAudioElement>
}
const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`

/** Native media engine with shared Mantine controls; event targets and external refs stay native. */
export function StudioMediaPlayer({ kind = 'video', ref, controls = true, onLoadedMetadata, onDurationChange,
  onTimeUpdate, onPlay, onPause, onEnded, onVolumeChange, onError, ...props }: Props) {
  const element = useRef<HTMLVideoElement | HTMLAudioElement>(null)
  const mergedRef = useMergedRef(element, ref)
  const wrapper = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [position, setPosition] = useState(0)
  const [volume, setVolume] = useState(props.muted ? 0 : 100)
  const [rate, setRate] = useState(1)
  const [error, setError] = useState('')
  const engineProps = {
    ...props, ref: mergedRef,
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => {
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
      setPosition(event.currentTarget.currentTime); setError(''); onLoadedMetadata?.(event)
    },
    onDurationChange: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => {
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); onDurationChange?.(event)
    },
    onTimeUpdate: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setPosition(event.currentTarget.currentTime); onTimeUpdate?.(event) },
    onPlay: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setPlaying(true); setError(''); onPlay?.(event) },
    onPause: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setPlaying(false); onPause?.(event) },
    onEnded: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setPlaying(false); onEnded?.(event) },
    onVolumeChange: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setVolume(event.currentTarget.muted ? 0 : event.currentTarget.volume * 100); onVolumeChange?.(event) },
    onError: (event: React.SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => { setError('素材无法播放，请检查文件。'); onError?.(event) },
  }
  const changeVolume = (value: number) => { if (element.current) { element.current.muted = value === 0; element.current.volume = value / 100 }; setVolume(value) }
  return <div ref={wrapper} className={`studio-media-player is-${kind}${controls ? ' has-controls' : ''}`} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    // Dialog dismissal and focus trapping also apply while a media control is focused.
    if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
  }}>
    {kind === 'video' ? <video {...engineProps as VideoHTMLAttributes<HTMLVideoElement>} ref={mergedRef as Ref<HTMLVideoElement>} /> : <audio {...engineProps as AudioHTMLAttributes<HTMLAudioElement>} ref={mergedRef as Ref<HTMLAudioElement>} />}
    {controls && <div className="studio-media-controls nodrag nowheel" role="group" aria-label={kind === 'video' ? '视频播放控制' : '音频播放控制'}>
      <Tooltip label={playing ? '暂停' : '播放'}><ActionIcon aria-label={playing ? '暂停素材' : '播放素材'} onClick={() => {
        const media = element.current; if (!media) return
        if (media.paused) void media.play().catch(() => setError('播放失败，请重试。')); else media.pause()
      }}>{playing ? <Pause size={15} /> : <Play size={15} />}</ActionIcon></Tooltip>
      <Slider className="studio-media-seek" aria-label="素材播放进度" thumbLabel="素材播放进度" min={0} max={Math.max(duration, 1)} step={.1} value={position} disabled={!duration} label={time}
        onChange={value => { if (element.current) element.current.currentTime = value; setPosition(value) }} />
      <span className="studio-media-time">{time(position)} / {time(duration)}</span>
      <Tooltip label={volume ? '静音' : '取消静音'}><ActionIcon aria-label={volume ? '素材静音' : '取消素材静音'} onClick={() => changeVolume(volume ? 0 : 100)}>{volume ? <Volume2 size={15} /> : <VolumeX size={15} />}</ActionIcon></Tooltip>
      <Menu position="top-end" withinPortal zIndex={450}>
        <Menu.Target><ActionIcon aria-label="素材播放设置"><Settings2 size={15} /></ActionIcon></Menu.Target>
        <Menu.Dropdown><Menu.Label>音量</Menu.Label><Slider mx="sm" mb="sm" aria-label="素材音量" thumbLabel="素材音量" value={volume} onChange={changeVolume} />
          <Menu.Label>播放速度 · {rate}×</Menu.Label>{[.5, 1, 1.5, 2].map(value => <Menu.Item key={value} onClick={() => { if (element.current) element.current.playbackRate = value; setRate(value) }}>{value}×{rate === value ? ' · 当前' : ''}</Menu.Item>)}
          {props.src && <Menu.Item component="a" href={props.src} download leftSection={<Download size={14} />}>下载素材</Menu.Item>}
        </Menu.Dropdown>
      </Menu>
      {kind === 'video' && <Tooltip label="全屏"><ActionIcon aria-label="全屏播放素材" onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => setError('无法退出全屏。'))
        else void wrapper.current?.requestFullscreen?.().catch(() => setError('当前环境暂不支持全屏。'))
      }}><Maximize size={15} /></ActionIcon></Tooltip>}
    </div>}
    {error && <span className="studio-media-error" role="alert">{error}</span>}
  </div>
}
