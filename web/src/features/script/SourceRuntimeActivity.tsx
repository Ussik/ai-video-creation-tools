import { Check, CircleAlert, Clock3, LoaderCircle, Minus } from 'lucide-react'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { formatProcessingDuration } from './DirectorMessageTiming'

type RuntimeEvent = NonNullable<ScriptSourceAnalysis['runtime_events']>[number]
const recentStepCount = 4
const statusIcons = { running: LoaderCircle, succeeded: Check, failed: CircleAlert, cancelled: Minus, queued: Clock3 }
const statusLabels = { running: '进行中', succeeded: '已完成', failed: '未完成', cancelled: '已中止', queued: '等待执行' }

function RuntimeSteps({ events, queued = false }: { events: RuntimeEvent[]; queued?: boolean }) {
  return <ol className="sd-analysis-runtime-steps" role="list">
    {events.map(event => {
      const status = queued && event.status === 'running' ? 'queued' : event.status
      const Icon = statusIcons[status]
      const duration = (event.ended_at ?? event.started_at) - event.started_at
      const elapsed = Number.isFinite(duration) && duration >= 1000 ? formatProcessingDuration(duration) : null
      return <li key={event.id} data-state={status} aria-current={status === 'running' ? 'step' : undefined}>
        <span className="sd-runtime-marker" role="img" aria-label={event.stage === 'paused' ? '已暂停' : statusLabels[status]}>
          <Icon size={12} className={status === 'running' ? 'script-director-spinner' : undefined} aria-hidden="true" />
        </span>
        <span className="sd-runtime-label">{event.label}</span>
        {elapsed && <small className="sd-runtime-duration" aria-label={`用时 ${elapsed}`}>{elapsed}</small>}
      </li>
    })}
  </ol>
}

/** Observed execution steps, subordinate to the single source task status. */
export default function SourceRuntimeActivity({ analysis }: { analysis: ScriptSourceAnalysis }) {
  const events = analysis.runtime_events
  if (!events?.length) return null
  const earlierCount = Math.max(0, events.length - recentStepCount)
  return <WorkspaceDisclosure className="sd-analysis-runtime" initiallyOpen label={`处理步骤（${events.length}）`}>
    {earlierCount > 0 && <WorkspaceDisclosure className="sd-runtime-history" label={`更早的 ${earlierCount} 条步骤`}>
      <RuntimeSteps events={events.slice(0, earlierCount)} />
    </WorkspaceDisclosure>}
    <RuntimeSteps events={events.slice(earlierCount)} queued={analysis.status === 'queued'} />
    {!!analysis.runtime_events_omitted && <small className="sd-runtime-omitted">还有 {analysis.runtime_events_omitted} 条较早记录已归并</small>}
  </WorkspaceDisclosure>
}
