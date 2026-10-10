import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, FileText, Layers3, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { formatProcessingDuration } from './DirectorMessageTiming'
import { activitySources, executionView, type ScriptActivity, type ScriptExecution } from './director-activity'
import type { ScriptActivityTarget } from '../../backend/src/script-activity-types'
import './director-activity.css'

const statusLabels = { running: '进行中', succeeded: '已完成', failed: '未完成', cancelled: '已停止' }
const groupLabels = { sources: '查阅资料', rules: '专业规则', model: '模型处理', results: '草稿与操作' }
function StatusIcon({ status }: { status: ScriptActivity['status'] }) {
  return status === 'running' ? <LoaderCircle size={13} className="script-director-spinner" /> : status === 'failed' ? <CircleAlert size={13} /> : status === 'cancelled' ? <Square size={11} /> : <Check size={13} />
}

export default function DirectorActivity({ activity, execution, pending, failed, disabled, onOpenDraft, onOpenDocuments, onOpenSource, onRetry, onRecover, onStop }: {
  activity?: ScriptActivity[]; execution?: ScriptExecution; pending?: boolean; failed?: boolean; disabled?: boolean;
  onOpenDraft?: () => void; onOpenDocuments?: () => void; onOpenSource?: (source: ScriptActivityTarget) => void;
  onRetry?: () => void; onRecover?: () => void; onStop?: () => void;
}) {
  const view = executionView(activity, execution, pending, failed)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!pending) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  if (!view.events.length && !execution) return null
  const active = view.active
  const activeMs = active ? Math.max(0, now - active.started_at) : 0
  const waiting = pending && active?.kind === 'model' && activeMs >= 45_000
  const interrupted = view.state === 'failed' || view.state === 'cancelled'
  const summary = pending ? active?.summary || '正在准备项目资料和对话内容' : view.outcome?.summary || (interrupted ? '本轮没有返回完整结果，可先检查已有成果。' : '本轮回复已返回，可在下方查看。')
  const currentLabel = active?.kind === 'model' && /^模型(?:继续)?处理/.test(active.label) ? '等待模型回复' : active?.label || '准备创作请求'
  return <section className={`sd-activity is-${view.state}`} aria-label="本条回复的任务进度">
    <header className="sd-activity-head"><div className="sd-activity-heading"><span className="sd-activity-eyebrow">本轮任务</span><strong>{execution?.title || '本轮任务'}</strong></div>
      <span className={`sd-activity-state is-${view.state}`}>{pending && <LoaderCircle size={11} className="script-director-spinner" />}{view.stateLabel}</span>
    </header>
    {execution?.targets?.length ? <p className="sd-activity-scope">处理范围：{execution.targets.join('、')}</p> : execution?.request && <p className="sd-activity-request" title={execution.request}>{execution.request}</p>}
    {pending ? <div className="sd-activity-current" role="status"><span className="sd-activity-current-dot" /><div><strong>{currentLabel}</strong><p>{summary}</p></div>
      {active && <time>{formatProcessingDuration(activeMs)}</time>}
    </div> : <p className="sd-activity-result">{summary}</p>}
    {waiting && <div className="sd-activity-wait"><span>本步尚未返回结果，已等待 {formatProcessingDuration(activeMs)}。</span>{onStop && <button type="button" onClick={onStop}>停止等待</button>}</div>}
    {!!view.stats.length && <p className="sd-activity-stats">{view.stats.join(' · ')}</p>}
    {!!view.events.length && <button type="button" className="sd-activity-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span>{expanded ? '收起执行步骤' : '查看执行步骤'}</span>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>}
    {expanded && <div className="sd-activity-steps">{view.groups.map(group => <section className={`sd-activity-group is-${group.key}`} key={group.key} aria-label={groupLabels[group.key]}>
      <h4>{groupLabels[group.key]}<span>{group.events.length}</span></h4>
      <ol>{group.events.map(event => {
        const duration = event.status === 'running' ? Math.max(0, now - event.started_at) : event.duration_ms
        const targets = activitySources([event])
        return <li className={`sd-activity-step is-${event.kind}`} key={event.id}>
          <div className="sd-activity-row"><span className={`sd-activity-icon is-${event.status}`}><StatusIcon status={event.status} /></span>
            <span className="sd-activity-title">{event.kind === 'skill' && <Layers3 size={12} />}{event.label}</span>
            <span className="sd-activity-status">{event.kind === 'skill' && event.status === 'succeeded' ? '规则已加载' : statusLabels[event.status]}</span>
            {event.kind !== 'skill' && typeof duration === 'number' && <time>{formatProcessingDuration(duration)}</time>}
          </div>
          <p className="sd-activity-summary">{event.summary}</p>
          {!!targets.length && <div className="sd-activity-targets">{targets.map(target => target.kind === 'document' && onOpenSource
            ? <button type="button" key={`${target.kind}:${target.id}`} onClick={() => onOpenSource(target)}><FileText size={11} />{target.title}<ChevronRight size={11} /></button>
            : <span key={`${target.kind}:${target.id}`}>{target.title}</span>)}</div>}
        </li>
      })}</ol>
    </section>)}</div>}
    {!!view.events.length && <details className="sd-activity-technical"><summary>技术详情<span>函数参数、返回结果与用时</span><ChevronDown size={12} /></summary>
      <p className="sd-activity-note">以下是实际调用记录和公开返回，不包含模型内部推理。</p>
      <div className="sd-activity-technical-list">{view.events.map(event => <details className="sd-activity-detail" key={event.id}>
        <summary><span className={`sd-activity-icon is-${event.status}`}><StatusIcon status={event.status} /></span><span className="sd-activity-title">{event.name || event.label}</span><span className="sd-activity-status">{statusLabels[event.status]}</span><ChevronDown size={12} /></summary>
        <div className="sd-activity-detail-body"><p>{event.summary}</p>
          <p><span>{event.kind === 'tool' ? 'Function' : event.kind === 'skill' ? 'Skill' : event.kind === 'model' ? '模型' : '系统'}</span><code>{event.name || event.label}</code>{event.round && <small>第 {event.round} 轮</small>}</p>
          {event.started_at > 0 && <p><span>开始时间</span><time dateTime={new Date(event.started_at).toISOString()}>{new Date(event.started_at).toLocaleTimeString('zh-CN', { hour12: false })}</time>{typeof event.duration_ms === 'number' && <small>用时 {formatProcessingDuration(event.duration_ms)}</small>}</p>}
          {event.kind === 'skill' && <><p className="sd-activity-note">此 Skill 的规则和资料已提供给模型。</p>{event.revision && <p><span>版本</span><code>{event.revision.slice(0, 12)}</code></p>}
            {!!event.files?.length && <div className="sd-activity-files"><span>已加载文件</span>{event.files.map((file, i) => <code key={`${file}-${i}`}>{file}</code>)}</div>}</>}
          {event.input !== undefined && <div className="sd-activity-payload"><label>调用参数{event.input_truncated ? '（前 4000 字）' : ''}</label><pre>{event.input}</pre></div>}
          {event.output !== undefined && <div className="sd-activity-payload"><label>{event.kind === 'model' ? '模型公开回复' : '返回结果'}{event.output_truncated ? '（前 4000 字）' : ''}</label><pre>{event.output}</pre></div>}
        </div>
      </details>)}</div>
    </details>}
    {!pending && <div className="sd-activity-actions">
      {onOpenDraft && <button type="button" className="sd-activity-action-primary" disabled={disabled} onClick={onOpenDraft}><FileText size={13} />{view.state === 'saved' ? '查看保存结果' : '查看并编辑草稿'}<ChevronRight size={13} /></button>}
      {view.state === 'saved' && !onOpenDraft && onOpenDocuments && <button type="button" disabled={disabled} onClick={onOpenDocuments}>查看项目文档<ChevronRight size={13} /></button>}
      {['draft', 'partial'].includes(view.state) && !onOpenDraft && onRecover && <button type="button" disabled={disabled} onClick={onRecover}>检查草稿与保存结果<ChevronRight size={13} /></button>}
      {interrupted && (view.canRetry && onRetry ? <button type="button" disabled={disabled} onClick={onRetry}><RotateCcw size={12} />重试本轮</button>
        : onRecover && <button type="button" disabled={disabled} onClick={onRecover}>检查草稿与保存结果<ChevronRight size={13} /></button>)}
    </div>}
  </section>
}
