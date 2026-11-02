import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Loader, Modal } from '@mantine/core'
import { AlertCircle, Trash2 } from 'lucide-react'
import type { CanvasDeletionInput, CanvasDeletionPreview } from '@video-studio/shared/storyboard/shot-management'
import { api, json } from '../../shared/api/api'
import type { ProjectCanvasInfo } from './project-canvases'
import './canvas-deletion-dialog.css'

export type { CanvasDeletionPreview } from '@video-studio/shared/storyboard/shot-management'

export type CanvasDeletionResult = { canvas_id: string }

type Props = {
  projectId: string
  canvas: ProjectCanvasInfo
  onClose: () => void
  onDeleted: (result: CanvasDeletionResult) => void
}

export default function CanvasDeletionDialog({ projectId, canvas, onClose, onDeleted }: Props) {
  const [preview, setPreview] = useState<CanvasDeletionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [cleanupShots, setCleanupShots] = useState(false)
  const [cleanupAssets, setCleanupAssets] = useState(false)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState(false)
  const mounted = useRef(false)
  const operation = useRef(false)
  const path = `/projects/${projectId}/canvases/${canvas.id}`

  async function loadPreview() {
    setLoading(true)
    try {
      const value = await api<CanvasDeletionPreview>(`${path}/deletion-preview`)
      if (mounted.current) setPreview(value)
    } finally { if (mounted.current) setLoading(false) }
  }

  useEffect(() => {
    mounted.current = true
    void loadPreview().catch(issue => { if (mounted.current) setError(issue instanceof Error ? issue.message : String(issue)) })
    return () => { mounted.current = false }
  }, [path])

  async function remove() {
    if (!preview || operation.current || loading) return
    operation.current = true
    setDeleting(true); setError('')
    try {
      const input: CanvasDeletionInput = {
        revision: preview.revision, cleanup_revision: preview.cleanup_revision,
        cleanup_shots: cleanupShots, cleanup_assets: cleanupAssets,
      }
      const result = await api<CanvasDeletionResult>(path, json('DELETE', input))
      if (mounted.current) onDeleted(result)
    } catch (issue) {
      if (!mounted.current) return
      if ((issue as { status?: number }).status === 409) {
        // Reconfirm the new affected content; never replay a destructive request.
        setPreview(null); setCleanupShots(false); setCleanupAssets(false); setChanged(true)
        try { await loadPreview() }
        catch (refreshIssue) { if (mounted.current) setError(`影响范围读取失败：${refreshIssue instanceof Error ? refreshIssue.message : String(refreshIssue)}`) }
      } else setError(issue instanceof Error ? issue.message : String(issue))
    } finally {
      operation.current = false
      if (mounted.current) setDeleting(false)
    }
  }

  return <Modal opened onClose={() => { if (!deleting) onClose() }} title={`删除画布「${canvas.name}」`} size="lg" centered
    closeOnClickOutside={!deleting} closeOnEscape={!deleting} closeButtonProps={{ disabled: deleting, 'aria-label': '关闭删除画布' }}
    classNames={{ content: 'canvas-deletion-modal', body: 'canvas-deletion-body' }}>
    <div className="canvas-deletion-content">
      {changed && <Alert icon={<AlertCircle size={17} />} color="orange" role="status">画布或引用关系已更新。已刷新影响范围，请重新选择清理项并确认。</Alert>}
      {error && <Alert icon={<AlertCircle size={17} />} color="red" role="alert">{error}</Alert>}
      {loading ? <div className="canvas-deletion-loading" role="status"><Loader size="sm" /><span>正在检查画布及关联内容</span></div>
        : preview ? <>
          <p className="canvas-deletion-summary">将删除 <strong>{preview.node_count}</strong> 个节点、<strong>{preview.edge_count}</strong> 条连线，以及这张画布的布局和本地草稿。</p>
          <section className="canvas-deletion-options" aria-label="可选清理内容">
            <Checkbox label={`同时将独占的 ${preview.exclusive_shots.length} 个分镜移入回收站`} checked={cleanupShots}
              disabled={deleting || !preview.exclusive_shots.length} onChange={event => setCleanupShots(event.currentTarget.checked)}
              description="默认保留分镜，可在分镜管理中继续使用。" />
            {preview.exclusive_shots.length > 0 && <ul className="canvas-deletion-items" aria-label="可清理的独占分镜">{preview.exclusive_shots.map(shot => <li key={shot.id}>{shot.title || '未命名分镜'}</li>)}</ul>}
            <Checkbox label={`同时将独占的 ${preview.exclusive_assets.length} 个未保存候选移入回收站`} checked={cleanupAssets}
              disabled={deleting || !preview.exclusive_assets.length} onChange={event => setCleanupAssets(event.currentTarget.checked)}
              description="回收后可恢复，素材文件不会被永久删除。" />
            {preview.exclusive_assets.length > 0 && <ul className="canvas-deletion-items" aria-label="可清理的独占候选">{preview.exclusive_assets.map(asset => <li key={asset.id}>{asset.filename}</li>)}</ul>}
          </section>
          <section className="canvas-deletion-preserved" aria-label="保留的项目内容">
            <strong>{preview.protected_asset_count} 个受保护素材将保留</strong>
            <p>已保存、共享或被成片引用的素材，以及项目剧本和视觉设定都会保留。</p>
            <p>{preview.running_job_count > 0 ? `${preview.running_job_count} 个生成任务仍在运行，` : ''}生成任务记录会保留在任务中心。</p>
          </section>
        </> : !error && <p>暂无可用的删除影响信息。</p>}
    </div>
    <div className="canvas-deletion-actions">
      <Button variant="default" disabled={deleting} onClick={onClose}>取消</Button>
      {!preview && !loading && <Button variant="default" onClick={() => { setError(''); void loadPreview().catch(issue => { if (mounted.current) setError(issue instanceof Error ? issue.message : String(issue)) }) }}>重新检查</Button>}
      <Button color="red" leftSection={<Trash2 size={16} />} loading={deleting} disabled={!preview || loading} onClick={() => void remove()}>删除画布</Button>
    </div>
  </Modal>
}
