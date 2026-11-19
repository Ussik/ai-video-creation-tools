import { useRef, useState } from 'react'
import { Button, Modal, type ButtonProps } from '@mantine/core'
import type { CanvasPreparationRecovery, CanvasPreparationSnapshot } from '@video-studio/shared/api/contracts'
import type { ReferenceAction } from './useCanvasPreparationRecovery'
import { ReferencePreparationProgress } from './ReferencePreparationProgress'
import './reference-failure.css'

/** A primary click starts the selected recovery action directly. */
export function ReferencePrimaryAction({ action, onAction, ...props }: ButtonProps & {
  action: ReferenceAction; onAction: (action: ReferenceAction) => void
}) {
  return <Button {...props} onClick={() => onAction(action)} />
}

/** Stops local follow-up work; it cannot promise cancellation of a submitted provider request. */
export function ReferenceStopAction({ capabilities, onStop, readError }: {
  capabilities?: CanvasPreparationRecovery; onStop: () => Promise<void>; readError?: string
}) {
  const [intent, setIntent] = useState<{ run: string; owner?: string } | null>(null), [sending, setSending] = useState(false)
  const stopLock = useRef(false)
  const allowed = !!capabilities?.inspection?.can_cancel && !readError
  const sameRun = !!intent && intent.run === capabilities?.run_id && intent.owner === capabilities?.inspection?.owner_request_id
  if (!allowed && !intent && !sending) return null
  return <>
    {allowed && <Button className="reference-stop-action" variant="subtle" color="red" disabled={sending} onClick={() => setIntent({ run: capabilities!.run_id, owner: capabilities?.inspection?.owner_request_id })}>{sending ? '正在请求停止' : '停止任务'}</Button>}
    <Modal opened={!!intent} onClose={() => { if (!sending) setIntent(null) }} centered size="sm" zIndex={370} title="停止任务" classNames={{ content: 'reference-preparation-dialog' }}>
      <p>将停止本地后续处理。已发出的模型请求可能仍会继续，已完成结果会保留；这不代表上游请求已取消。</p>
      {!sameRun && <p>当前运行已变化，请关闭此确认后重新核对。</p>}
      <div className="reference-preparation-dialog-actions"><Button variant="default" disabled={sending} onClick={() => setIntent(null)}>继续处理</Button><Button color="red" disabled={!allowed || !sameRun || sending} onClick={async () => {
        if (!allowed || !sameRun || stopLock.current) return
        stopLock.current = true; setSending(true)
        try { await onStop() } finally { stopLock.current = false; setSending(false); setIntent(null) }
      }}>确认停止任务</Button></div>
    </Modal>
  </>
}

export function referenceIsWorking(capabilities?: CanvasPreparationRecovery, activity?: string) {
  return !!activity || capabilities?.state === 'running'
}

export default function ReferencePreparationRecovery({ capabilities, snapshot, sceneCount, busy, simple, error, activity, preparing, reason, sourceMessage, disabledReason, adopt, completed, reading, onReload, onRestart, onAbandon, onDiscard }: {
  capabilities?: CanvasPreparationRecovery; snapshot?: CanvasPreparationSnapshot; sceneCount: number; busy: boolean; simple?: boolean; error?: string; activity?: string; preparing?: boolean; reason?: string; sourceMessage?: string; disabledReason?: string; adopt?: boolean; completed?: boolean; reading?: boolean
  onReload: () => void; onRestart: () => void; onAbandon?: () => void; onDiscard?: () => void
}) {
  const [confirm, setConfirm] = useState<'restart' | 'abandon' | 'discard' | null>(null), [details, setDetails] = useState(false), [oldResults, setOldResults] = useState(false)
  const retained = snapshot?.retained_results?.length ? snapshot.retained_results
    : snapshot?.retained_plan ? [{ run_id: capabilities?.run_id || '', discarded: !!capabilities?.adoption?.discarded, plan: snapshot.retained_plan }] : []
  const stale = capabilities?.adoption?.source_matches === false
  const working = referenceIsWorking(capabilities, activity)
  const unknown = capabilities?.state === 'unknown' && !working
  const coverageOnly = !!snapshot?.plan?.failed_units?.length && snapshot.plan.failed_units.every(unit => unit.stage === 'coverage')
  const cancelling = capabilities?.state === 'running' && capabilities.inspection?.cancel_requested
  if (!capabilities && !error && !retained.length && !activity && !reason && !completed && !snapshot?.plan?.failed_units?.length) return null
  const title = error ? '状态读取失败' : cancelling ? '正在停止任务' : working ? '正在准备画布' : unknown ? '请求结果尚未确认' : stale ? '需要更新参考设定' : completed ? '已加入画布' : adopt ? '参考已整理完成' : capabilities?.state === 'partial' ? coverageOnly ? '逐镜用途待核对' : '部分参考待处理' : capabilities?.state === 'failed' ? '参考整理未完成' : capabilities?.state === 'cancelled' ? '后续处理已停止' : '参考准备状态'
  const description = error ? '无法确认当前状态，请重试后继续。' : cancelling ? '已请求停止本地后续处理，正在核对最终状态；已发出的模型请求可能仍继续，已完成结果保留。' : working ? undefined : unknown ? '已停止自动重发，请先核对原请求结果。' : stale ? sourceMessage : adopt ? '新参考尚未采用，确认后加入画布。' : reason
  if (simple) {
    const failed = !!snapshot?.plan?.failed_units?.length || capabilities?.state === 'partial' || capabilities?.state === 'failed'
    const canRecover = capabilities?.can_retry_failed || capabilities?.can_continue || capabilities?.can_restart_all || capabilities?.adoption?.can_prepare_current || capabilities?.inspection?.can_abandon
    const resultTitle = error ? '暂时无法读取结果' : unknown ? '正在确认结果' : completed ? '已加入画布' : stale ? '分镜已更新' : adopt ? '已准备好，可以加入画布' : failed ? '未能加入画布' : reason ? '暂时无法加入画布' : ''
    const message = error || unknown ? '请刷新状态后继续。' : stale ? '请重新整理参考后加入画布。' : failed ? canRecover ? (capabilities?.can_retry_failed || capabilities?.can_continue ? (capabilities?.state === 'failed' ? '模型连接中断，已有结果已保留，点击「重试」继续。' : '已有结果已保留，点击「重试」继续。') : '请重新整理后加入画布，已有结果会保留。') : '已有结果已保留，当前无法继续整理，请稍后刷新状态。' : reason && !adopt ? '请刷新状态，或选择本次使用的模型后继续。' : ''
    return resultTitle ? <section className="reference-preparation-status" aria-label="画布准备结果"><div className="reference-run-status" role={error || failed ? 'alert' : 'status'}><strong>{resultTitle}</strong>{message && <p>{message}</p>}{(error || unknown || failed && !canRecover || !failed && !!reason && !adopt && !canRecover) && <Button variant="subtle" size="compact-xs" disabled={reading} onClick={onReload}>刷新状态</Button>}</div></section> : null
  }
  const retainedCount = retained.reduce((sum, item) => sum + item.plan.profiles.length, 0)
  return <section className="reference-preparation-status" aria-label="参考恢复状态">
    <div className="reference-run-status" role={error ? 'alert' : 'status'} aria-live="polite">
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {stale && !working && !unknown && disabledReason && <p>{disabledReason}</p>}
      {working && !cancelling && <ReferencePreparationProgress capabilities={capabilities} activity={activity} preparing={preparing} />}
      {working && !cancelling && capabilities?.state === 'running' && ['active','external'].includes(capabilities.inspection?.executor || '') && <p className="reference-preparation-background">关闭后仍会继续处理。</p>}
      {(error || unknown) && <Button variant="subtle" size="compact-xs" disabled={reading} onClick={onReload}>{error ? '重试' : '核对状态'}</Button>}
    </div>
    <div className="reference-preparation-status-line reference-preparation-links">
      {retained.length > 0 && <span>已保留{retainedCount}份旧参考</span>}
      <span className="reference-preparation-link-actions">
        {retained.length > 0 && <><Button variant="subtle" size="compact-xs" aria-expanded={oldResults} aria-controls="reference-retained-content" onClick={() => setOldResults(!oldResults)}>查看旧参考</Button><span className="reference-preparation-separator" aria-hidden="true">·</span></>}
        <Button className="reference-preparation-detail-toggle" variant="subtle" size="compact-xs" aria-expanded={details} aria-controls="reference-preparation-details" onClick={() => setDetails(!details)}>详情</Button>
      </span>
    </div>
    {retained.length > 0 && <>
      {oldResults && <div id="reference-retained-content" className="reference-retained-results">
        <p>以下参考保留原版本与镜头引用，不会直接用于当前分镜。</p>
        {retained.map(item => <section key={item.run_id}>
          <p>运行 {item.run_id} · {item.plan.profiles.length} 份参考{item.discarded ? ' · 已放弃采用' : ''}</p>
          {item.plan.profiles.map((profile, index) => <article key={profile.draft_key || index}><strong>{profile.name} · {profile.variant || '默认'}</strong><p>{profile.definition}</p></article>)}
        </section>)}
        {capabilities?.adoption?.can_discard && onDiscard && <Button variant="subtle" size="compact-xs" disabled={busy} onClick={() => setConfirm('discard')}>放弃旧成果</Button>}
      </div>}
    </>}
    {details && <div id="reference-preparation-details" className="reference-preparation-details">
      {error && <p>{error}</p>}
      {capabilities && <>
        {capabilities.adoption && <p>本次运行已完成 {capabilities.adoption.completed_profiles} 份{capabilities.adoption.missing_shot_ids.length ? ` · ${capabilities.adoption.missing_shot_ids.length} 个旧镜头已不在当前范围` : ''}</p>}
        <p>当前运行请求 {capabilities.budget.run_requests}/{capabilities.budget.run_max_requests}</p><p>累计请求 {capabilities.budget.task_requests}/{capabilities.budget.task_max_requests}</p>
        <p>已保留运行版本 {capabilities.budget.runs}</p><p>全量重做最多保留 {capabilities.budget.max_runs} 个版本</p>
        <p>范围更新 {capabilities.adoption?.source_updates || 0}/{capabilities.adoption?.max_source_updates || 3}</p><p>运行编号：{capabilities.run_id}</p>
        {capabilities.inspection && <><p>执行者：{capabilities.inspection.executor}</p><p>请求编号：{capabilities.inspection.owner_request_id || '未记录'}</p><p>最后心跳：{capabilities.inspection.heartbeat_at || '历史运行未记录心跳'}</p><p>未确认响应：{capabilities.inspection.unresolved_responses}</p></>}
        <p>{capabilities.retry_reason}</p><p>{capabilities.continue_reason}</p><p>{capabilities.restart_reason}</p><p>{capabilities.adoption?.prepare_reason}</p>
        {!stale && <Button variant="subtle" size="compact-xs" disabled={busy || !capabilities.can_restart_all} title={capabilities.can_restart_all ? `将调用所选模型，重新整理所选 ${sceneCount} 场` : capabilities.restart_reason} onClick={() => setConfirm('restart')}>重新整理全部参考</Button>}
      </>}
    </div>}
    <Modal opened={confirm !== null} onClose={() => setConfirm(null)} centered size="sm" zIndex={370}
      title={confirm === 'discard' ? '放弃旧成果' : confirm === 'abandon' ? '放弃等待并重新整理' : '重新整理全部参考'} classNames={{ content: 'reference-preparation-dialog' }}>
      <p>{confirm === 'discard' ? '仅标记不再采用这份旧结果，原回答、参考内容与用量记录保留。不调用模型，也不会自动开始整理当前范围。'
        : confirm === 'abandon' ? '已核对当前没有活跃的本地执行者。放弃等待不能取消原请求，原请求可能仍在上游执行；重新整理将调用所选模型，可能重复产生用量。旧记录和已有结果会保留，新结果需确认采用。'
          : '重新整理所选场次的全部参考设定？现有结果会保留，将调用所选模型。'}</p>
      <div className="reference-preparation-dialog-actions"><Button variant="default" onClick={() => setConfirm(null)}>取消</Button>
        <Button disabled={busy || (confirm === 'discard' ? !capabilities?.adoption?.can_discard : confirm === 'abandon' ? !capabilities?.inspection?.can_abandon : !capabilities?.can_restart_all)} onClick={() => {
          const action = confirm; setConfirm(null); if (action === 'discard') onDiscard?.(); else if (action === 'abandon') onAbandon?.(); else onRestart()
        }}>{confirm === 'discard' ? '确认放弃采用' : confirm === 'abandon' ? '确认放弃等待并重新整理' : '重新整理'}</Button></div>
    </Modal>
  </section>
}
