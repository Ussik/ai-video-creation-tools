import { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'

export type MessageTiming = {
  processing_started_at?: number
  processing_duration_ms?: number | null
}

export function finishMessageTiming(startedAt: number, finishedAt = performance.now()): MessageTiming {
  return { processing_started_at: undefined, processing_duration_ms: Math.max(0, Math.round(finishedAt - startedAt)) }
}

export function formatProcessingDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${(Math.floor(durationMs / 100) / 10).toFixed(1)} 秒`
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`
}

export default function DirectorMessageTiming({ pending, processing_started_at: startedAt, processing_duration_ms: completed }: MessageTiming & { pending?: boolean }) {
  const [now, setNow] = useState(() => performance.now())
  const running = Boolean(pending && typeof startedAt === 'number' && Number.isFinite(startedAt))
  useEffect(() => {
    if (!running) return
    setNow(performance.now())
    const timer = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  const duration = running ? Math.max(0, now - startedAt!) : completed
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null
  return <div className="sd-message-timing" title="从提交请求到本条回复结束的处理用时">
    <Clock3 size={12} aria-hidden="true" /><span>{running ? '处理中' : '用时'} {formatProcessingDuration(duration)}</span>
  </div>
}
