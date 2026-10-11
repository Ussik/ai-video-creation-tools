import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Film } from 'lucide-react'
import type { Asset } from './api'

export function canvasPreviewUrl(asset: Pick<Asset, 'id' | 'url'>, size = 640): string {
  return asset.url === `/api/assets/${asset.id}/file` ? `/api/assets/${asset.id}/preview?size=${size}` : asset.url
}

function ActiveVideo({ asset, onMediaSize }: { asset: Asset; onMediaSize?: (width: number, height: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const pause = () => { if (!video.paused) video.pause() }
    const onVisibility = () => { if (document.hidden) pause() }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) pause()
    })
    observer?.observe(video)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { pause(); observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])
  return <video ref={ref} src={asset.url} poster={canvasPreviewUrl(asset)} controls playsInline preload="metadata"
    onLoadedMetadata={onMediaSize ? event => onMediaSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight) : undefined} />
}

function MediaPreview({ asset, active, previewSize, onMediaSize }: { asset: Asset; active: boolean; previewSize: 320 | 640; onMediaSize?: (width: number, height: number) => void }) {
  const preview = canvasPreviewUrl(asset, previewSize)
  const [failed, setFailed] = useState<string | null>(null)
  const original = asset.kind === 'image' && (active || failed === preview)
  if (asset.kind === 'video' && failed === preview) return <div className="pc-node-empty"><Film size={28} /><span>{asset.filename}</span></div>
  return <img src={original ? asset.url : preview} alt={asset.filename} loading="lazy" decoding="async"
    onError={original ? undefined : () => setFailed(preview)}
    onLoad={onMediaSize ? event => onMediaSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight) : undefined} />
}

export default function CanvasNodeMedia({ asset, controls = false, previewSize = 640, onMediaSize }: { asset?: Asset; controls?: boolean; previewSize?: 320 | 640; onMediaSize?: (width: number, height: number) => void }) {
  if (!asset) return <div className="pc-node-empty"><CircleAlert size={16} />素材不可用</div>
  if (asset.kind === 'video' && controls) return <ActiveVideo key={asset.id} asset={asset} onMediaSize={onMediaSize} />
  if (asset.kind === 'image' || asset.kind === 'video') return <MediaPreview key={asset.id} asset={asset} active={controls} previewSize={previewSize} onMediaSize={onMediaSize} />
  return <div className="pc-node-text">{asset.text || asset.filename}</div>
}
