import { Alert, Button, Modal } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import type { SourceRequestReconciliation, SourceRequestRecoveryProgress, SourceRequestRecoveryWorkflowSummary, SourceRecoverySummary } from '@video-studio/shared/script/script-source-request-recovery'
import { api, json, type ApiError } from '../../shared/api/api'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { SourceAnalysisField, SourceAnalysisIdentifier } from './SourceAnalysisDetailFields'

import './script-source-recovery-dialog.css'

export type SourceRequestRecovery = {
  analysis_id: string; source_updated_at: string; cas_token: string; local_active: boolean; model_id?: string
  budget: { can_resume: boolean; grants: number; max_grants: number; exhausted?: string }
  summary?: SourceRecoverySummary
  blocked_reason?: string; reconciliation?: SourceRequestReconciliation
  recovery_workflow?: SourceRequestRecoveryWorkflowSummary
  blockers: Array<{ id: string; scope: string; request_key: string; run_id: string; updated_at: string
    state: 'dispatched'; delivery: string; local_request_id: string | null; upstream_request_id: string | null
    identity_binding: 'native' | 'unbound' }>
}
export type SourceRecoveryPresentation = { summary?: SourceRecoverySummary; state: 'working' | 'risk_required' | 'stopped' | 'completed'; message: string
  confirmation_kind?: 'remaining_model_usage' }
type RecoveryResult = { action_id: string; analysis: ScriptSourceAnalysis; reconciliation: SourceRequestReconciliation; recovery: SourceRequestRecoveryProgress }
type PendingAction = { id: string; cas: string }

export function sourceRecoveryBinding(source: ScriptSourceDocument, selectedModelId: string) {
  return JSON.stringify([source.project_id, source.updated_at, source.analysis?.id, selectedModelId])
}

/** Persist only the exact uncertain action, so closing/reloading cannot create another authorization. */
function pendingAction(binding: string, cas: string, memory: Map<string, PendingAction>): PendingAction {
  const value = savedAction(binding, memory) || { id: globalThis.crypto.randomUUID(), cas }
  rememberAction(binding, value, memory)
  return value
}
function savedAction(binding: string, memory: Map<string, PendingAction>): PendingAction | undefined {
  let value = memory.get(binding)
  try { value ||= JSON.parse(window.sessionStorage.getItem(`source-recovery-action:${binding}`) || 'null') as PendingAction | undefined } catch { /* Storage may be unavailable. */ }
  return value && /^[a-zA-Z0-9-]{1,120}$/.test(value.id) && typeof value.cas === 'string' ? value : undefined
}
function rememberAction(binding: string, value: PendingAction, memory: Map<string, PendingAction>) {
  memory.set(binding, value)
  try { window.sessionStorage.setItem(`source-recovery-action:${binding}`, JSON.stringify(value)) } catch { /* The mounted controller retains its nonce. */ }
}
function clearAction(binding: string, memory: Map<string, PendingAction>) {
  memory.delete(binding)
  try { window.sessionStorage.removeItem(`source-recovery-action:${binding}`) } catch { /* Storage may be unavailable. */ }
}

/** The recovery click authorizes local work; new model use needs its exact server-issued confirmation. */
export default function ScriptSourceRequestRecovery({ source, selectedModelId, opened, unavailable = false, onClose, onRecovered, onRefreshed, onStateChange, onInvalidated, inlinePreparation = false, confirmationOpen = true }: {
  source: ScriptSourceDocument; selectedModelId: string; opened: boolean; unavailable?: boolean
  inlinePreparation?: boolean; confirmationOpen?: boolean
  onClose: () => void; onRecovered: (analysis: ScriptSourceAnalysis) => void
  onRefreshed?: (analysis: ScriptSourceAnalysis) => void; onStateChange?: (state: SourceRecoveryPresentation) => void
  onInvalidated?: () => Promise<void>
}) {
  const extraction = source.analysis?.analysis_mode === 'extract'
  const binding = sourceRecoveryBinding(source, selectedModelId)
  const current = useRef(''), activation = useRef(0); current.current = opened ? binding : ''
  const callbacks = useRef({ onClose, onRecovered, onRefreshed, onStateChange, onInvalidated })
  callbacks.current = { onClose, onRecovered, onRefreshed, onStateChange, onInvalidated }
  const [details, setDetails] = useState<SourceRequestRecovery | null>(null)
  const [progress, setProgress] = useState<SourceRequestRecoveryProgress | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const pollTimer = useRef<number | undefined>(undefined)
  const lock = useRef(false), actions = useRef(new Map<string, PendingAction>())
  const path = `/projects/${source.project_id}/script/source/analysis/request-recovery`
  const sameIdentity = (value: SourceRequestRecovery) => value.analysis_id === source.analysis?.id && value.source_updated_at === source.updated_at &&
    (!value.model_id || value.model_id === source.analysis?.model_id) && selectedModelId === source.analysis?.model_id

  async function adoptSubmittedResult(value: SourceRequestRecovery, expected: string, expectedActivation: number) {
    const existing = value.recovery_workflow, saved = savedAction(expected, actions.current)
    if (!existing || !saved || existing.client_action_id !== saved.id || existing.analysis_id !== value.analysis_id ||
      value.source_updated_at !== source.updated_at || value.model_id !== source.analysis?.model_id || selectedModelId !== source.analysis?.model_id ||
      !['queued', 'completed', 'stopped'].includes(existing.recovery.phase)) return false
    await callbacks.current.onInvalidated?.()
    clearAction(expected, actions.current)
    if (current.current !== expected || activation.current !== expectedActivation) return true
    callbacks.current.onStateChange?.({ state: existing.recovery.outcome === 'running' ? 'working' : existing.recovery.outcome === 'completed' ? 'completed' : 'stopped', message: existing.recovery.message, summary: existing.recovery.summary })
    callbacks.current.onClose()
    return true
  }

  async function recover(snapshot: SourceRequestRecovery, risk?: NonNullable<SourceRequestRecoveryProgress['risk']>) {
    if (lock.current || current.current !== binding || unavailable) return
    lock.current = true; setSubmitting(true); setError(null)
    const expected = binding, expectedActivation = activation.current
    callbacks.current.onStateChange?.({ state: 'working', message: risk ? '正在恢复未完成的分析，已保存结果将自动复用…' : '正在恢复已保存的回答并校验分析结果…' })
    try {
      // Confirmation reads a fresh CAS, but preserves the first action identity and exact displayed risk token.
      const latest = risk ? await api<SourceRequestRecovery>(path) : snapshot
      if (current.current !== expected || activation.current !== expectedActivation) return
      if (risk && await adoptSubmittedResult(latest, expected, expectedActivation)) return
      if (current.current !== expected || activation.current !== expectedActivation) return
      if (!sameIdentity(latest)) throw new Error('分析、原稿或模型已变化，请查看当前分析状态后再恢复。')
      if (latest.local_active) throw new Error('分析仍在处理中，请等待执行结束。')
      setDetails(latest)
      const action = pendingAction(expected, latest.cas_token, actions.current)
      const result = await api<RecoveryResult>(`${path}/${inlinePreparation && !risk ? 'prepare' : 'reconcile'}`, json('POST', {
        analysis_id: latest.analysis_id, cas_token: risk ? latest.cas_token : action.cas, client_action_id: action.id, decision: 'reconcile_local',
        ...(risk ? { risk_confirmation: { scope_token: risk.scope_token, acknowledged_duplicate_risk: true } } : {}),
      }))
      if (current.current !== expected || activation.current !== expectedActivation) return
      setUncertain(false); setProgress(result.recovery)
      const localRunning = result.recovery.outcome === 'running' && result.recovery.phase === 'local_recovery'
      if (result.recovery.outcome !== 'risk_required' && !localRunning) clearAction(expected, actions.current)
      const state = result.recovery.outcome === 'running' ? 'working' : result.recovery.outcome === 'completed' ? 'completed'
        : result.recovery.outcome === 'risk_required' ? 'risk_required' : 'stopped'
      callbacks.current.onStateChange?.({ state, message: result.recovery.message, summary: result.recovery.summary,
        ...(result.recovery.risk?.confirmation_kind ? { confirmation_kind: result.recovery.risk.confirmation_kind } : {}) })
      if (result.recovery.outcome === 'running' && result.recovery.phase === 'queued' && ['queued', 'running'].includes(result.analysis.status)) callbacks.current.onRecovered(result.analysis)
      else callbacks.current.onRefreshed?.(result.analysis)
      if (localRunning) pollTimer.current = window.setTimeout(() => setRefresh(value => value + 1), 1000)
      else if (result.recovery.outcome !== 'risk_required') callbacks.current.onClose()
    } catch (issue) {
      if (current.current !== expected || activation.current !== expectedActivation) return
      const status = (issue as ApiError)?.status
      let message = issue instanceof Error ? issue.message : '恢复结果读取失败，请重试同一次恢复。'
      const ambiguous = status !== 409 && status !== 422 && issue instanceof TypeError
      if (status === 409 || status === 422) { clearAction(expected, actions.current); setProgress(null) }
      if (status === 409) {
        try {
          if (callbacks.current.onInvalidated) await callbacks.current.onInvalidated()
          else await api<SourceRequestRecovery>(path)
          message += '；已重新读取当前分析状态，本次恢复已停止。'
        } catch { message += '；当前状态读取失败，请稍后再恢复。' }
        if (current.current !== expected || activation.current !== expectedActivation) return
      }
      setError(message); setUncertain(ambiguous)
      callbacks.current.onStateChange?.({ state: 'stopped', message: ambiguous ? `${message}；提交结果尚未确认，再次恢复将沿用同一操作编号。` : message })
      if (!risk || status === 409 || status === 422) callbacks.current.onClose()
    } finally {
      if (current.current === expected && activation.current === expectedActivation) { lock.current = false; setSubmitting(false) }
    }
  }

  async function resumeLegacy(legacy: NonNullable<SourceRequestRecoveryProgress['legacy_resume']>) {
    if (lock.current || current.current !== binding || unavailable) return
    lock.current = true; setSubmitting(true); setError(null)
    const expected = binding, expectedActivation = activation.current
    callbacks.current.onStateChange?.({ state: 'working', message: '正在确认原有恢复决定并继续未完成分析…' })
    try {
      const latest = await api<SourceRequestRecovery>(path)
      if (current.current !== expected || activation.current !== expectedActivation) return
      if (await adoptSubmittedResult(latest, expected, expectedActivation)) return
      if (current.current !== expected || activation.current !== expectedActivation) return
      if (!sameIdentity(latest) || latest.analysis_id !== legacy.analysis_id || latest.cas_token !== legacy.cas_token || latest.local_active) {
        const issue = new Error('请求或分析状态已变化，本次确认未提交；请查看最新分析状态后恢复。') as ApiError
        issue.status = 409; throw issue
      }
      const result = await api<{ action_id: string; analysis: ScriptSourceAnalysis }>(path, json('POST', {
        analysis_id: legacy.analysis_id, cas_token: legacy.cas_token, client_action_id: legacy.client_action_id,
        decision: 'abandon_and_resume', acknowledged_duplicate_risk: true, workflow_id: legacy.workflow_id,
      }))
      if (current.current !== expected || activation.current !== expectedActivation) return
      clearAction(expected, actions.current); setUncertain(false)
      if (['queued', 'running'].includes(result.analysis.status)) {
        callbacks.current.onStateChange?.({ state: 'working', message: '已恢复分析，进度将自动更新。' })
        callbacks.current.onRecovered(result.analysis)
      } else {
        callbacks.current.onStateChange?.({ state: 'stopped', message: result.analysis.error || '本次恢复未进入执行，已保存结果保留。' })
        callbacks.current.onRefreshed?.(result.analysis)
      }
      callbacks.current.onClose()
    } catch (issue) {
      if (current.current !== expected || activation.current !== expectedActivation) return
      const status = (issue as ApiError)?.status
      let message = issue instanceof Error ? issue.message : '恢复结果尚未确认，请重试同一恢复。'
      if (status === 409 || status === 422) {
        clearAction(expected, actions.current); setProgress(null)
        try { await callbacks.current.onInvalidated?.(); message += '；已重新读取当前分析，本次恢复已停止。' } catch { message += '；当前状态读取失败，请稍后恢复。' }
        if (current.current !== expected || activation.current !== expectedActivation) return
        callbacks.current.onClose()
      } else { setUncertain(true) }
      setError(message)
      callbacks.current.onStateChange?.({ state: 'stopped', message })
    } finally {
      if (current.current === expected && activation.current === expectedActivation) { lock.current = false; setSubmitting(false) }
    }
  }

  useEffect(() => {
    let active = true
    activation.current++
    current.current = opened ? binding : ''
    setDetails(null); setProgress(null); setError(null); setUncertain(false); setSubmitting(false); lock.current = false
    if (!opened) return () => { active = false; activation.current++; current.current = ''; window.clearTimeout(pollTimer.current) }
    callbacks.current.onStateChange?.({ state: 'working', message: '正在读取已保存的回答与当前分析状态…' })
    void api<SourceRequestRecovery>(path).then(async value => {
      if (!active || current.current !== binding) return
      setDetails(value)
      if (await adoptSubmittedResult(value, binding, activation.current)) return
      if (!active || current.current !== binding) return
      if (!sameIdentity(value)) throw new Error('分析、原稿或模型已变化，请查看当前分析状态后再恢复。')
      if (inlinePreparation && value.local_active && value.recovery_workflow?.recovery.phase !== 'local_recovery') {
        await callbacks.current.onInvalidated?.()
        if (!active || current.current !== binding) return
        callbacks.current.onStateChange?.({ state: 'stopped', message: '分析正在处理中，已刷新进度；未重复发送。', summary: value.summary })
        callbacks.current.onClose(); return
      }
      if (unavailable) throw new Error('当前任务正在处理，请稍后恢复分析。')
      const existing = value.recovery_workflow
      if (existing && refresh > 0 && ['completed', 'stopped'].includes(existing.recovery.outcome)) {
        await callbacks.current.onInvalidated?.()
        if (!active || current.current !== binding) return
        clearAction(binding, actions.current)
        callbacks.current.onStateChange?.({ state: existing.recovery.outcome === 'completed' ? 'completed' : 'stopped', message: existing.recovery.message, summary: existing.recovery.summary })
        callbacks.current.onClose()
        return
      }
      if (existing && (existing.recovery.outcome === 'risk_required' || existing.recovery.outcome === 'running' || existing.recovery.phase === 'local_recovery')) {
        if (inlinePreparation && existing.recovery.risk && !existing.recovery.legacy_resume) {
          callbacks.current.onStateChange?.({ state: 'stopped', message: '历史恢复范围包含质量审核，不能用于当前原稿分析。',
            summary: value.summary ? { ...value.summary, reason: '历史恢复范围包含质量审核，不能用于当前原稿分析；已保存结果保留。' } : undefined })
          callbacks.current.onClose(); return
        }
        if (existing.analysis_id !== value.analysis_id || !/^[a-zA-Z0-9-]{1,120}$/.test(existing.client_action_id)) {
          throw new Error('已有恢复操作与当前分析不一致，已停止恢复，请查看当前分析状态。')
        }
        rememberAction(binding, { id: existing.client_action_id, cas: value.cas_token }, actions.current)
        if (existing.recovery.outcome === 'risk_required' && (existing.recovery.risk || existing.recovery.legacy_resume)) {
          setProgress(existing.recovery)
          callbacks.current.onStateChange?.({ state: 'risk_required', message: existing.recovery.message, summary: existing.recovery.summary,
            ...(existing.recovery.risk?.confirmation_kind ? { confirmation_kind: existing.recovery.risk.confirmation_kind } : {}) })
          return
        }
        if (existing.recovery.outcome === 'running' && existing.recovery.phase !== 'local_recovery') {
          await callbacks.current.onInvalidated?.()
          if (!active || current.current !== binding) return
          callbacks.current.onStateChange?.({ state: 'working', message: existing.recovery.message, summary: existing.recovery.summary })
          callbacks.current.onClose()
          return
        }
        if (existing.recovery.phase === 'local_recovery' && value.local_active) {
          callbacks.current.onStateChange?.({ state: 'working', message: existing.recovery.message, summary: existing.recovery.summary })
          pollTimer.current = window.setTimeout(() => setRefresh(value => value + 1), 1000)
          return
        }
      }
      if (inlinePreparation && value.reconciliation?.can_reconcile === false) {
        await callbacks.current.onInvalidated?.()
        if (!active || current.current !== binding) return
        callbacks.current.onStateChange?.({ state: 'stopped', message: value.blocked_reason || '当前没有可用的恢复范围。',
          summary: value.summary ? { ...value.summary, reason: value.blocked_reason || value.summary.reason } : undefined })
        callbacks.current.onClose(); return
      }
      await recover(value)
    }).catch(issue => {
      if (!active || current.current !== binding) return
      const message = issue instanceof Error ? issue.message : '读取分析状态失败，请重试恢复分析。'
      callbacks.current.onStateChange?.({ state: 'stopped', message }); callbacks.current.onClose()
    })
    return () => { active = false; activation.current++; window.clearTimeout(pollTimer.current); if (current.current === binding) current.current = '' }
    // Callbacks are read through refs. A parent state refresh must not resubmit the same operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, binding, path, refresh])

  const risk = progress?.outcome === 'risk_required' ? progress.risk : undefined
  const legacy = progress?.outcome === 'risk_required' ? progress.legacy_resume : undefined
  const remainingUsage = risk?.confirmation_kind === 'remaining_model_usage' && !legacy
  if (inlinePreparation) {
    const savedCount = legacy?.saved_count ?? progress?.summary?.saved_count ?? details?.summary?.saved_count
    const canConfirm = savedCount !== undefined && (!!legacy || !!risk) && !details?.local_active
    if (!(opened && confirmationOpen && (!!risk || !!legacy))) return null
    return <section role="group" aria-label="确认恢复未完成项">
      <p className="sd-analysis-confirm-note">已完成的{savedCount ?? '已保存'}项会保留。部分请求未收到完整结果，重新请求可能产生重复费用。</p>
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <div className="sd-source-dialog-actions">
        <Button variant="default" disabled={submitting} onClick={() => callbacks.current.onClose()}>暂不继续</Button>
        <Button loading={submitting} disabled={!canConfirm || submitting || unavailable} onClick={() => {
          if (legacy) void resumeLegacy(legacy)
          else if (details && risk) void recover(details, risk)
        }}>继续未完成项</Button>
      </div>
    </section>
  }

  return <Modal opened={opened && (!!risk || !!legacy)} onClose={() => { if (!lock.current) callbacks.current.onClose() }} title={remainingUsage ? '确认剩余分析用量' : '确认恢复未完成的分析'} centered size="lg" zIndex={310}
    closeOnClickOutside={!submitting} closeOnEscape={!submitting} withCloseButton={!submitting} className="sd-source-recovery-modal">
    {(risk || legacy) && details && <>
      <div className="sd-source-recovery-scroll"><div className="sd-source-recovery">
        <p className="sd-source-recovery-intro">{progress!.message}</p>
        <p className="sd-source-recovery-risk">{risk?.warning || legacy?.warning}{!remainingUsage && ' 旧请求的最终状态仍未知，确认不会取消旧请求，也不会将其记为未发送。'}</p>
        <p className="sd-source-recovery-risk">{extraction ? '本次仅处理未完成的原稿分析；已保存结果会复用，不进行质量审核、修补或复核循环。未知请求历史继续保留，不会自动认定远端取消。' : remainingUsage ? '已完成的本地修补会保留。本次仅为剩余修补和复核建立新的授权，沿用原累计用量上限；再次断连或没有进展时停止。'
          : risk ? '本次确认覆盖剩余修补和复核流程；系统会自动复用已保存结果，在限定用量内继续，断连后停止，不再自动重发。'
          : '本次沿用当前未完成请求的恢复范围和原有累计用量限制；不会重置额度，已保存结果会继续保留。'}</p>
        <dl className="sd-analysis-fields">
          <SourceAnalysisField label="恢复范围">{risk ? `${risk.scope.repair_count} 项修补、${risk.scope.review_count} 轮复核，最多 ${risk.scope.max_model_requests} 次模型请求`
            : `继续当前未完成请求；累计剩余最多 ${legacy!.max_model_requests} 次模型请求`}</SourceAnalysisField>
        </dl>
        <WorkspaceDisclosure label="本次恢复详情" className="sd-source-recovery-details">
          <SourceAnalysisIdentifier label="分析编号" value={details.analysis_id} />
          <SourceAnalysisIdentifier label="原稿版本" value={details.source_updated_at} />
          <SourceAnalysisIdentifier label="恢复范围标识" value={risk?.scope_token || legacy!.workflow_id} />
          {details.blockers.map(item => <section key={item.id}>
            {item.local_request_id && <SourceAnalysisIdentifier label="本地请求编号" value={item.local_request_id} />}
            {item.upstream_request_id && <SourceAnalysisIdentifier label="上游请求编号" value={item.upstream_request_id} />}
            <SourceAnalysisIdentifier label="请求指纹" value={item.request_key} />
          </section>)}
        </WorkspaceDisclosure>
        {error && <Alert color="red" mt="sm" role="alert">{error}{uncertain && <p>提交结果尚未确认，重试会沿用同一恢复操作编号。</p>}</Alert>}
      </div></div>
      <footer className="sd-source-dialog-actions">
        <Button variant="default" disabled={submitting} onClick={() => callbacks.current.onClose()}>取消</Button>
        <Button color="orange" loading={submitting} disabled={submitting || unavailable} onClick={() => void (legacy ? resumeLegacy(legacy) : recover(details, risk))}>
          {uncertain ? '重试同一恢复' : remainingUsage ? '确认新用量并恢复' : '确认可能重复计费并恢复'}
        </Button>
      </footer>
    </>}
  </Modal>
}
