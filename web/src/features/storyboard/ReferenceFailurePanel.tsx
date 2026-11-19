import { useId, useState } from 'react'
import { Button } from '@mantine/core'
import { ChevronDown } from 'lucide-react'
import type { ScriptCanvasPlan } from '@video-studio/shared/api/contracts'
import { referenceDisplayName, referenceFailureView, type ReferenceRetry } from './reference-failure'
import './reference-failure.css'

type Props = {
  units: NonNullable<ScriptCanvasPlan['failed_units']>
  completed?: Array<{ draft_key?: string; name: string; variant: string }>
  title?: string; busy?: boolean; skipped?: boolean; compact?: boolean
  onRetry?: (retry: ReferenceRetry) => void
}

export default function ReferenceFailurePanel({ units, completed = [], title = '参考设定', busy = false, skipped = false, compact = false, onRetry }: Props) {
  const id = useId(), [expanded, setExpanded] = useState<string[]>([]), [showUnits,setShowUnits] = useState(false)
  const views = units.map(referenceFailureView)
  const peers = [...completed, ...units.map(unit => ({ name: unit.name || unit.unit_key, variant: unit.variant }))]
  return <section className="reference-failure-panel" aria-label={title}>
    <header className="reference-failure-panel-header"><strong>{title}</strong><span>已完成 {completed.length} · 未完成 {units.filter(unit => unit.stage !== 'coverage').length}{units.some(unit => unit.stage === 'coverage') ? ` · 覆盖待处理 ${units.filter(unit => unit.stage === 'coverage').length}` : ''}</span></header>
    {views.filter(view => view.status === '达到上限' && units.find(unit => unit.unit_key === view.unitKey)?.stage === 'coverage').map(view => <p className="reference-failure-help" role="status" key={view.unitKey}>{view.name}：{view.nextStep}</p>)}
    {skipped && <p className="reference-failure-skip-notice" role="status">已暂时跳过待处理对象；相关镜头的参考绑定尚不完整，尚未加入画布。已有结果已保留，关闭后可重新打开继续处理。</p>}
    {compact && <Button className="reference-unit-toggle" variant="subtle" size="compact-xs" aria-expanded={showUnits} aria-controls={`${id}-units`} onClick={() => setShowUnits(!showUnits)}>{showUnits ? '收起已完成与待处理内容' : '查看已完成与待处理内容'}</Button>}
    {(!compact || showUnits) && <div id={`${id}-units`} className="reference-failure-list" role="list">
      {completed.map((unit, i) => <div className="reference-failure-complete" role="listitem" key={unit.draft_key || i}>
        <span className="reference-failure-status is-complete">已完成</span><strong>{referenceDisplayName(unit, peers)}</strong>
      </div>)}
      {views.map((view, index) => <div key={view.unitKey} className="reference-failure-item" data-unit-key={view.unitKey} role="listitem">
        <div className="reference-failure-label">
          <span className={'reference-failure-status is-' + (skipped || view.status === '已跳过' ? 'skipped' : view.canContinue || view.retry ? 'actionable' : 'blocked')}>{skipped ? '已跳过' : view.status}</span>
          <strong title={referenceDisplayName({ name: view.objectName, variant: units[index]!.variant }, peers)}>{referenceDisplayName({ name: view.objectName, variant: units[index]!.variant }, peers)}</strong><span className="reference-failure-summary">{view.summary}</span>
        </div>
        <div className="reference-failure-row-actions">
          <Button variant="subtle" size="compact-xs" aria-label={'查看' + view.objectName + '详情'} aria-expanded={expanded.includes(view.unitKey)} aria-controls={`${id}-${index}`} rightSection={<ChevronDown size={12} />} onClick={() => setExpanded(keys => keys.includes(view.unitKey) ? keys.filter(key => key !== view.unitKey) : [...keys, view.unitKey])}>详情</Button>
          {view.retry && onRetry && <Button className="reference-failure-retry" variant="default" size="compact-xs" disabled={busy || skipped} title={units[index]!.recovery?.model_call === 'none' ? '复用本地已有结果' : '将调用所选模型补全失败字段'} onClick={() => onRetry(view.retry!)} aria-label={(units[index]!.stage === 'coverage' ? '修正' : '仅重试') + view.objectName}>{units[index]!.stage === 'coverage' ? '修正' : '重试'}</Button>}
        </div>
        {expanded.includes(view.unitKey) && <div id={`${id}-${index}`} className="reference-failure-detail">
          <p><strong>下一步：</strong>{view.nextStep}</p><p><strong>影响：</strong>{view.impact}</p><p><strong>模型调用：</strong>{view.modelCall}</p>
          <p><strong>诊断代码：</strong>{units[index]!.code}</p>
          <p><strong>{units[index]!.stage === 'coverage' ? '实际模型请求：' : '请求尝试：'}</strong>{units[index]!.model_request_count ?? units[index]!.attempt}{units[index]!.local_validation_count === undefined ? '' : ` · 本地校验：${units[index]!.local_validation_count}`} · <strong>记录来源：</strong>{units[index]!.checkpoint_source}</p>
          <pre>{units[index]!.message}</pre>
        </div>}
      </div>)}
    </div>}
  </section>
}

