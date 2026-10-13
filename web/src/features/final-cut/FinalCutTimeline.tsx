import { useState } from 'react'
import { Slider, UnstyledButton } from '@mantine/core'
import { Film } from 'lucide-react'
import type { SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'
import type { Asset, Shot, TimelineClip } from '../../shared/api/api'

export default function FinalCutTimeline({ shots, clips, assets, audio, musicAsset, selectedShotId, onSelectShot, onSelectSpeech }: {
  shots: Shot[]; clips: TimelineClip[]; assets: Asset[]; audio: SpeechAudioClip[]; musicAsset?: Asset; selectedShotId: string | null
  onSelectShot: (id: string) => void; onSelectSpeech: (lineId: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const byShot = new Map(clips.map(clip => [clip.shot_id, clip]))
  let total = 0
  const visual = [...shots].sort((a, b) => a.position - b.position).map(shot => {
    const clip = byShot.get(shot.id), start = total
    total += clip ? clip.out_ms - clip.in_ms : shot.duration * 1000
    return { shot, clip, start, end: total, asset: assets.find(asset => asset.id === clip?.asset_id) }
  })
  const length = Math.max(1, total)
  const style = (start: number, end: number) => ({ left: `${Math.min(length, Math.max(0, start)) / length * 100}%`, width: `${Math.max(0, Math.min(length, end) - Math.max(0, start)) / length * 100}%` })
  const lanes: SpeechAudioClip[][] = []
  for (const item of [...audio].sort((a, b) => a.start_ms - b.start_ms)) {
    const lane = lanes.find(items => items.at(-1)!.end_ms <= item.start_ms)
    if (lane) lane.push(item); else lanes.push([item])
  }
  return <div className="final-cut-timeline-editor">
    <div className="final-cut-timeline-zoom"><span>时间刻度</span><Slider aria-label="时间线缩放" min={1} max={6} step={0.5} value={zoom} onChange={setZoom} label={value => `${value}×`} /><span>{(total / 1000).toFixed(1)} 秒</span></div>
    <div className="final-cut-timeline-scroll"><div className="final-cut-timeline-content" style={{ minWidth: `${Math.max(700, zoom * 700)}px` }}>
      <div className="final-cut-time-ruler">{[0, 0.25, 0.5, 0.75, 1].map(value => <span key={value} style={{ left: `${value * 100}%` }}>{(value * total / 1000).toFixed(1)}s</span>)}</div>
      <div className="final-cut-visual-track" aria-label="画面轨道">{visual.map(({ shot, clip, start, end, asset }) => <UnstyledButton key={shot.id} className={`timeline-clip ${clip ? 'ready' : ''} ${shot.id === selectedShotId ? 'current' : ''}`} style={style(start, end)} title={`${shot.title} · ${(start / 1000).toFixed(1)}–${(end / 1000).toFixed(1)} 秒`} onClick={() => onSelectShot(shot.id)}>
        <div className="timeline-clip-preview">{asset?.kind === 'image' ? <img src={asset.url} alt={shot.title} /> : asset?.kind === 'video' ? <video src={asset.url} muted playsInline preload="metadata" /> : <Film size={18} />}</div>
        <div className="timeline-clip-label"><span>{shot.title}</span><b>{clip ? `${((end - start) / 1000).toFixed(1)}s` : '待选'}</b></div>
      </UnstyledButton>)}</div>
      <div className="final-cut-audio-tracks" aria-label="对白与旁白轨道">{lanes.length ? lanes.map((items, index) => <div className="final-cut-audio-row" key={index}>
        {items.map(item => <UnstyledButton key={item.id} className={`final-cut-audio-clip${item.stale || item.end_ms > total || item.start_ms < 0 ? ' needs-attention' : ''}`} style={style(item.start_ms, item.end_ms)} title={`${item.voice_name}：${item.text} · ${(item.start_ms / 1000).toFixed(1)}–${(item.end_ms / 1000).toFixed(1)} 秒`} onClick={() => onSelectSpeech(item.line_id)}><strong>{item.voice_name}</strong><span>{item.text}</span></UnstyledButton>)}
      </div>) : <p className="final-cut-audio-empty">配音入片后显示在这里，点击音频区间可调整位置与版本。</p>}</div>
      {musicAsset && <div className="final-cut-music-track" aria-label="背景配乐轨道" title={musicAsset.filename}><strong>配乐</strong><span>{musicAsset.filename}</span><small>全片循环 · 在成片设置中调整</small></div>}
    </div></div>
  </div>
}
