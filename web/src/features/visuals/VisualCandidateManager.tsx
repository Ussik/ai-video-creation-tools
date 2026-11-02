import { useEffect, useRef, useState } from 'react'
import { UnstyledButton, Button, Modal } from '@mantine/core'
import { Archive, ArchiveRestore, Check, ExternalLink, Save, X } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { Model, ProjectDetail, VisualProfile } from '../../shared/api/api'
import { visualCandidateAssets, visualJobRequest } from '../canvas/canvas-visual-profiles'
import { visualAssetStyleWarning } from './visual-asset-style'

type Props = { profile: VisualProfile; detail: ProjectDetail; models: Model[]; displayedAssetId?: string | null;
  generating: boolean; onConfirm: (assetId: string) => Promise<void>; onRefresh: () => Promise<void>; onClose: () => void;
  onError?: (issue: unknown) => void }

export default function VisualCandidateManager({ profile, detail, models, displayedAssetId, generating, onConfirm, onRefresh, onClose, onError }: Props) {
  const candidates = visualCandidateAssets(profile, detail, displayedAssetId)
  const archived = new Set(profile.archived_candidate_asset_ids || [])
  const [filter, setFilter] = useState<'active' | 'archived'>('active')
  const [selectedId, setSelectedId] = useState(displayedAssetId || profile.board_asset_id || candidates.find(asset => !archived.has(asset.id))?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actionLocked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const visible = candidates.filter(asset => archived.has(asset.id) === (filter === 'archived'))
  const selected = visible.find(asset => asset.id === selectedId) || visible[0]
  const job = detail.jobs.find(item => item.result_asset_id === selected?.id)
  const request = visualJobRequest(job)
  const styleWarning = selected ? visualAssetStyleWarning(detail, selected.id, 0, [], profile.id) : null
  const needsStyleReview = profile.board_style_status === 'needs_review' || profile.board_style_status === 'unrecorded' || !!styleWarning
  async function action(run: () => Promise<void>) {
    if (actionLocked.current) return
    actionLocked.current = true
    setBusy(true); setError('')
    try { await run() } catch (issue) {
      if (mounted.current) setError(issue instanceof Error ? issue.message : String(issue))
      else onError?.(issue)
    } finally {
      actionLocked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  // Dismissing this viewer does not cancel submitted changes or their refresh.
  return <Modal opened onClose={onClose} centered size={960} radius={16} title={`设定图候选 · ${profile.name}`}
    closeButtonProps={{ 'aria-label': '关闭设定图候选', size: 32, icon: <X size={18} /> }}
    classNames={{ content: 'pc-confirm-modal pc-candidate-modal', header: 'pc-confirm-modal-header', body: 'pc-confirm-modal-body', close: 'pc-confirm-modal-close' }}>
    <div className="pc-candidate-manager">
      <div className="pc-candidate-filters" role="group" aria-label="候选图范围">
        <UnstyledButton type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>候选图 · {candidates.filter(asset => !archived.has(asset.id)).length}</UnstyledButton>
        <UnstyledButton type="button" aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>已归档 · {candidates.filter(asset => archived.has(asset.id)).length}</UnstyledButton>
      </div>
      {busy && <p className="pc-candidate-help" role="status">正在处理，关闭窗口后仍会继续完成。</p>}
      {error && <p className="pc-candidate-error" role="alert">{error}</p>}
      {selected ? <div className="pc-candidate-workspace">
        <div className="pc-candidate-grid" aria-label="候选图列表">{visible.map((asset, index) => <UnstyledButton type="button" key={asset.id} aria-label={`查看候选图 ${index + 1}`} aria-pressed={selected.id === asset.id} onClick={() => setSelectedId(asset.id)}>
          <img src={asset.url} alt={asset.filename} /><span>{asset.id === profile.board_asset_id ? <><Check size={12} />已确认</> : `候选 ${index + 1}`}</span>
        </UnstyledButton>)}</div>
        <div className="pc-candidate-detail">
          <a className="pc-candidate-large-image" href={selected.url} target="_blank" rel="noreferrer" aria-label="打开候选图原图"><img src={selected.url} alt={selected.filename} /><ExternalLink size={16} /></a>
          <div className="pc-candidate-meta"><strong>{profile.name} · {profile.variant}</strong><span>{selected.source === 'upload' ? '本地上传' : models.find(model => model.id === selected.model_id)?.name || '生成图片'}{typeof request.visual_profile_revision === 'number' ? ` · 生成于 v${request.visual_profile_revision}` : ''}</span><time>{new Date(selected.created_at).toLocaleString('zh-CN')}</time></div>
          {needsStyleReview && <p className="pc-candidate-help" role="status">{styleWarning ? `${styleWarning.replace(/^参考图 1/, '此候选图')} ` : ''}请核对图片是否符合当前项目画风，再确认使用。确认不会重绘图片。</p>}
          <div className="pc-candidate-actions">
            <Button variant="default" size="xs" leftSection={<Check size={14} />} disabled={busy || generating || selected.id === profile.board_asset_id && !needsStyleReview} onClick={() => void action(() => onConfirm(selected.id))}>{selected.id === profile.board_asset_id ? needsStyleReview ? '核对并重新确认' : '已确认使用' : '确认使用'}</Button>
            <Button variant="default" size="xs" leftSection={<Save size={14} />} disabled={busy || selected.saved} onClick={() => void action(async () => { await api(`/assets/${selected.id}/save`, { method: 'POST' }); await onRefresh() })}>{selected.saved ? '已保存到资产' : '保存到资产'}</Button>
            <Button variant="default" size="xs" leftSection={archived.has(selected.id) ? <ArchiveRestore size={14} /> : <Archive size={14} />} disabled={busy || selected.id === profile.board_asset_id} onClick={() => void action(async () => { await api(`/visual-profiles/${profile.id}/candidates/${selected.id}`, json('PUT', { archived: !archived.has(selected.id) })); await onRefresh() })}>{archived.has(selected.id) ? '恢复候选' : '归档候选'}</Button>
          </div>
        </div>
      </div> : <div className="pc-candidate-empty">{filter === 'archived' ? '暂无归档的候选图' : '暂无候选图，生成或上传设定图后会出现在这里'}</div>}
      <p className="pc-candidate-help">归档后会从节点候选列表收起，可在“已归档”中恢复。</p>
    </div>
  </Modal>
}
