import { Button } from '@mantine/core'
import { Check, ChevronRight, CircleAlert, Clock3, FileText, LoaderCircle, Square } from 'lucide-react'
import type { ScriptActivityTarget } from '@video-studio/shared/script/script-activity-types'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { formatProcessingDuration } from './DirectorMessageTiming'
import { activitySources, type ScriptActivity } from './director-activity'
import { activityCalls, activityDuration, activityPresentation, type ActivityDisplayStatus, type ActivityNode } from './director-activity-view'
import { scriptDiagnosticDisplayText } from './script-display-text'

export function ActivityStatusIcon({ status, notice, hasActiveChildren }: { status: ActivityDisplayStatus; notice?: boolean; hasActiveChildren?: boolean }) {
  if (notice || hasActiveChildren || status === 'waiting' || status === 'unconfirmed') return <Clock3 size={13} />
  return status === 'running' ? <LoaderCircle size={13} className="script-director-spinner" /> : status === 'failed' ? <CircleAlert size={13} /> : status === 'cancelled' ? <Square size={11} /> : <Check size={13} />
}

export function ActivityTargets({ events, onOpenSource }: { events: ScriptActivity[]; onOpenSource?: (source: ScriptActivityTarget) => void }) {
  const targets = activitySources(events)
  return !!targets.length && <div className="sd-activity-targets">{targets.map(target => target.kind === 'document' && onOpenSource
    ? <Button type="button" key={`${target.kind}:${target.id}`} onClick={() => onOpenSource(target)} data-workspace-control="" variant="subtle"><FileText size={11} />{target.title}<ChevronRight size={11} /></Button>
    : <span key={`${target.kind}:${target.id}`}>{target.title}</span>)}</div>
}

function ActivityMetadata({ event, now, pending }: { event: ScriptActivity; now: number; pending?: boolean }) {
  const duration = activityDuration(event, now, pending)
  return <div className="sd-activity-detail-body">
    <p><span>{event.scope === 'task' ? '阶段任务' : event.kind === 'tool' ? '工具' : event.kind === 'skill' ? '创作规则' : event.kind === 'model' ? '模型' : '步骤'}</span><code>{event.name || event.label}</code></p>
    {event.started_at > 0 && <p><span>开始时间</span><time dateTime={new Date(event.started_at).toISOString()}>{new Date(event.started_at).toLocaleTimeString('zh-CN', { hour12: false })}</time>{typeof duration === 'number' && <small>{event.status === 'running' ? '已用时' : '用时'} {formatProcessingDuration(duration)}</small>}</p>}
    {event.step_id && <p><span>步骤标识</span><code>{event.step_id}</code></p>}
    {event.reused && <p className="sd-activity-note">已沿用此前完成的结果，继续处理后续任务。</p>}
    {event.kind === 'skill' && <><p className="sd-activity-note">此 Skill 的规则和资料已提供给模型。</p>{event.revision && <p><span>版本</span><code>{event.revision.slice(0, 12)}</code></p>}
      {!!event.files?.length && <div className="sd-activity-files"><span>已加载文件</span>{event.files.map((file, i) => <code key={`${file}-${i}`}>{file}</code>)}</div>}</>}
    {event.kind === 'tool' && event.name === 'get_project_visual_style' && event.output !== undefined && <p className="sd-activity-note">以下是调用当时已保存的设置，之后的画风保存会另有记录。</p>}
    {event.input !== undefined && <div className="sd-activity-payload"><label>调用参数{event.input_truncated ? '（前 4000 字）' : ''}</label><pre>{event.input}</pre></div>}
    {event.output !== undefined && <div className="sd-activity-payload"><label>{event.kind === 'model' ? '模型公开回复' : '返回结果'}{event.output_truncated ? '（前 4000 字）' : ''}</label><pre>{event.output}</pre></div>}
  </div>
}

export function ActivityCallDetails({ step, now, pending, onOpenSource }: { step: ActivityNode; now: number; pending?: boolean; onOpenSource?: (source: ScriptActivityTarget) => void }) {
  const calls = activityCalls(step)
  return <WorkspaceDisclosure className="sd-activity-calls" label={<><span>调用详情</span>{!!calls.length && <small>{calls.length} 条记录</small>}</>}>
    <p className="sd-activity-note">{calls.length ? '步骤用时包含内部调用，不与调用用时相加。' : '此处展示实际调用参数、公开返回和用时。'}不包含模型内部推理。</p>
    <ActivityMetadata event={step.event} now={now} pending={pending} />
    {!!calls.length && <ol className="sd-activity-call-list">{calls.map(({ node, depth }) => {
      const { event } = node, { status, label } = activityPresentation(node, pending)
      const duration = activityDuration(event, now, pending)
      return <li key={event.id} className={`sd-activity-call is-${event.kind}${depth ? ` is-child is-depth-${Math.min(depth, 2)}` : ''}`} data-activity-id={event.id}>
        <WorkspaceDisclosure className="sd-activity-detail" label={<><span className={`sd-activity-icon is-${status}`}><ActivityStatusIcon status={status} hasActiveChildren={node.waiting} /></span><span className="sd-activity-title">{event.label}</span><span className="sd-activity-status">{label}</span>{typeof duration === 'number' && <time>{formatProcessingDuration(duration)}</time>}</>}>
          <p className="sd-activity-summary">{scriptDiagnosticDisplayText(event.summary)}</p>
          <ActivityTargets events={[event]} onOpenSource={onOpenSource} />
          <ActivityMetadata event={event} now={now} pending={pending} />
        </WorkspaceDisclosure>
      </li>
    })}</ol>}
  </WorkspaceDisclosure>
}
