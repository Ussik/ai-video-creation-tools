import { Button, UnstyledButton } from '@mantine/core'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Clock3, FileText, Layers3, RotateCcw } from 'lucide-react'
import { formatProcessingDuration } from './DirectorMessageTiming'
import { activityDepth, executionView, type ScriptActivity, type ScriptExecution } from './director-activity'
import { activityCalls, activityDuration, activityPresentation, activitySequence } from './director-activity-view'
import { ActivityCallDetails, ActivityStatusIcon, ActivityTargets } from './DirectorActivityDetails'
import type { ScriptActivityTarget } from '@video-studio/shared/script/script-activity-types'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { scriptDiagnosticDisplayText } from './script-display-text'
import DirectorTaskPreview from './DirectorTaskPreview'
import './director-activity.css'

export default function DirectorActivity({ activity, execution, pending, failed, disabled, onOpenDraft, onOpenDocuments, onOpenSource, onRetry, onRecover, onStop, onContinue }: {
  activity?: ScriptActivity[]; execution?: ScriptExecution; pending?: boolean; failed?: boolean; disabled?: boolean;
  onOpenDraft?: () => void; onOpenDocuments?: () => void; onOpenSource?: (source: ScriptActivityTarget) => void;
  onContinue?: () => void; onRetry?: () => void; onRecover?: () => void; onStop?: () => void;
}) {
  const view = executionView(activity, execution, pending, failed)
  const [expanded, setExpanded] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!pending) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  if (!view.events.length && !execution) return null
  const sequence = activitySequence(view.events)
  const active = sequence.active?.event
  const current = sequence.current?.event
  const activeMs = active ? Math.max(0, now - active.started_at) : 0
  const waiting = pending && active?.kind === 'model' && activeMs >= 45_000
  const interrupted = view.state === 'failed' || view.state === 'cancelled'
  const summary = scriptDiagnosticDisplayText(pending ? active?.summary || '正在准备项目资料和对话内容' : view.outcome?.summary || (interrupted ? '本轮没有返回完整结果，可先检查已有成果。' : '本轮回复已返回，可在下方查看。'))
  const currentLabel = current?.label || active?.label || '准备创作请求'
  const preview = view.events.find(event => event.id === previewId && event.artifact_preview)
  return <section className={`sd-activity is-${view.state}`} aria-label="本条回复的任务进度">
    <header className="sd-activity-head"><div className="sd-activity-heading"><span className="sd-activity-eyebrow">本轮任务</span><strong>{execution?.title || '本轮任务'}</strong></div>
      <span className={`sd-activity-state is-${view.state}`}>{pending && <Clock3 size={11} />}{view.stateLabel}</span>
    </header>
    {execution?.targets?.length ? <p className="sd-activity-scope">处理范围：{execution.targets.join('、')}</p> : execution?.request && <p className="sd-activity-request" title={execution.request}>{execution.request}</p>}
    {pending ? <div className="sd-activity-current" role="status"><span className="sd-activity-current-dot" /><div><strong>{currentLabel}</strong><p>{summary}</p></div>
      {active && <time title="当前步骤已用时">{formatProcessingDuration(activeMs)}</time>}
    </div> : <p className="sd-activity-result">{summary}</p>}
    {pending && onStop && <div className="sd-activity-wait">{waiting && <span>当前步骤仍在处理中，已等待 {formatProcessingDuration(activeMs)}。</span>}<Button type="button" onClick={onStop} data-workspace-control="" variant="subtle">停止任务</Button></div>}
    {!pending && onContinue && <Button type="button" disabled={disabled} onClick={onContinue} variant="light" size="xs">继续未完成步骤</Button>}
    {!!view.stats.length && <p className="sd-activity-stats">{view.stats.join(' · ')}</p>}
    {!!sequence.tasks.length && <div className="sd-activity-plan"><strong className="sd-activity-plan-heading">任务与成果</strong><ol className="sd-activity-tasks" aria-label="本轮任务清单">{sequence.tasks.map(node => {
      const { status, label } = activityPresentation(node, pending)
      const duration = activityDuration(node.event, now, pending)
      return <li className={`sd-activity-task is-${status}${activityDepth(node.event, view.events) ? ' is-child' : ''}`} key={node.event.id} data-activity-id={node.event.id} title={scriptDiagnosticDisplayText(node.event.summary)}>
        <div className="sd-activity-row"><span className={`sd-activity-icon is-${status}`}><ActivityStatusIcon status={status} hasActiveChildren={node.waiting} /></span><strong className="sd-activity-title">{node.event.label}</strong><span className="sd-activity-status">{label}</span>
          {typeof duration === 'number' && <time title="任务用时（包含内部步骤）">{formatProcessingDuration(duration)}</time>}</div>
        <p className="sd-activity-summary">{status === 'unconfirmed' ? '已保留处理记录，可继续未完成步骤。' : scriptDiagnosticDisplayText(node.event.summary)}</p>
        <ActivityTargets events={[node.event]} onOpenSource={onOpenSource} />
        {node.event.artifact_preview && <Button type="button" className="sd-activity-preview" variant="subtle" size="compact-xs" onClick={() => setPreviewId(node.event.id)}><FileText size={12} />预览成果<ChevronRight size={12} /></Button>}
      </li>
    })}</ol></div>}
    {!!(sequence.steps.length || sequence.notices.length) && <UnstyledButton type="button" className="sd-activity-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span>{sequence.steps.length ? expanded ? '收起执行步骤' : '查看执行步骤' : expanded ? '收起处理提示' : '查看处理提示'}</span>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </UnstyledButton>}
    {expanded && <>{!!sequence.steps.length && <ol className="sd-activity-steps" aria-label="按执行顺序排列的步骤">{sequence.steps.map((node, index) => {
      const { event } = node, { status, label } = activityPresentation(node, pending)
      const duration = activityDuration(event, now, pending)
      return <li className={`sd-activity-step is-${event.kind}${event.scope === 'task' ? ' is-task' : ''}`} key={event.id} data-activity-id={event.id}>
        <div className="sd-activity-step-number" aria-hidden="true">{index + 1}</div>
        <div className="sd-activity-step-content">
          <div className="sd-activity-row"><span className={`sd-activity-icon is-${status}`}><ActivityStatusIcon status={status} hasActiveChildren={node.waiting} /></span>
            <span className="sd-activity-title">{event.kind === 'skill' && <Layers3 size={12} />}{event.label}</span>
            <span className="sd-activity-status">{label}</span>
            {event.kind !== 'skill' && typeof duration === 'number' && <time>{formatProcessingDuration(duration)}</time>}
          </div>
          <p className="sd-activity-summary">{status === 'unconfirmed' ? '本轮已结束，但未收到此步骤的完成记录。' : scriptDiagnosticDisplayText(event.summary)}</p>
          <ActivityTargets events={[event, ...activityCalls(node).map(call => call.node.event)]} onOpenSource={onOpenSource} />
          <ActivityCallDetails step={node} now={now} pending={pending} onOpenSource={onOpenSource} />
        </div>
      </li>
    })}</ol>}
      {!!sequence.notices.length && <WorkspaceDisclosure className="sd-activity-notices" label={<><span>过程提示</span><small>{sequence.notices.length} 条</small></>}>
        <ul className="sd-activity-notice-list" aria-label="过程提示">{sequence.notices.map(({ event }) => <li key={event.id} data-activity-id={event.id}>
          <strong>{event.label}</strong><p>{scriptDiagnosticDisplayText(event.summary)}</p>
        </li>)}</ul>
      </WorkspaceDisclosure>}
    </>}
    {!pending && <div className="sd-activity-actions">
      {onOpenDraft && <Button type="button" className="sd-activity-action-primary" disabled={disabled} onClick={onOpenDraft} data-workspace-control="" variant="subtle"><FileText size={13} />{view.state === 'saved' ? '查看保存结果' : '查看并编辑草稿'}<ChevronRight size={13} /></Button>}
      {view.state === 'saved' && !onOpenDraft && onOpenDocuments && <Button type="button" disabled={disabled} onClick={onOpenDocuments} data-workspace-control="" variant="subtle">查看项目文档<ChevronRight size={13} /></Button>}
      {['draft', 'partial'].includes(view.state) && !onOpenDraft && onRecover && <Button type="button" disabled={disabled} onClick={onRecover} data-workspace-control="" variant="subtle">检查草稿与保存结果<ChevronRight size={13} /></Button>}
      {interrupted && (view.canRetry && onRetry ? <Button type="button" disabled={disabled} onClick={onRetry} data-workspace-control="" variant="subtle"><RotateCcw size={12} />重试本轮</Button>
        : onRecover && <Button type="button" disabled={disabled} onClick={onRecover} data-workspace-control="" variant="subtle">检查草稿与保存结果<ChevronRight size={13} /></Button>)}
    </div>}
    <DirectorTaskPreview key={preview?.id || 'closed'} activity={preview} onClose={() => setPreviewId(null)} />
  </section>
}
