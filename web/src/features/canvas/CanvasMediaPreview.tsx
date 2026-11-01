import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@mantine/core'
import { ArrowLeftRight, ScanEye } from 'lucide-react'
import type { Asset } from '../../shared/api/api'
import CanvasNodeMedia from './CanvasNodeMedia'
import CanvasImagePreview from './CanvasImagePreview'
import CanvasVideoReviewPanel from './CanvasVideoReviewPanel'
import CanvasVideoComparisonPanel from './CanvasVideoComparisonPanel'
import type { VideoReviewModelOption } from './canvas-video-review'
import './canvas-media-preview.css'

export default function CanvasMediaPreview({ asset, title, onClose, projectId, reviewModels = [], shotId, initialPanel, generationDurationMs, plannedDurationMs }: {
  asset: Asset; title: string; onClose: () => void; projectId?: string; reviewModels?: VideoReviewModelOption[]
  shotId?: string | null; initialPanel?: 'review' | 'comparison'; generationDurationMs?: number; plannedDurationMs?: number
}) {
  const [panel, setPanel] = useState<'review' | 'comparison' | null>(initialPanel || null)
  const [reviewAsset, setReviewAsset] = useState<Asset | null>(null)
  const [sourceDurationMs, setSourceDurationMs] = useState<number | undefined>()
  const stage = useRef<HTMLDivElement>(null)
  const activeAsset = reviewAsset || asset
  useEffect(() => setSourceDurationMs(undefined), [activeAsset.id])
  const videoTools = asset.kind === 'video' && !!projectId
  const seek = (timeMs: number) => {
    const video = stage.current?.querySelector('video')
    if (!video) return
    video.currentTime = Math.max(0, timeMs / 1000)
    video.dispatchEvent(new Event('timeupdate'))
  }
  return <Modal opened onClose={onClose} closeOnEscape={false} fullScreen xOffset={0} yOffset={0} radius={0} padding={0} zIndex={240}
    title={videoTools ? <div className="pc-media-preview-review-title"><div className="pc-media-preview-video-label"><span>{reviewAsset ? `${title || asset.filename} · 对照候选` : title || asset.filename}</span>
      <small aria-label="生成与入片时长">{generationDurationMs !== undefined ? `生成 ${(generationDurationMs / 1000).toFixed(1)} 秒` : '生成时长未记录'}
        {sourceDurationMs !== undefined ? ` · 素材 ${(sourceDurationMs / 1000).toFixed(1)} 秒` : ''}
        {plannedDurationMs !== undefined ? ` · 计划入片 ${(plannedDurationMs / 1000).toFixed(1)} 秒` : ' · 尚未关联分镜时长'}</small></div><div>
      <Button aria-label="成片复核" variant={panel === 'review' ? 'light' : 'subtle'} size="compact-xs" leftSection={<ScanEye size={14} />} onClick={() => setPanel(panel === 'review' ? null : 'review')}>成片复核</Button>
      <Button aria-label="动作对照" variant={panel === 'comparison' ? 'light' : 'subtle'} size="compact-xs" leftSection={<ArrowLeftRight size={14} />} onClick={() => { setReviewAsset(null); setPanel(panel === 'comparison' ? null : 'comparison') }}>动作对照</Button>
      {reviewAsset && <Button aria-label="返回原片" variant="default" size="compact-xs" onClick={() => setReviewAsset(null)}>返回原片</Button>}
    </div></div> : title || asset.filename} closeButtonProps={{ 'aria-label': '关闭素材预览' }}
    classNames={{ content: 'pc-media-preview', header: 'pc-media-preview-header', title: 'pc-media-preview-title', body: 'pc-media-preview-body' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key !== 'Tab') event.stopPropagation()
      // Close after window capture listeners have run, keeping the same Escape
      // from also closing a candidate manager or clearing the canvas selection.
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); onClose() }
    }}>
    <div ref={stage} className={`pc-media-preview-stage${asset.kind === 'image' ? ' pc-media-preview-image-stage' : ''}`} onLoadedMetadataCapture={event => {
      const media = event.target as HTMLVideoElement
      if (media.tagName === 'VIDEO' && Number.isFinite(media.duration) && media.duration > 0) setSourceDurationMs(Math.round(media.duration * 1000))
    }}>
      {activeAsset.kind === 'image' ? <CanvasImagePreview key={`${activeAsset.id}:${activeAsset.url}`} src={activeAsset.url} alt={title || activeAsset.filename} /> : <CanvasNodeMedia asset={activeAsset} controls />}
    </div>
    {videoTools && panel === 'review' && <CanvasVideoReviewPanel key={activeAsset.id} projectId={projectId!} assetId={activeAsset.id} shotId={activeAsset.shot_id || shotId}
      models={reviewModels} onSeek={seek} onClose={() => setPanel(null)} />}
    {videoTools && panel === 'comparison' && <CanvasVideoComparisonPanel key={asset.id} projectId={projectId!} asset={asset} onClose={() => setPanel(null)}
      onReviewCandidate={candidate => { setReviewAsset(candidate); setPanel('review') }} />}
  </Modal>
}
