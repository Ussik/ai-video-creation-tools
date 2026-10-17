import { useEffect, useRef, useState } from 'react'
import { Button, Modal, UnstyledButton } from '@mantine/core'
import { Archive, ArchiveRestore, Check, Expand, Images } from 'lucide-react'
import type { Asset, Model } from '../../shared/api/api'
import './shot-candidates.css'

type CandidateProps = {
  candidates: Asset[]
  archivedAssetIds: string[]
  displayedAssetId?: string | null
  busy?: boolean
  generating?: boolean
  onUse: (assetId: string) => Promise<void>
}

type ManagerProps = CandidateProps & {
  protectedAssetIds?: string[]
  models: Model[]
  title: string
  onArchive: (assetId: string, archived: boolean) => Promise<void>
  onPreview: (asset: Asset) => void
  onClose: () => void
  onBusyChange?: (busy: boolean) => void
  previewOpen?: boolean
}

function imageCandidates(candidates: Asset[]) {
  const seen = new Set<string>()
  return candidates.filter(asset => {
    if (asset.kind !== 'image' || seen.has(asset.id)) return false
    seen.add(asset.id)
    return true
  })
}

function useCandidateAction(onBusyChange?: (busy: boolean) => void) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  const busyChange = useRef(onBusyChange)
  busyChange.current = onBusyChange
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  async function run(key: string, action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setPending(key)
    setError('')
    busyChange.current?.(true)
    try { await action() } catch (issue) {
      if (mounted.current) setError(issue instanceof Error ? issue.message : String(issue))
    } finally {
      locked.current = false
      if (mounted.current) setPending(null)
      busyChange.current?.(false)
    }
  }
  return { pending, error, setError, run, locked }
}

export function ShotCandidateStrip({ candidates, archivedAssetIds, displayedAssetId, busy = false, generating = false, onUse, onManage }: CandidateProps & { onManage: () => void }) {
  const archived = new Set(archivedAssetIds)
  const all = imageCandidates(candidates)
  const visible = all.filter(asset => !archived.has(asset.id))
  const action = useCandidateAction()
  const disabled = busy || action.pending !== null || generating
  return <section className="pc-shot-candidates" aria-label="分镜图候选">
    <div className="pc-shot-candidates-heading">
      <span><Images size={14} />分镜图候选 <span className="pc-shot-candidates-count">{visible.length}</span></span>
      <Button variant="subtle" size="compact-xs" disabled={busy || action.pending !== null || all.length === 0} onClick={() => { if (!busy && !action.locked.current) onManage() }}>管理候选</Button>
    </div>
    {visible.length ? <div className="pc-shot-candidate-strip" aria-label="分镜图候选列表">{visible.map((asset, index) => {
      const current = asset.id === displayedAssetId
      return <UnstyledButton type="button" key={asset.id} aria-label={`使用分镜图候选 ${index + 1}`} aria-pressed={current} disabled={disabled || current}
        onClick={() => { if (!busy && !generating) void action.run(asset.id, () => onUse(asset.id)) }}>
        <img src={asset.url} alt={asset.filename} loading="lazy" />
        <span>{current ? <><Check size={11} />当前使用</> : action.pending === asset.id ? '切换中…' : `候选 ${index + 1}`}</span>
      </UnstyledButton>
    })}</div> : <p className="pc-shot-candidate-empty-inline">{all.length ? '候选图已归档，可在管理候选中恢复' : '生成分镜图后，可在这里比较和切换'}</p>}
    {action.error && <p className="pc-shot-candidate-error" role="alert">{action.error}</p>}
  </section>
}

export default function ShotCandidateManager({ candidates, archivedAssetIds, displayedAssetId, protectedAssetIds = [], models, title, busy = false, generating = false, onUse, onArchive, onPreview, onClose, onBusyChange, previewOpen = false }: ManagerProps) {
  const all = imageCandidates(candidates)
  const archived = new Set(archivedAssetIds)
  const protectedIds = new Set(protectedAssetIds)
  const [filter, setFilter] = useState<'active' | 'archived'>('active')
  const [selectedId, setSelectedId] = useState(displayedAssetId || all.find(asset => !archived.has(asset.id))?.id)
  const action = useCandidateAction(onBusyChange)
  const locked = busy || action.pending !== null
  const visible = all.filter(asset => archived.has(asset.id) === (filter === 'archived'))
  const selected = visible.find(asset => asset.id === selectedId) || visible[0]
  const current = selected?.id === displayedAssetId
  const protectedSelection = selected ? current || protectedIds.has(selected.id) : false
  const selectedArchived = selected ? archived.has(selected.id) : false
  const close = () => { if (!busy && !action.locked.current && !previewOpen) onClose() }
  const chooseFilter = (next: 'active' | 'archived') => { if (!busy && !action.locked.current) { setFilter(next); action.setError('') } }
  return <Modal opened onClose={close} centered size={1000} radius={16} title={`分镜图候选 · ${title}`}
    trapFocus={!previewOpen}
    closeOnClickOutside={!locked && !previewOpen} closeOnEscape={!locked && !previewOpen} closeButtonProps={{ disabled: locked, 'aria-label': '关闭分镜图候选' }}
    classNames={{ content: 'pc-confirm-modal pc-shot-candidate-modal', header: 'pc-confirm-modal-header', body: 'pc-confirm-modal-body', close: 'pc-confirm-modal-close' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
    <div className="pc-shot-candidate-manager">
      <div className="pc-shot-candidate-filters" role="group" aria-label="分镜候选图范围">
        <UnstyledButton type="button" disabled={locked} aria-pressed={filter === 'active'} onClick={() => chooseFilter('active')}>候选图 · {all.filter(asset => !archived.has(asset.id)).length}</UnstyledButton>
        <UnstyledButton type="button" disabled={locked} aria-pressed={filter === 'archived'} onClick={() => chooseFilter('archived')}>已归档 · {all.filter(asset => archived.has(asset.id)).length}</UnstyledButton>
      </div>
      {action.error && <p className="pc-shot-candidate-error" role="alert">{action.error}</p>}
      {selected ? <div className="pc-shot-candidate-workspace">
        <div className="pc-shot-candidate-grid" aria-label="分镜候选图列表">{visible.map((asset, index) => <UnstyledButton type="button" key={asset.id} disabled={locked} aria-label={`查看分镜候选图 ${index + 1}`} aria-pressed={selected.id === asset.id}
          onClick={() => { if (!busy && !action.locked.current) { setSelectedId(asset.id); action.setError('') } }}>
          <img src={asset.url} alt={asset.filename} loading="lazy" /><span>{asset.id === displayedAssetId ? <><Check size={12} />当前使用</> : `候选 ${index + 1}`}</span>
        </UnstyledButton>)}</div>
        <div className="pc-shot-candidate-detail">
          <UnstyledButton type="button" className="pc-shot-candidate-preview" disabled={locked} aria-label="放大查看分镜候选图" onClick={() => { if (!busy && !action.locked.current) onPreview(selected) }}>
            <img src={selected.url} alt={selected.filename} /><span><Expand size={14} />放大查看</span>
          </UnstyledButton>
          <div className="pc-shot-candidate-meta"><strong>{title}</strong><span>{selected.source === 'upload' ? '本地上传' : models.find(model => model.id === selected.model_id)?.name || '生成图片'}</span><time dateTime={selected.created_at}>{new Date(selected.created_at).toLocaleString('zh-CN')}</time></div>
          <div className="pc-shot-candidate-actions">
            <Button variant="default" size="xs" leftSection={<Check size={14} />} loading={action.pending === 'use'} disabled={locked || generating || current || selectedArchived}
              onClick={() => { if (!busy && !generating && !selectedArchived && !current) void action.run('use', () => onUse(selected.id)) }}>{current ? '当前使用中' : '设为当前图片'}</Button>
            <Button variant="default" size="xs" leftSection={selectedArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />} loading={action.pending === 'archive'} disabled={locked || !selectedArchived && protectedSelection}
              onClick={() => { if (!busy && (selectedArchived || !protectedSelection)) void action.run('archive', () => onArchive(selected.id, !selectedArchived)) }}>{selectedArchived ? '恢复候选' : '归档候选'}</Button>
          </div>
          <p className="pc-shot-candidate-help">{selectedArchived ? '恢复候选后，可以将其设为当前图片。' : protectedSelection ? '当前使用或已入片的图片会保留在候选列表。' : '选中候选图后，点击“设为当前图片”应用到此节点。'}</p>
        </div>
      </div> : <div className="pc-shot-candidate-empty">{filter === 'archived' ? '暂无归档的分镜候选图' : '暂无候选图，生成分镜图后会出现在这里'}</div>}
      <p className="pc-shot-candidate-help">归档会收起候选图，可在“已归档”中恢复；原始图片会保留。</p>
    </div>
  </Modal>
}
