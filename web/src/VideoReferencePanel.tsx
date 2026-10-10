import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Image as ImageIcon, LockKeyhole, MapPin, RotateCcw, X } from 'lucide-react'
import type { VideoReferenceEntry, VideoReferencePurpose } from '../../backend/src/video-reference-manifest'
import type { Asset } from './api'

export interface VideoReferencePanelProps {
  entries: VideoReferenceEntry[]
  assets: Asset[]
  excludedBindings?: Array<{ profile_id: string; name: string; variant?: string }>
  onPreview: (asset: Asset) => void
  onLocate?: (entry: VideoReferenceEntry) => void
  onExclude?: (profileId: string) => void
  onRestore?: (profileId: string) => void
  onRemoveManual?: (assetId: string) => void
  disabled?: boolean
}

const purposeLabels: Record<VideoReferencePurpose, string> = {
  storyboard: '分镜构图', character: '人物', location: '场景', prop: '道具', manual: '手动参考',
  first_frame: '首帧', last_frame: '尾帧',
}

/** Inline reference images, using exactly the same numbering as the generation request. */
export default function VideoReferencePanel({
  entries, assets, excludedBindings = [], onPreview, onLocate, onExclude, onRestore, onRemoveManual, disabled,
}: VideoReferencePanelProps) {
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  if (!entries.length && !excludedBindings.length) return null
  const assetMap = new Map(assets.map(asset => [asset.id, asset]))
  return <section className="pc-video-references" aria-label="视频参考图">
    <button type="button" className="pc-video-references-heading" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded(value => !value)}>
      <ImageIcon size={13} aria-hidden="true" /><span>视频参考图</span><span className="pc-video-references-count">{entries.length} 张</span>
      {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
    </button>
    {expanded && <div id={contentId} className="pc-video-references-content">
      {!!entries.length && <ul className="pc-video-references-list" aria-label="本次提交的参考图">
        {entries.map(entry => {
          const asset = assetMap.get(entry.asset_id)
          const caption = `${entry.name}${entry.variant ? ` · ${entry.variant}` : ''}`
          const removableManual = !entry.profile_ids.length && entry.purpose === 'manual' && onRemoveManual
          return <li className="pc-video-reference" key={entry.asset_id}>
            <button type="button" className="pc-video-reference-preview" aria-label={`查看图片${entry.index}：${caption}`}
              disabled={!asset} onClick={() => { if (asset) onPreview(asset) }}>
              {asset ? <img src={asset.url} alt={caption} loading="lazy" /> : <span className="pc-video-reference-unavailable"><ImageIcon size={17} /><span>图片缺失</span></span>}
              <span className="pc-video-reference-number">图片{entry.index}</span>
            </button>
            <div className="pc-video-reference-meta"><span className="pc-video-reference-purpose">{purposeLabels[entry.purpose]}{entry.required && <LockKeyhole size={10} aria-label="必需参考" />}</span>
              <strong title={caption}>{caption}</strong>
            </div>
            {(onLocate || removableManual || !entry.required && entry.profile_ids.length > 0 && onExclude) && <div className="pc-video-reference-actions">
              {onLocate && <button type="button" aria-label={`定位参考节点：${caption}`} title="定位参考节点" disabled={disabled} onClick={() => onLocate(entry)}><MapPin size={12} /></button>}
              {!entry.required && entry.profile_ids.length > 0 && onExclude && <button type="button" aria-label={`排除可选参考：${caption}`} title="本次不使用此参考" disabled={disabled}
                onClick={() => entry.profile_ids.forEach(onExclude)}><X size={12} /></button>}
              {removableManual && <button type="button" aria-label={`移除手动参考：${caption}`} title="移除手动参考" disabled={disabled} onClick={() => onRemoveManual(entry.asset_id)}><X size={12} /></button>}
            </div>}
          </li>
        })}
      </ul>}
      {!!excludedBindings.length && <div className="pc-video-references-excluded" aria-label="本次排除的可选参考">
        <span>本次未使用</span>{excludedBindings.map(binding => <button key={binding.profile_id} type="button" disabled={disabled || !onRestore}
          aria-label={`恢复可选参考：${binding.name}`} title={binding.variant ? `${binding.name} · ${binding.variant}` : binding.name}
          onClick={() => onRestore?.(binding.profile_id)}><RotateCcw size={11} /><span>{binding.name}</span></button>)}
      </div>}
    </div>}
  </section>
}
