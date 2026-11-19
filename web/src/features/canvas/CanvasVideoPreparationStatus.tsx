import type { HandoffConflict } from '@video-studio/shared/media/video-handoff-conflict'
import { useEffect, useState } from 'react'
import { ActionIcon, Button } from '@mantine/core'
import { Check, CircleAlert, LoaderCircle, LocateFixed, RefreshCcw, X } from 'lucide-react'
import './canvas-video-preparation-status.css'

export type VideoPreparationStatus = {
  nodeId: string
  sourceNodeId: string
  title: string
  phase: 'running' | 'success' | 'error' | 'needs_confirmation'
  conflict?: HandoffConflict
  startedAt: number
  message?: string
}

type Props = {
  status: VideoPreparationStatus
  onLocate: () => void
  onRetry: () => void
  onResolve?: () => void
  onDismiss: () => void
  retryDisabled?: boolean
}

export default function CanvasVideoPreparationStatus({ status, onLocate, onRetry, onResolve, onDismiss, retryDisabled = false }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const running = status.phase === 'running'
  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000)))
    update()
    if (!running) return
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [running, status.startedAt])
  const title = running ? '正在理解本镜动作与台词' : status.phase === 'success' ? '动作与台词已就绪' : status.phase === 'needs_confirmation' ? '动作与声音需要确认' : '动作与台词分析失败'
  return <section className={`pc-video-preparation-status is-${status.phase}`} role="status" aria-label="视频准备状态" aria-live="polite" aria-atomic="false" data-canvas-overlay>
    <div className="pc-video-preparation-heading">
      <span className="pc-video-preparation-icon" aria-hidden="true">{running ? <LoaderCircle size={18} className="pc-video-preparation-spin" />
        : status.phase === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}</span>
      <strong>{title}</strong>
      {!running && <ActionIcon type="button" variant="subtle" color="gray" size="sm" aria-label="关闭视频准备状态" onClick={onDismiss} data-workspace-control=""><X size={14} /></ActionIcon>}
    </div>
    <p className="pc-video-preparation-node" title={status.title}>{status.title || '当前镜头'}</p>
    {running ? <div className="pc-video-preparation-progress" aria-live="off">
      <span>已等待 {elapsed} 秒</span>
      <p>{elapsed >= 60 ? '模型仍在分析，完成后会在这里更新状态。' : '正在整理动作、运镜与声音方案，完成后将写入视频提示词。'}</p>
    </div> : status.message && <p className="pc-video-preparation-message">{status.message}</p>}
    <div className="pc-video-preparation-actions">
      {status.phase === 'needs_confirmation' ? <><Button type="button" size="compact-xs" variant="light" color="orange" onClick={status.conflict?.shot_id ? onResolve : onLocate}>{status.conflict?.shot_id ? '查看证据并解决' : '编辑来源图片'}</Button><Button type="button" size="compact-xs" variant="subtle" onClick={onLocate}>定位来源</Button></> : status.phase === 'error' ? <Button type="button" size="compact-xs" variant="light" color="gray" leftSection={<RefreshCcw size={13} />} disabled={retryDisabled} onClick={onRetry}>重新分析</Button>
        : <Button type="button" size="compact-xs" variant="subtle" color="gray" leftSection={<LocateFixed size={13} />} onClick={onLocate}>{running ? '定位节点' : '查看视频节点'}</Button>}
    </div>
  </section>
}
