import { useEffect, useMemo, useState } from 'react'
import { Button, Slider } from '@mantine/core'
import { RotateCcw, Save, TriangleAlert } from 'lucide-react'
import { api, json } from './api'
import type { Asset, CutReview, ProjectDetail, TimelineClip } from './api'
import TimelinePreview from './TimelinePreview'
import './cut-point-trial.css'

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} 秒`
}

function trialFrameUrl(asset: Asset, timeMs: number) {
  return asset.kind === 'video'
    ? `/api/assets/${encodeURIComponent(asset.id)}/frame?time_ms=${Math.max(0, timeMs)}`
    : asset.url
}

function TrialFrame({ url, timeMs, label, onLoaded, onFailed }: {
  url: string; timeMs: number; label: string; onLoaded: (url: string) => void; onFailed: (url: string) => void
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <div className="cut-trial-frame">
    <div className="cut-trial-image">
      {!failed ? <img src={url} alt={label} onLoad={() => onLoaded(url)}
        onError={() => { setFailed(true); onFailed(url) }} /> : <span>无法读取试配画面</span>}
    </div>
    <span>{label} · {seconds(timeMs)}</span>
  </div>
}

interface CutPointTrialProps {
  cut: CutReview
  detail: ProjectDetail
  noteDirty: boolean
  onSaved: () => Promise<void>
}

export default function CutPointTrial({ cut, detail, noteDirty, onSaved }: CutPointTrialProps) {
  const fromClip = detail.timeline_clips.find((clip) => clip.shot_id === cut.from_shot_id)
  const toClip = detail.timeline_clips.find((clip) => clip.shot_id === cut.to_shot_id)
  const fromAsset = detail.assets.find((asset) => asset.id === fromClip?.asset_id)
  const toAsset = detail.assets.find((asset) => asset.id === toClip?.asset_id)
  const fromShot = detail.shots.find((shot) => shot.id === cut.from_shot_id)
  const toShot = detail.shots.find((shot) => shot.id === cut.to_shot_id)
  const [fromOut, setFromOut] = useState(cut.from.out_ms ?? 0)
  const [toIn, setToIn] = useState(cut.to.in_ms ?? 0)
  const [previewFromOut, setPreviewFromOut] = useState(fromOut)
  const [previewToIn, setPreviewToIn] = useState(toIn)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [frameStatus, setFrameStatus] = useState<Record<string, 'ready' | 'error'>>({})

  useEffect(() => {
    const currentFromOut = cut.from.out_ms ?? 0
    const currentToIn = cut.to.in_ms ?? 0
    setFromOut(currentFromOut)
    setToIn(currentToIn)
    setPreviewFromOut(currentFromOut)
    setPreviewToIn(currentToIn)
    setError(null)
    setFrameStatus({})
  }, [cut.from_shot_id, cut.to_shot_id, cut.signature])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewFromOut(fromOut)
      setPreviewToIn(toIn)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [fromOut, toIn])

  const fromMin = (fromClip?.in_ms ?? 0) + 200
  const fromMax = fromClip?.source_duration_ms ?? fromClip?.out_ms ?? 0
  const toMax = (toClip?.out_ms ?? 0) - 200
  const fromAdjustable = fromAsset?.kind === 'video' && fromMax > fromMin
  const toAdjustable = toAsset?.kind === 'video' && toMax > 0
  const valid = !!fromClip && !!toClip && !!fromAsset && !!toAsset && !!fromShot && !!toShot &&
    fromOut >= fromMin && fromOut <= fromMax && toIn >= 0 && toIn <= toMax
  const changed = fromOut !== cut.from.out_ms || toIn !== cut.to.in_ms
  const delta = (fromOut - (cut.from.out_ms ?? fromOut)) - (toIn - (cut.to.in_ms ?? toIn))
  const fromFrameTime = fromAsset?.kind === 'video' ? Math.max(fromClip?.in_ms ?? 0, previewFromOut - 50) : previewFromOut
  const toFrameTime = toAsset?.kind === 'video' ? previewToIn : 0
  const fromFrameUrl = fromAsset ? trialFrameUrl(fromAsset, fromFrameTime) : null
  const toFrameUrl = toAsset ? trialFrameUrl(toAsset, toFrameTime) : null
  const previewReady = previewFromOut === fromOut && previewToIn === toIn &&
    !!fromFrameUrl && !!toFrameUrl && frameStatus[fromFrameUrl] === 'ready' && frameStatus[toFrameUrl] === 'ready'
  const failedFrames = (!!fromFrameUrl && frameStatus[fromFrameUrl] === 'error') ||
    (!!toFrameUrl && frameStatus[toFrameUrl] === 'error')

  const previewClips = useMemo(() => {
    if (!valid || !fromClip || !toClip) return []
    const from: TimelineClip = {
      ...fromClip, in_ms: Math.max(fromClip.in_ms, previewFromOut - 1200), out_ms: previewFromOut,
    }
    const to: TimelineClip = {
      ...toClip, in_ms: previewToIn, out_ms: Math.min(toClip.out_ms, previewToIn + 1200),
    }
    return [from, to].filter((clip) => clip.out_ms - clip.in_ms >= 200)
  }, [fromClip, toClip, previewFromOut, previewToIn, valid])

  async function apply() {
    if (!valid || !changed || !previewReady || saving || noteDirty) return
    setSaving(true)
    setError(null)
    try {
      await api(`/projects/${detail.id}/cut-points`, json('PUT', {
        from_shot_id: cut.from_shot_id,
        to_shot_id: cut.to_shot_id,
        signature: cut.signature,
        from_out_ms: fromOut,
        to_in_ms: toIn,
      }))
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  if (!cut.ready || !fromClip || !toClip || !fromAsset || !toAsset || !fromShot || !toShot) return null

  return <section className="cut-trial" aria-label="切点试配">
    <div className="cut-trial-heading">
      <div><strong>切点试配</strong><span>先看画面与短预演，确认后再应用到成片</span></div>
      <span className="cut-trial-delta">总时长 {delta >= 0 ? '+' : ''}{seconds(delta)}</span>
    </div>
    <div className="cut-trial-controls">
      <div className="cut-trial-control">
        <div><label htmlFor="cut-trial-from">上一镜出点</label><span>{seconds(fromOut)}</span></div>
        <Slider id="cut-trial-from" aria-label="上一镜试配出点" value={fromOut}
          min={fromMin} max={Math.max(fromMin, fromMax)} step={50} disabled={!fromAdjustable}
          label={(value) => seconds(value)} onChange={setFromOut} />
        <small>入点 {seconds(fromClip.in_ms)} · 素材最长 {seconds(fromMax)}</small>
      </div>
      <div className="cut-trial-control">
        <div><label htmlFor="cut-trial-to">下一镜入点</label><span>{seconds(toIn)}</span></div>
        <Slider id="cut-trial-to" aria-label="下一镜试配入点" value={toIn}
          min={0} max={Math.max(0, toMax)} step={50} disabled={!toAdjustable}
          label={(value) => seconds(value)} onChange={setToIn} />
        <small>素材起点 0 秒 · 当前出点 {seconds(toClip.out_ms)}</small>
      </div>
    </div>
    {!fromAdjustable && !toAdjustable && <p className="cut-trial-hint">当前素材没有可调整的视频切点。</p>}
    <div className="cut-trial-frames">
      <TrialFrame key={`${fromAsset.id}:${previewFromOut}`} url={fromFrameUrl!} timeMs={fromFrameTime} label="试配尾帧"
        onLoaded={(url) => setFrameStatus((current) => ({ ...current, [url]: 'ready' }))}
        onFailed={(url) => setFrameStatus((current) => ({ ...current, [url]: 'error' }))} />
      <TrialFrame key={`${toAsset.id}:${previewToIn}`} url={toFrameUrl!} timeMs={toFrameTime} label="试配首帧"
        onLoaded={(url) => setFrameStatus((current) => ({ ...current, [url]: 'ready' }))}
        onFailed={(url) => setFrameStatus((current) => ({ ...current, [url]: 'error' }))} />
    </div>
    {valid && previewClips.length === 2 && <div className="cut-trial-preview">
      <span>接点前后预演</span>
      <TimelinePreview clips={previewClips} assets={detail.assets} shots={[fromShot, toShot]} ratio={detail.ratio} />
    </div>}
    {!valid && <p className="cut-trial-hint" role="alert">试配切点超出素材范围，或片段不足 0.2 秒。</p>}
    {failedFrames && <p className="cut-trial-hint" role="alert">试配画面无法读取，请恢复原切点或检查素材。</p>}
    {noteDirty && <p className="cut-trial-hint">当前审核备注尚未保存。请先保存备注，再应用切点。</p>}
    {error && <p className="cut-trial-hint" role="alert"><TriangleAlert size={14} />{error}</p>}
    <div className="cut-trial-actions">
      <Button variant="default" size="xs" disabled={!changed || saving} onClick={() => {
        setFromOut(cut.from.out_ms ?? 0)
        setToIn(cut.to.in_ms ?? 0)
        setError(null)
      }} leftSection={<RotateCcw size={14} />}>恢复原切点</Button>
      <Button size="xs" disabled={!changed || !valid || !previewReady || saving || noteDirty || failedFrames} loading={saving}
        onClick={() => void apply()} leftSection={<Save size={14} />}>应用切点并重审</Button>
    </div>
  </section>
}
