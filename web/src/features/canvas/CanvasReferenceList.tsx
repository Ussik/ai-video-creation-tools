import { useState } from 'react'
import { ActionIcon, Badge, Collapse, Tooltip, UnstyledButton } from '@mantine/core'
import { ChevronDown, Eye, ImageIcon, LocateFixed, X } from 'lucide-react'
import type { Asset } from '../../shared/api/api'
import './canvas-reference-list.css'

export type CanvasReferenceItem = {
  assetId: string
  asset?: Asset
  name: string
  source: 'base' | 'profile' | 'asset' | 'snapshot'
  version?: string
  required?: boolean
  canLocate?: boolean
}

export type CanvasReferenceListProps = {
  items: CanvasReferenceItem[]
  generating?: boolean
  disabled?: boolean
  onPreview?: (item: CanvasReferenceItem) => void
  onLocate?: (item: CanvasReferenceItem) => void
  onRemove?: (item: CanvasReferenceItem) => void
}

const sourceLabels: Record<CanvasReferenceItem['source'], string> = { base: '基础继承', profile: '设定库', asset: '素材库', snapshot: '已提交参考' }

/** References shown here describe the current composer or the active task snapshot. */
export default function CanvasReferenceList({ items, generating = false, disabled = false, onPreview, onLocate, onRemove }: CanvasReferenceListProps) {
  const [expanded, setExpanded] = useState(true)
  const title = generating ? '本次任务使用的参考' : '本次生成将使用的参考'
  return <section className="pc-reference-list" aria-label={title}>
    <UnstyledButton className="pc-reference-list-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span><strong>{title}</strong><Badge size="xs" variant="light" color="gray">{items.length}</Badge></span>
      <ChevronDown size={14} className={expanded ? 'is-expanded' : undefined} aria-hidden="true" />
    </UnstyledButton>
    <Collapse expanded={expanded} transitionDuration={0}>
      {!items.length ? <p className="pc-reference-list-empty">{generating ? '本次任务未使用参考图。' : '未添加参考图，将按提示词生成。'}</p>
        : <ul className="pc-reference-list-items">
          {items.map((item, index) => {
            const valid = item.asset?.id === item.assetId && item.asset.kind === 'image' && Boolean(item.asset.url)
            const required = item.required || item.source === 'base'
            const name = item.name.trim() && item.name.trim() !== item.assetId ? item.name.trim() : `参考图 ${index + 1}`
            return <li key={item.assetId} className={`pc-reference-list-item${valid ? '' : ' is-unavailable'}`}>
              <UnstyledButton className="pc-reference-list-thumb" aria-label={`预览参考图：${name}`} disabled={!valid || !onPreview}
                onClick={() => onPreview?.(item)}>
                {valid ? <img src={item.asset!.url} alt={name} loading="lazy" /> : <ImageIcon size={18} />}
              </UnstyledButton>
              <div className="pc-reference-list-copy">
                <div className="pc-reference-list-name"><span title={name}>{name}</span>
                  {required && <Badge size="xs" variant="light" color="gray">必需</Badge>}
                  {!valid && <Badge size="xs" variant="light" color="orange">已失效</Badge>}
                </div>
                <p>{sourceLabels[item.source]}{item.source !== 'snapshot' && <><span aria-hidden="true"> · </span>{item.source === 'base' ? '保持身份' : '补充参考'}</>}
                  {item.version && <><span aria-hidden="true"> · </span><span>{item.version}</span></>}</p>
              </div>
              <div className="pc-reference-list-actions">
                {onPreview && <Tooltip label="预览参考图" withinPortal><ActionIcon variant="subtle" size="sm" color="gray"
                  aria-label={`预览：${name}`} disabled={!valid} onClick={() => onPreview(item)}><Eye size={14} /></ActionIcon></Tooltip>}
                {onLocate && item.canLocate !== false && <Tooltip label="定位来源" withinPortal><ActionIcon variant="subtle" size="sm" color="gray"
                  aria-label={`定位：${name}`} disabled={disabled} onClick={() => onLocate(item)}><LocateFixed size={14} /></ActionIcon></Tooltip>}
                {!required && onRemove && <Tooltip label={generating ? '本次任务的参考已确定' : '移除参考'} withinPortal><ActionIcon variant="subtle" size="sm" color="gray"
                  aria-label={`移除参考：${name}`} disabled={disabled || generating} onClick={() => onRemove(item)}><X size={14} /></ActionIcon></Tooltip>}
              </div>
            </li>
          })}
        </ul>}
    </Collapse>
  </section>
}
