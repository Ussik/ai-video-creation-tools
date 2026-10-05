import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Modal, Select } from '@mantine/core'
import { Columns2, Pause, Play, RefreshCcw, RotateCcw, TriangleAlert } from 'lucide-react'
import { api } from './api'
import type { Asset, AssetReview, Shot } from './api'
import './candidate-compare.css'

type DurationState = {
  status: 'loading' | 'ready' | 'error'
  durationMs: number | null
  message?: string
}

type CompareSide = 'left' | 'right'

interface CandidateCompareProps {
  shot: Shot
  assets: Asset[]
  reviews: AssetReview[]
  selectedAssetId: string | null
}

const reviewLabels = { pending: '待审核', approved: '已通过', rejected: '已拒绝' } as const
const reviewColors = { pending: 'gray', approved: 'teal', rejected: 'red' } as const
const framePoints = [
  { label: '首帧', progress: 0 },
  { label: '中帧', progress: 0.5 },
  { label: '尾帧', progress: 1 },
] as const

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return '—'
  return `${(durationMs / 1000).toFixed(2).replace(/\.?0+$/, '')} 秒`
}

function frameUrl(asset: Asset, durationMs: number | null, progress: number) {
  if (asset.kind === 'image') return asset.url
  if (asset.kind !== 'video' || durationMs === null || durationMs <= 0) return null
  const timeMs = Math.max(0, Math.min(durationMs - 1, Math.round(durationMs * progress) - (progress === 1 ? 50 : 0)))
  return `/api/assets/${encodeURIComponent(asset.id)}/frame?time_ms=${timeMs}`
}

function CompareFrame({ asset, durationMs, label, progress }: {
  asset: Asset
  durationMs: number | null
  label: string
  progress: number
}) {
  const url = frameUrl(asset, durationMs, progress)
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [url])

  return <div className="candidate-compare-frame">
    <div className="candidate-compare-frame-image">
      {url && !failed
        ? <img src={url} alt={`${asset.filename} ${label}`} loading="lazy" onError={() => setFailed(true)} />
        : <span>{failed ? '取帧失败' : '等待画面'}</span>}
    </div>
    <span>{label}</span>
  </div>
}

export default function CandidateCompare({ shot, assets, reviews, selectedAssetId }: CandidateCompareProps) {
  const candidates = useMemo(() => assets.filter((asset) =>
    (asset.shot_id === shot.id || asset.id === selectedAssetId) &&
    asset.source !== 'export' &&
    (asset.kind === 'image' || asset.kind === 'video')),
  [assets, shot.id, selectedAssetId])
  const candidateIds = candidates.map((asset) => asset.id).join('|')
  const [opened, setOpened] = useState(false)
  const [leftId, setLeftId] = useState<string | null>(null)
  const [rightId, setRightId] = useState<string | null>(null)
  const [durations, setDurations] = useState<Record<string, DurationState>>({})
  const [mediaErrors, setMediaErrors] = useState<Record<string, string>>({})
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [metadataRetry, setMetadataRetry] = useState(0)
  const videoRefs = useRef<Record<CompareSide, HTMLVideoElement | null>>({ left: null, right: null })
  const playbackRequest = useRef(0)

  useEffect(() => {
    const preferred = candidates.find((asset) => asset.id === selectedAssetId) || candidates[0]
    setLeftId(preferred?.id || null)
    setRightId(candidates.find((asset) => asset.id !== preferred?.id)?.id || null)
  }, [shot.id, selectedAssetId, candidateIds])

  const left = candidates.find((asset) => asset.id === leftId) || null
  const right = candidates.find((asset) => asset.id === rightId) || null
  const selected = [left, right] as const
  const selectedVideoIds = selected.filter((asset): asset is Asset => asset?.kind === 'video').map((asset) => asset.id)
  const selectedVideoKey = selectedVideoIds.join('|')
  const videoDurations = selectedVideoIds.map((id) => durations[id]?.durationMs).filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0)
  const allVideoDurationsReady = selectedVideoIds.length > 0 && videoDurations.length === selectedVideoIds.length
  const metadataFailed = selectedVideoIds.some((id) => durations[id]?.status === 'error')
  const sharedDurationMs = allVideoDurationsReady ? Math.max(...videoDurations) : 0
  const hasMediaError = selected.some((asset) => asset && mediaErrors[asset.id])
  const mixedMedia = !!left && !!right && left.kind !== right.kind

  function pauseVideos() {
    videoRefs.current.left?.pause()
    videoRefs.current.right?.pause()
  }

  function seekVideos(nextProgress: number) {
    for (const side of ['left', 'right'] as const) {
      const asset = side === 'left' ? left : right
      const video = videoRefs.current[side]
      const durationMs = asset ? durations[asset.id]?.durationMs : null
      if (!video || asset?.kind !== 'video' || typeof durationMs !== 'number') continue
      try { video.currentTime = Math.max(0, Math.min(durationMs - 1, nextProgress * durationMs)) / 1000 }
      catch { /* Seeking can be rejected before video metadata arrives. */ }
    }
  }

  useEffect(() => {
    playbackRequest.current += 1
    pauseVideos()
    setPlaying(false)
    setProgress(0)
    setPlaybackError(null)
  }, [opened, leftId, rightId])

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    for (const asset of selected) {
      if (asset?.kind !== 'video' || durations[asset.id]?.status === 'ready') continue
      setDurations((current) => ({ ...current, [asset.id]: { status: 'loading', durationMs: null } }))
      void api<{ duration_ms: number }>(`/assets/${encodeURIComponent(asset.id)}/metadata`)
        .then(({ duration_ms }) => {
          if (cancelled) return
          setDurations((current) => {
            if (current[asset.id]?.status === 'ready') return current
            return { ...current, [asset.id]: Number.isFinite(duration_ms) && duration_ms > 0
              ? { status: 'ready', durationMs: duration_ms }
              : { status: 'error', durationMs: null, message: '无法读取视频时长' } }
          })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setDurations((current) => current[asset.id]?.status === 'ready' ? current : {
            ...current,
            [asset.id]: { status: 'error', durationMs: null, message: error instanceof Error ? error.message : '无法读取视频时长' },
          })
        })
    }
    return () => { cancelled = true }
  }, [opened, selectedVideoKey, metadataRetry])

  useEffect(() => {
    if (!playing || !allVideoDurationsReady) return
    const primarySide: CompareSide = left?.kind === 'video' ? 'left' : 'right'
    let animation = 0
    const tick = () => {
      const primaryAsset = primarySide === 'left' ? left : right
      const primary = videoRefs.current[primarySide]
      const primaryDuration = primaryAsset ? durations[primaryAsset.id]?.durationMs : null
      if (!primary || typeof primaryDuration !== 'number' || primaryDuration <= 0) return
      const nextProgress = Math.min(1, primary.currentTime * 1000 / primaryDuration)
      setProgress(nextProgress)
      const otherSide: CompareSide = primarySide === 'left' ? 'right' : 'left'
      const otherAsset = otherSide === 'left' ? left : right
      const other = videoRefs.current[otherSide]
      const otherDuration = otherAsset ? durations[otherAsset.id]?.durationMs : null
      if (other && typeof otherDuration === 'number') {
        const targetTime = nextProgress * otherDuration / 1000
        if (Math.abs(other.currentTime - targetTime) > 0.18) {
          try { other.currentTime = targetTime }
          catch { /* Keep the primary preview running if the other video cannot seek yet. */ }
        }
      }
      if (nextProgress >= 0.995 || primary.ended) {
        pauseVideos()
        setPlaying(false)
        setProgress(1)
        return
      }
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [playing, leftId, rightId, sharedDurationMs])

  useEffect(() => () => {
    playbackRequest.current += 1
    pauseVideos()
  }, [])

  function choose(side: CompareSide, assetId: string | null) {
    if (side === 'left') setLeftId(assetId)
    else setRightId(assetId)
  }

  function scrub(nextProgress: number) {
    playbackRequest.current += 1
    pauseVideos()
    setPlaying(false)
    setProgress(nextProgress)
    seekVideos(nextProgress)
  }

  async function togglePlayback() {
    if (playing) {
      playbackRequest.current += 1
      pauseVideos()
      setPlaying(false)
      return
    }
    if (!allVideoDurationsReady || hasMediaError) return
    const nextProgress = progress >= 0.995 ? 0 : progress
    setProgress(nextProgress)
    seekVideos(nextProgress)
    setPlaybackError(null)
    const request = ++playbackRequest.current
    const videos = (['left', 'right'] as const).flatMap((side) => {
      const asset = side === 'left' ? left : right
      const video = videoRefs.current[side]
      const durationMs = asset ? durations[asset.id]?.durationMs : null
      if (!video || asset?.kind !== 'video' || typeof durationMs !== 'number') return []
      video.muted = true
      video.playbackRate = Math.max(0.1, durationMs / sharedDurationMs)
      return [video]
    })
    try {
      await Promise.all(videos.map((video) => video.play()))
      if (request === playbackRequest.current) setPlaying(true)
      else videos.forEach((video) => video.pause())
    } catch {
      videos.forEach((video) => video.pause())
      if (request === playbackRequest.current) {
        setPlaying(false)
        setPlaybackError('浏览器无法播放此素材，请检查视频格式或素材文件。')
      }
    }
  }

  function renderSide(side: CompareSide, asset: Asset | null, otherId: string | null) {
    const review = asset ? reviews.find((item) => item.shot_id === shot.id && item.asset_id === asset.id) : undefined
    const status = review?.status || 'pending'
    const duration = asset?.kind === 'video' ? durations[asset.id] : null
    const available = candidates.filter((item) => item.id !== otherId)

    return <section className="candidate-compare-side" aria-label={side === 'left' ? '左侧候选' : '右侧候选'}>
      <div className="candidate-compare-side-top">
        <span className="candidate-compare-side-index">{side === 'left' ? '候选 A' : '候选 B'}</span>
        {asset?.id === selectedAssetId && <Badge size="xs" variant="light" color="cyan">当前入片</Badge>}
      </div>
      <Select
        aria-label={side === 'left' ? '选择左侧候选' : '选择右侧候选'}
        placeholder={candidates.length < 2 && side === 'right' ? '暂无第二个候选' : '选择候选素材'}
        data={available.map((item, index) => ({
          value: item.id,
          label: `${String(candidates.indexOf(item) + 1).padStart(2, '0')} · ${item.filename || `${index + 1} 号素材`}`,
        }))}
        value={asset?.id || null}
        onChange={(value) => choose(side, value)}
        disabled={side === 'right' && candidates.length < 2}
        searchable={available.length > 6}
        allowDeselect={false}
      />
      {asset ? <>
        <div className="candidate-compare-metadata">
          <Badge size="xs" variant="light" color={reviewColors[status]}>{reviewLabels[status]}</Badge>
          <span>{asset.kind === 'image' ? '静态图片' : duration?.status === 'ready' ? formatDuration(duration.durationMs) : duration?.status === 'error' ? '时长读取失败' : '正在读取时长…'}</span>
        </div>
        <div className="candidate-compare-preview">
          {asset.kind === 'video'
            ? <video key={asset.id} ref={(node) => { videoRefs.current[side] = node }} src={asset.url}
                muted playsInline preload="metadata" aria-label={`${side === 'left' ? '左侧' : '右侧'}候选视频`}
                onLoadedMetadata={(event) => {
                  const durationMs = durations[asset.id]?.durationMs
                  if (typeof durationMs === 'number' && durationMs > 0) event.currentTarget.currentTime = progress * durationMs / 1000
                }}
                onError={() => setMediaErrors((current) => ({ ...current, [asset.id]: '视频加载失败，请检查素材文件。' }))} />
            : <img src={asset.url} alt={asset.filename}
                onError={() => setMediaErrors((current) => ({ ...current, [asset.id]: '图片加载失败，请检查素材文件。' }))} />}
          {mediaErrors[asset.id] && <div className="candidate-compare-media-error" role="alert"><TriangleAlert size={18} />{mediaErrors[asset.id]}</div>}
        </div>
        <div className="candidate-compare-filename" title={asset.filename}>{asset.filename}</div>
        {duration?.status === 'error' && <div className="candidate-compare-hint" role="status">{duration.message}</div>}
        <div className="candidate-compare-frames" aria-label={`${side === 'left' ? '左侧' : '右侧'}候选关键画面`}>
          {framePoints.map((point) => <CompareFrame key={`${asset.id}:${point.label}`} asset={asset}
            durationMs={asset.kind === 'video' ? duration?.durationMs ?? null : null}
            label={point.label} progress={point.progress} />)}
        </div>
        <div className="candidate-compare-note">
          <span>审核备注</span>
          <p>{review?.note || '暂无备注'}</p>
        </div>
      </> : <div className="candidate-compare-empty-side">
        {candidates.length < 2 ? '当前镜头只有一个候选；生成或导入新版本后即可并排比较。' : '选择一个候选开始对照。'}
      </div>}
    </section>
  }

  return <>
    <Button variant="default" size="xs" onClick={() => setOpened(true)} leftSection={<Columns2 size={15} />}>
      候选并排比较
    </Button>
    <Modal className="candidate-compare-modal" opened={opened} onClose={() => setOpened(false)}
      title="候选并排比较" size={1120} centered>
      <div className="candidate-compare-intro">
        <strong>{shot.title}</strong>
        <span>对照两版画面、时长与审核记录。同步预览按素材的相对进度播放，声音默认静音。</span>
      </div>
      {candidates.length === 0 ? <div className="candidate-compare-empty">当前镜头暂无图片或视频候选。</div> : <>
        <div className="candidate-compare-grid">
          {renderSide('left', left, rightId)}
          {renderSide('right', right, leftId)}
        </div>
        <div className="candidate-compare-transport">
          <Button variant="light" color="cyan" size="xs" onClick={() => void togglePlayback()}
            disabled={!allVideoDurationsReady || !!hasMediaError}
            leftSection={playing ? <Pause size={15} /> : <Play size={15} />}>
            {playing ? '暂停' : '同步播放'}
          </Button>
          <input type="range" min="0" max="1000" step="1" value={Math.round(progress * 1000)}
            aria-label="共同进度" disabled={!allVideoDurationsReady || !!hasMediaError}
            onChange={(event) => scrub(Number(event.currentTarget.value) / 1000)} />
          <span className="candidate-compare-progress">{Math.round(progress * 100)}%</span>
          <Button variant="subtle" size="xs" onClick={() => scrub(0)} disabled={!allVideoDurationsReady}
            leftSection={<RotateCcw size={14} />}>归零</Button>
        </div>
        {selectedVideoIds.length === 0 && <p className="candidate-compare-transport-note">所选候选均为静态图片，可直接对照画面。</p>}
        {mixedMedia && <p className="candidate-compare-transport-note">图片与视频混合比较：图片保持静止，共同进度只控制视频。</p>}
        {selectedVideoIds.length > 0 && !allVideoDurationsReady && !metadataFailed && <p className="candidate-compare-transport-note">正在读取视频时长；读取完成后可同步播放和拖动进度。</p>}
        {metadataFailed && <Button variant="subtle" size="xs" onClick={() => setMetadataRetry((current) => current + 1)}
          leftSection={<RefreshCcw size={14} />}>重试读取视频时长</Button>}
        {playbackError && <div className="candidate-compare-playback-error" role="alert"><TriangleAlert size={16} />{playbackError}</div>}
      </>}
    </Modal>
  </>
}
