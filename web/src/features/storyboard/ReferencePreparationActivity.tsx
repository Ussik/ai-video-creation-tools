import { useEffect, useRef, useState } from 'react'
import { Loader } from '@mantine/core'
import type { CanvasPreparationRecovery } from '@video-studio/shared/api/contracts'
import './ReferencePreparationActivity.css'

type Props = { capabilities?: CanvasPreparationRecovery; activity?: string; preparing?: boolean }

/** Compact activity for both canvas-entry footers; server heartbeats never reset its clock. */
export default function ReferencePreparationActivity({ capabilities, activity, preparing }: Props) {
  const [now, setNow] = useState(Date.now)
  const fallback = useRef({ runId: capabilities?.run_id, startedAt: Date.now() })
  if (fallback.current.runId !== capabilities?.run_id) fallback.current = { runId: capabilities?.run_id, startedAt: Date.now() }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const serverStart = capabilities?.state === 'running' && capabilities.inspection?.started_at
    ? Date.parse(capabilities.inspection.started_at) : NaN
  const startedAt = Number.isFinite(serverStart) && serverStart >= 0 && serverStart <= Date.now() ? serverStart : fallback.current.startedAt
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const localActivity = activity?.trim()
  const current = (preparing || !localActivity ? capabilities?.inspection?.progress?.label.trim() : undefined) || localActivity || '正在准备画布'
  const label = current.startsWith('正在') ? current : `正在${current}`
  return <div className="reference-preparation-activity" role="status" aria-label="画布准备进度">
    <Loader size={14} aria-hidden="true" /><span>{label} · {seconds} 秒</span>
  </div>
}
