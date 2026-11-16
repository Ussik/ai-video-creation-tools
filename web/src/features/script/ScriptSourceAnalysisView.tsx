import { Accordion, Button, CopyButton, List, Modal, Tabs, Textarea, ThemeIcon } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, Clock3, LoaderCircle, Pause, RotateCcw } from 'lucide-react'
import type { ScriptSourceAnalysis, ScriptSourceDocument, ScriptSourceEvidence } from '@video-studio/shared/script/script-source-document'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { api } from '../../shared/api/api'
import { formatProcessingDuration } from './DirectorMessageTiming'
import ScriptMessageContent from './ScriptMessageContent'
import { SourceAnalysisField, SourceAnalysisIdentifier } from './SourceAnalysisDetailFields'
import type { SourceRecoveryPresentation } from './ScriptSourceRequestRecovery'

function SourceAnalysisElapsed({ startedAt }: { startedAt?: string }) {
  const started = Date.parse(startedAt || '')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!Number.isFinite(started)) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [started])
  if (!Number.isFinite(started)) return null
  return <small className="sd-source-analysis-elapsed" role="timer" aria-live="off" aria-label="本次分析已用时" title="不含排队等待时间，继续分析后重新计时">
    <Clock3 size={11} aria-hidden="true" />本次已用时 {formatProcessingDuration(Math.max(0, now - started))}
  </small>
}

const qualityStopLabels = {
  no_progress: '本轮没有产生实质修改或新的有效判断，已停止重复调用模型。',
  uncertain: '部分意见目前无法确定，已保留当前分析和待复核事项。',
  decision_mismatch: '处理决定与当前分析或原文依据不一致，尚不能采纳为有效结果。',
  legacy_decision: '历史处理记录缺少当前所需的明确判断，不能据此视为核对通过。',
} as const

function SourceQualitySummary({ analysis }: { analysis: ScriptSourceAnalysis }) {
  const summary = analysis.quality_summary
  if (!summary) return null
  const ready = analysis.status === 'ready' && summary.review !== 'pending'
  const access = ready ? summary.access : 'blocked'
  return <section className="sd-analysis-detail-group" aria-label="分析意见处理结果">
    <h4>分析意见处理结果</h4>
    <dl className="sd-analysis-fields">
      <SourceAnalysisField label="已处理意见">{summary.handled}/{summary.total} 项</SourceAnalysisField>
      <SourceAnalysisField label="实际修改">{summary.modified} 项</SourceAnalysisField>
      <SourceAnalysisField label="保留待复核">{summary.retained} 项</SourceAnalysisField>
      <SourceAnalysisField label="无法确定">{summary.uncertain} 项</SourceAnalysisField>
      <SourceAnalysisField label="独立核对">{{ pending: '待核对', passed: '已通过', issues: '仍有核对事项' }[summary.review]}</SourceAnalysisField>
      <SourceAnalysisField label="创作可用范围">{{ blocked: '相关创作尚未开放', scoped: '仅明确不受影响的集数可继续', usable: summary.advisory ? '可继续创作，普通提示仍保留' : '可继续创作' }[access]}</SourceAnalysisField>
    </dl>
    <p className="sd-analysis-detail-hint">已处理表示这条意见已有处置记录，不代表已修改或已经通过。保留待复核的内容会继续保存，不会自动删除。</p>
    {summary.stop_reason && <p className="sd-analysis-detail-hint">{qualityStopLabels[summary.stop_reason]}请核对具体意见与原文依据后再决定下一步，系统不会一键重复付费重试。</p>}
    {summary.blocking > 0 && <p className="sd-analysis-detail-hint">{summary.blocking} 项实质问题仍阻塞创作，须先核对处理，不能通过保留待复核自动放行。</p>}
    {summary.access === 'scoped' && <p className="sd-analysis-detail-hint">部分待核对信息仅影响相关章节{summary.section_ids.length ? `，涉及剧情段落 ${summary.section_ids.map(id => id + 1).join('、')}` : '，具体范围尚未明确'}。全剧步骤需要完整资料；明确不依赖这些章节的分集步骤才可继续。</p>}
    {summary.advisory > 0 && <p className="sd-analysis-detail-hint">{summary.advisory} 项普通提示已保留供回查；普通提示本身不阻止继续创作。</p>}
    {summary.message && <p className="sd-analysis-detail-hint">{summary.message}</p>}
  </section>
}

export type SourceQualityRoundStart = { quality_scope: NonNullable<NonNullable<ScriptSourceAnalysis['quality_summary']>['confirmation_scope']>; confirm_new_quality_round: true }
export function ScriptSourceAnalysisStatus({ source, extractionOnly = false, starting, unavailable, pollError, hasPreviousFailure, onStart, onPause, onResolveRequest, onRevalidate, onRecover, onCancelRecovery, recovery, onRequestDetails }: {
  source: ScriptSourceDocument; extractionOnly?: boolean; starting: boolean; unavailable: boolean; pollError: boolean; hasPreviousFailure?: boolean; onStart: (confirmation?: SourceQualityRoundStart) => void; onPause?: () => void; onResolveRequest?: () => void; onRevalidate?: () => void
  onRequestDetails?: () => void; onRecover?: () => void; onCancelRecovery?: () => void; recovery?: SourceRecoveryPresentation | null
}) {
  const analysis = source.analysis
  const qualitySummary = extractionOnly ? undefined : analysis?.quality_summary
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => setDetailsOpen(false), [source.updated_at, analysis?.id])
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [confirmingGeneration, setConfirmingGeneration] = useState(false)
  const confirmationSubmit = useRef(false)
  useEffect(() => { if (!starting) confirmationSubmit.current = false }, [starting, analysis?.id,
    qualitySummary?.confirmation_scope?.review_hash, qualitySummary?.confirmation_scope?.findings_hash])
  useEffect(() => { setDetailsOpen(false); setDiagnosticsOpen(false) }, [analysis?.id])
  useEffect(() => { setConfirmingGeneration(false) }, [analysis?.id, analysis?.status, analysis?.local_validation?.checked_at, analysis?.resume?.action,
    analysis?.resume?.next?.phase, analysis?.resume?.next?.response, analysis?.resume?.next?.model_required, qualitySummary?.stop_reason, qualitySummary?.review, qualitySummary?.access,
    qualitySummary?.confirmation_required, qualitySummary?.confirmation_scope?.review_hash, qualitySummary?.confirmation_scope?.findings_hash, source.updated_at])
  const revised = (source.revision || 0) > 0
  const recovering = recovery?.state === 'working'
  const pending = recovering || analysis?.status === 'queued' || analysis?.status === 'running'
  const interrupted = analysis?.status === 'failed' || analysis?.status === 'paused'
  const mapReady = analysis?.phase === 'synthesis' || !!analysis?.story
  const step = analysis?.story ? extractionOnly ? 1 : 2 : analysis?.phase === 'synthesis' ? 1 : 0
  const resume = analysis?.resume ?? {
    available: !!analysis?.story || !!analysis?.sections.length || (analysis?.completed_chunks || 0) > 0,
    message: analysis?.story ? extractionOnly ? '全文分析和全剧整合已保存。' : '全文分析和全剧整合已完成，可继续质量核对。'
      : mapReady && !!analysis?.sections.length ? extractionOnly ? '全文分析已保存，可继续全剧整合。' : '全文分析已完成，可继续全剧整合和质量核对。'
        : analysis?.sections.length || (analysis?.completed_chunks || 0) > 0 ? '已完成的分析步骤已保留，可继续处理未完成部分。'
          : '当前尚无可复用的分析结果，重试将重新进行全文分析。',
  }
  const reconcile = resume.action === 'reconcile_request' || !!resume.blocked && resume.action !== 'blocked'
  const resumeBlocked = resume.action === 'blocked'
  const semanticStop = !!qualitySummary?.stop_reason && resume.action !== 'revalidate' && !reconcile
  const pendingLabel = recovering ? '正在恢复分析' : pollError ? '暂时无法获取分析状态'
    : analysis?.status === 'queued' ? `等待分析剧本${analysis.queue_position ? ` · 队列第 ${analysis.queue_position} 项` : ''}`
    : analysis?.progress?.stage === 'repairing' && !!analysis.story ? '正在处理核对意见'
    : step === 2 ? '正在独立核对分析结果'
    : analysis?.progress?.stage === 'repairing' || analysis?.progress?.stage === 'validating' ? '正在校验全文分析'
      : analysis?.phase === 'synthesis' ? '正在整理全剧信息' : 'AI 正在阅读全文分析'
  const sourceLabel = revised ? '当前有效稿' : '原剧本'
  const phaseLabel = (extractionOnly ? ['全文分析', '全剧整合'] : ['全文分析', '全剧整合', '质量核对'])[step]
  const responseUnknown = interrupted && (reconcile || !!analysis?.story_progress?.pending.some(item => item.status === 'unknown_response'))
  const stateLabel = recovering ? '恢复中' : pending ? pollError ? '状态待更新' : analysis!.status === 'queued' ? '等待执行' : '处理中'
    : responseUnknown ? '请求结果未知' : extractionOnly && analysis?.failure ? '分析失败'
      : analysis?.status === 'paused' ? extractionOnly ? analysis.pause_reason === 'user' ? '已暂停' : analysis.pause_reason === 'service_restart' ? '执行中断' : '待继续' : '已暂停'
        : analysis?.status === 'failed' ? extractionOnly ? '分析失败' : '未完成' : ''
  const merging = analysis?.story_progress?.pending.some(item => item.key.startsWith('characters_merge:'))
  const next = resume.next
  const qualityTaskLabel = next?.phase === 'quality_repair' ? '定点修补核对意见' : next?.phase === 'quality_review' ? '独立质量核对' : undefined
  const workflowBlocked = analysis?.failure?.stage === 'recovery'
  const nextModelReason = !extractionOnly && next?.model_required && next.response === 'not_started'
    ? `${workflowBlocked ? '请求或执行流程暂时阻断，已保存结果仍保留。' : ''}当前${qualityTaskLabel}尚无完整回答；继续需调用所选模型并产生用量。` : undefined
  // Diagnostic strings are evidence, not user-facing pause reasons or actions.
  const pendingCounts = new Map<string, number>()
  for (const item of analysis?.story_progress?.pending || []) {
    const kind = item.key.split(':')[0]
    pendingCounts.set(kind, (pendingCounts.get(kind) || 0) + 1)
  }
  const businessPending = [...pendingCounts].map(([kind, count]) => kind === 'characters' || kind === 'characters_merge' ? '人物信息待补齐'
    : kind === 'timeline' ? `${count} 批事件待处理` : kind === 'threads' ? `${count} 批伏笔引用待核对`
      : kind === 'uncertainties' ? `${count} 批不确定事项引用待核对` : '全剧概览待整理').join('、')
  const reason = extractionOnly && interrupted && !responseUnknown && businessPending ? `${businessPending}；已保存结果会复用。${analysis?.local_validation?.model_required ? '剩余内容需要模型生成，会产生用量。' : ''}` : recovery?.summary?.reason || recovery?.message || (extractionOnly && interrupted && !responseUnknown && !resumeBlocked && (analysis?.failure?.message || analysis?.error) ? (analysis.failure?.message || analysis.error) : undefined) || (pollError && pending ? '暂时无法读取进度，正在重试；已保留上次确认的步骤。'
    : pending ? analysis!.status === 'queued' ? `${pendingLabel}，等待执行位置。`
      : analysis?.progress?.stage === 'splitting' ? '正在完整读取当前文稿，重新进行全文分析。' : pendingLabel + '。'
      : interrupted ? semanticStop ? qualityStopLabels[qualitySummary!.stop_reason!] + ' 已保存的分析与待复核事项保留；请先查看具体意见。'
        : nextModelReason && !reconcile && !resumeBlocked ? nextModelReason
        : analysis.local_validation?.model_required && analysis.status === 'paused' && resume.action === 'continue'
        ? analysis.local_validation.summary
        : reconcile ? extractionOnly ? '上次请求的最终结果尚未确认。已保存结果保留；请处理未完成请求，先核对记录，再明确确认可能重复用量后才能继续。' : '有请求的最终结果尚未确认，系统将先检查能否恢复已有回答。'
        : resumeBlocked ? workflowBlocked ? '请求或执行流程暂时阻断，需要先检查具体原因；已保存结果仍保留。'
          : analysis.failure?.stage === 'format' ? '保存回答的格式尚未通过校验；已有回答和校验结果已保留。'
          : '保存回答尚未通过校验，需要先处理具体问题。'
          : resume.action === 'revalidate' ? `已保存${qualityTaskLabel ? `当前${qualityTaskLabel}的` : '的'}完整回答，可先在本地重新校验，不调用模型。`
            : workflowBlocked ? '请求或执行流程暂时阻断，已保存的分析结果仍保留。'
              : merging ? '人物归并尚未完成，已保存的任务结果会保留。'
              : analysis.failure?.stage === 'format' ? '模型回答的格式校验未通过，已保存的分析结果会保留。'
                : analysis.failure?.stage === 'evidence' ? '部分分析引用的原文证据尚未通过校验。'
                  : analysis.failure?.stage === 'content' ? '部分分析内容尚未通过核对。'
                    : analysis.status === 'paused' ? `分析已暂停，${sourceLabel}已保留，已保存的分析结果也会保留。`
                      : `当前阶段尚未完成，${sourceLabel}已保留，已保存的分析结果会保留。`
        : analysis?.status === 'ready' ? qualitySummary ? qualitySummary.review === 'pending' ? '当前分析仍待独立核对，保留待复核不代表已经通过。'
          : qualitySummary.access === 'scoped' ? '剧本地图已保存；相关问题仍待处理，仅明确不受影响的集数可继续创作。'
            : qualitySummary.access === 'blocked' ? '剧本地图已保存；当前实质问题尚未核对通过，相关创作仍受限制。'
              : qualitySummary.advisory ? '剧本地图可用，可继续创作；普通提示仍保留供回查。' : analysis.local_validation?.summary
          : analysis.local_validation?.summary
          : unavailable ? '请先选择可用文本模型。' : '分析只整理剧本资料，阶段文档仍需生成并确认保存。')
  const diagnostics = new Map<string, string[]>()
  const detail = (label: string, message?: string | null) => {
    if (message) diagnostics.set(message, [...diagnostics.get(message) || [], label])
  }
  detail(interrupted ? '上次处理项' : '处理进度', analysis?.progress?.message)
  if (analysis?.status !== 'ready') detail('恢复说明', resume.message)
  detail('恢复检查诊断', recovery?.message)
  detail('当前错误', analysis?.error)
  detail(analysis?.failure ? { format: '返回格式检查未通过', evidence: '证据检查未通过', content: '内容核对未通过', recovery: '请求或流程阻断' }[analysis.failure.stage] : '当前诊断', analysis?.failure?.message)
  detail('初始问题（历史记录）', analysis?.failure?.historical_diagnostics)
  for (const item of analysis?.story_progress?.pending || []) detail(`子任务 ${item.key}`, item.message)

  const newQualityRound = !extractionOnly && !!qualitySummary?.confirmation_required && !!qualitySummary.confirmation_scope && !reconcile && !resumeBlocked && !semanticStop
  const needsModelConfirmation = !extractionOnly && (newQualityRound || !!(next?.model_required ?? analysis?.local_validation?.model_required)) && interrupted && !reconcile && !resumeBlocked && !semanticStop && resume.action !== 'revalidate'
  const controlledRecovery = !!onRecover && interrupted && !semanticStop && (reconcile || resumeBlocked || resume.action === 'revalidate')
  const actionLabel = extractionOnly && recovery?.state === 'risk_required' ? '继续未完成项' : extractionOnly && recovery?.state === 'stopped' && reconcile ? '重新检查未完成项' : controlledRecovery ? '恢复分析' : reconcile ? extractionOnly ? '处理未完成请求' : '检查并恢复' : semanticStop ? '查看待复核事项' : resumeBlocked ? '查看校验问题'
    : resume.action === 'revalidate' ? '重新校验保存回答' : newQualityRound ? '确认新一轮质量处理' : needsModelConfirmation ? '继续生成未完成项'
      : interrupted ? extractionOnly && resume.available ? analysis?.local_validation?.model_required && resume.action === 'continue' ? '继续生成未完成项' : '继续分析' : resume.available ? '继续未完成步骤' : '重试分析' : '开始分析'
  const act = extractionOnly && recovery?.state === 'risk_required' ? onResolveRequest : controlledRecovery ? onRecover : resumeBlocked || semanticStop ? () => { setDetailsOpen(true); setDiagnosticsOpen(true) }
    : reconcile ? onResolveRequest : resume.action === 'revalidate' ? onRevalidate
      : needsModelConfirmation ? () => setConfirmingGeneration(true) : () => onStart()
  const actionUnavailable = !act || unavailable && !resumeBlocked && !semanticStop && !reconcile && resume.action !== 'revalidate'
  const saved = analysis?.story_progress
  const taskLabel = qualityTaskLabel || (extractionOnly ? phaseLabel : saved?.pending.length ? [...new Set(saved.pending.map(item => item.label))].join('、') : phaseLabel)

  const pendingGroups = new Map<string, NonNullable<ScriptSourceAnalysis['story_progress']>['pending'][number]>()
  for (const [index, item] of (saved?.pending || []).entries()) {
    const key = `${item.label}:${item.status}`, group = pendingGroups.get(key)
    const batch = /^\w+:(\d+)$/.exec(item.key)
    const scope = item.scope_label || `批次 ${batch ? Number(batch[1]) + 1 : index + 1}`
    if (group) group.scope_label += `、${scope}`
    else pendingGroups.set(key, { ...item, scope_label: scope })
  }
  const pendingTasks = extractionOnly ? [...pendingGroups.values()] : saved?.pending || []
  const analysisDetails = analysis && <>
        {!extractionOnly && <SourceQualitySummary analysis={analysis} />}
        <section className="sd-analysis-detail-group" aria-label="执行信息">
          <h4>执行信息</h4><dl className="sd-analysis-fields">
            <SourceAnalysisField label="当前阶段">{phaseLabel} · {stateLabel || (qualitySummary && qualitySummary.review !== 'passed' ? qualitySummary.review === 'pending' ? '待独立核对' : '仍有核对事项' : '已完成')}</SourceAnalysisField>
            <SourceAnalysisField label="保存范围">{saved ? `全剧整合：${saved.completed}/${saved.total} 项已完成` : `${analysis.sections.length} 段剧情已保存`}</SourceAnalysisField>
            {next && <SourceAnalysisField label="下一步">{resume.action === 'revalidate' ? '本地校验已保存回答，不调用模型'
              : reconcile ? '检查请求状态，不自动重新发送' : semanticStop ? '已停止新增模型请求，先查看待复核事项'
                : analysis.status === 'ready' && qualitySummary ? qualitySummary.access === 'usable' ? '可继续创作，保留提示供回查'
                  : qualitySummary.access === 'scoped' ? '仅明确不受影响的分集步骤可继续，相关内容仍待核对' : '先核对并处理影响创作的问题'
                  : next.model_required ? `${qualityTaskLabel}，确认后调用模型并产生用量` : '查看当前校验结果'}</SourceAnalysisField>}
          </dl>
          {saved && <p className="sd-analysis-detail-hint">{extractionOnly ? '计数为当前已展开的整合任务，已保存成果会复用。' : '计数范围仅为当前已展开的全剧整合子任务；后续仍可能展开人物归并，且独立质量核对另行进行。'}</p>}

        </section>
        {!!saved?.pending.length && <section className="sd-analysis-detail-group" aria-label="待处理任务">
          <h4>待处理任务</h4>
          {pendingTasks.map((item, index) => <div className="sd-analysis-task-detail" key={item.key}>
            <div><strong>{item.label}{item.scope_label ? ` · ${item.scope_label}` : ` · 批次 ${index + 1}`}</strong><span>{{ saved_response: '已保存完整回答，待校验', unknown_response: '请求结果尚未确认', correction_exhausted: '已保存纠正回答，校验未通过', pending: '尚未执行' }[item.status]}</span></div>

          </div>)}
        </section>}
        {!!saved?.protected_keys?.length && <section className="sd-analysis-detail-group" aria-label="保留请求">
          <h4>保留请求</h4><p className="sd-analysis-detail-hint">已保存结果通过本地校验不代表对应远端请求已结束；系统继续保留防重复保护。</p>
          <WorkspaceDisclosure label="保护任务编号"><SourceAnalysisIdentifier label="任务编号" value={saved.protected_keys.join("、")} /></WorkspaceDisclosure>
        </section>}
        <WorkspaceDisclosure label="请求标识"><SourceAnalysisIdentifier label="本轮分析编号" value={analysis.id} /></WorkspaceDisclosure>
        {!!diagnostics.size && <Accordion className="workspace-disclosure sd-analysis-diagnostics" value={diagnosticsOpen ? 'diagnostics' : null}
          onChange={value => setDiagnosticsOpen(value === 'diagnostics')} keepMounted keepMountedMode="display-none" transitionDuration={120}>
          <Accordion.Item value="diagnostics"><Accordion.Control className="workspace-disclosure-control">诊断记录</Accordion.Control><Accordion.Panel>
            <SourceAnalysisIdentifier label="未完成任务编号" value={(saved?.pending || []).map(item => item.key).join("、")} />
            <div className="sd-analysis-diagnostic-list">{[...diagnostics].map(([message, labels]) => <section key={labels.join(':')}>
              <h4>{labels.join(' / ')}：</h4><p>{message}</p>
            </section>)}</div>
          </Accordion.Panel></Accordion.Item>
        </Accordion>}
        {pending && revised && <p className="sd-analysis-detail-hint">{pollError ? '当前显示修订后有效稿的分析状态，剧本地图供后续阶段使用。'
          : analysis.status === 'queued' ? '有效稿已修订，等待更新剧本地图，供后续阶段使用。' : '有效稿已修订，正在更新剧本地图，供后续阶段使用。'}</p>}
        {pending && !pollError && <p className="sd-analysis-detail-hint">按实际处理步骤更新，单步耗时不代表剩余时间。</p>}
        {extractionOnly && analysis.recovery_progress && analysis.recovery_progress.attempts > 0 && <p className="sd-analysis-detail-hint">{pending ? '正在自动处理格式与引用问题' : '自动处理记录'} · 已使用 {analysis.recovery_progress.attempts}/{analysis.recovery_progress.max_requests} 次局部纠正，已保存 {analysis.recovery_progress.completed_responses} 份纠正回答；回答仍须通过校验，已有成果会复用。</p>}
        {analysis.failure?.stage === 'format' && <p className="sd-analysis-detail-hint">这是模型返回数据的格式问题，不表示剧本内容质量不合格。</p>}
        {workflowBlocked && <p className="sd-analysis-detail-hint">这是请求、授权或执行流程的阻断，不表示剧本内容质量不合格。</p>}
        {hasPreviousFailure && (pending || analysis.status === 'ready') && <p className="sd-analysis-detail-hint">这里显示当前文稿的分析状态；对话中的“未完成”是对应轮次的历史结果。</p>}

  </>
  return <section className="sd-source-analysis" data-mode={extractionOnly ? "extract" : undefined} aria-label="剧本分析状态">
    <div className="sd-source-analysis-status" role="status" aria-live="polite">
      <div className="sd-analysis-title">
        <span aria-label="当前分析阶段">{analysis?.status === 'ready'
          ? qualitySummary && (qualitySummary.review === 'pending' || qualitySummary.access !== 'usable')
            ? `剧本地图已保存 · ${qualitySummary.review === 'pending' ? '待独立核对' : qualitySummary.access === 'scoped' ? '部分范围待处理' : '质量核对未通过'}`
            : `${revised ? '当前有效稿的' : ''}剧本地图已准备 · ${analysis.sections.length} 段剧情`
          : analysis ? `当前阶段：${phaseLabel}` : revised ? '当前有效稿已修订，可更新剧本地图' : '原剧本已保存，可开始 AI 分析'}</span>
        {stateLabel && <span className="sd-analysis-state" data-state={analysis?.status}>{pending && !pollError ? <LoaderCircle size={11} className="script-director-spinner" /> : null}{stateLabel}</span>}
      </div>
      {!pending && analysis?.status !== 'ready' && <Button variant="light" size="compact-xs" loading={starting}
        disabled={actionUnavailable} leftSection={analysis?.status === 'failed' && !resumeBlocked ? <RotateCcw size={12} /> : undefined}
        onClick={act}>{actionLabel}</Button>}
      {extractionOnly && !pending && reconcile && onRequestDetails && <Button variant="subtle" size="compact-xs" onClick={onRequestDetails}>请求详情</Button>}
      {pending && (recovering ? onCancelRecovery : onPause) && <Button variant="subtle" size="compact-xs" loading={starting}
        onClick={recovering ? onCancelRecovery : onPause} leftSection={<Pause size={12} />}>{recovering ? '取消等待' : '暂停分析'}</Button>}
      {analysis?.status === 'ready' && (!qualitySummary || qualitySummary.review !== 'pending' && qualitySummary.access === 'usable') && <CheckCircle2 size={16} className="sd-analysis-ready" />}
    </div>
    {!extractionOnly && (pending || interrupted) && <List type="ordered" listStyleType="none" className="sd-source-analysis-steps" aria-label="剧本分析步骤" role="list">
      {(extractionOnly ? ['全文分析', '全剧整合'] : ['全文分析', '全剧整合', '质量核对']).map((label, index) => {
        const completed = index === 0 ? mapReady : index === 1 && !!analysis?.story
        const active = !completed && !pollError && analysis?.status === 'running' && index === step
        const stopped = !completed && interrupted && index === step
        const state = completed ? 'completed' : active ? 'active' : stopped ? analysis?.status : 'pending'
        return <List.Item key={label} data-state={state} aria-current={active ? 'step' : undefined}
          icon={<ThemeIcon size={17} radius="xl" variant="default" className="sd-source-analysis-step-icon" aria-hidden="true">{completed ? <Check size={10} /> : index + 1}</ThemeIcon>}>
          <span>{label}</span><span className="sd-source-analysis-step-state">{completed ? '已完成' : active ? '进行中' : stopped ? analysis?.status === 'paused' ? '已暂停' : '未完成' : '待处理'}</span>
        </List.Item>
      })}
    </List>}
    {(pending || interrupted) && <div className="sd-analysis-summary">
      {!extractionOnly && <span>当前任务<strong>{taskLabel}</strong></span>}
      {(saved || recovery?.summary) && <small aria-label="全剧整合进度">{extractionOnly ? `已保存 ${saved?.completed ?? recovery?.summary?.saved_count ?? 0} 项${saved ? ` / 当前计划 ${saved.total} 项（计划可能扩展）` : ''}` : `已展开子任务：${saved?.completed}/${saved?.total} 项已保存`}</small>}
      {analysis?.status === 'running' && !pollError && <SourceAnalysisElapsed key={analysis.id} startedAt={analysis.started_at} />}
    </div>}
    {!extractionOnly && recovery?.summary?.pending_items.length ? <p className="sd-analysis-detail-hint">未完成：{[...new Set(recovery.summary.pending_items.map(item => item.label + (item.scope_label ? `（${item.scope_label}）` : '')))].join('、')}</p> : null}
    {reason && <div className="sd-analysis-note" data-attention={interrupted || undefined} aria-label="分析状态说明">{reason}</div>}
    {analysis && (<Accordion className="workspace-disclosure sd-analysis-details" value={detailsOpen ? 'details' : null} onChange={value => setDetailsOpen(value === 'details')}
      keepMounted keepMountedMode="display-none" transitionDuration={120}>
      <Accordion.Item value="details"><Accordion.Control className="workspace-disclosure-control">技术详情</Accordion.Control><Accordion.Panel>{analysisDetails}</Accordion.Panel></Accordion.Item>
    </Accordion>)}
    <Modal opened={confirmingGeneration && needsModelConfirmation} onClose={() => setConfirmingGeneration(false)} title={newQualityRound ? '确认新一轮质量处理' : '继续生成未完成项'} centered size="sm" zIndex={310}>
      <p className="sd-analysis-confirm-note">{newQualityRound ? '上一轮已结束，独立复核产生了本轮待处理意见。确认后会调用所选模型开始新一轮定点处理并产生新的模型用量；旧结果和未确认请求记录继续保留。'
        : <>已保存并校验通过的结果会复用。接下来将调用所选模型{qualityTaskLabel ? `完成${qualityTaskLabel}` : '完成剩余任务'}，并产生模型用量。</>}</p>
      {newQualityRound && qualitySummary?.confirmation_scope && <WorkspaceDisclosure label="本轮确认范围">
        <SourceAnalysisIdentifier label="分析编号" value={qualitySummary.confirmation_scope.analysis_id} />
        <SourceAnalysisIdentifier label="独立复核指纹" value={qualitySummary.confirmation_scope.review_hash} />
        <SourceAnalysisIdentifier label="意见清单指纹" value={qualitySummary.confirmation_scope.findings_hash} />
      </WorkspaceDisclosure>}
      <div className="sd-source-dialog-actions">
        <Button variant="default" onClick={() => setConfirmingGeneration(false)}>取消</Button>
        <Button disabled={starting || unavailable || !needsModelConfirmation} onClick={() => {
          if (confirmationSubmit.current) return
          confirmationSubmit.current = true
          setConfirmingGeneration(false)
          onStart(newQualityRound && qualitySummary?.confirmation_scope ? {
            quality_scope: qualitySummary.confirmation_scope, confirm_new_quality_round: true,
          } : undefined)
        }}>{newQualityRound ? '确认并开始新一轮' : '继续生成'}</Button>
      </div>
    </Modal>
  </section>
}

function SourcePreviewContent({ source }: { source: ScriptSourceDocument }) {
  return <div className="sd-source-preview-body">{/\.(?:md|markdown)$/i.test(source.filename)
    ? <ScriptMessageContent text={source.content} tableLabel="剧本表格" />
    : source.content}</div>
}

/** Current extraction UI deliberately has no quality-audit/repair/recheck actions. */
/** Read-only inspection: opening or refreshing never reconciles or re-dispatches a request. */
function requestDiagnostic(details: import('./ScriptSourceRequestRecovery').SourceRequestRecovery) {
  const localTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { hour12: false }) : value
  return [details.reconciliation?.message || details.blocked_reason || '尚无完整回答', `分析：${details.analysis_id}`,
    ...details.blockers.map(item => [`时间：${localTime(item.updated_at)}`, `步骤：${item.scope}`,
      `本地请求：${item.local_request_id || '未记录'}`, `提供商请求：${item.upstream_request_id || '未记录'}`, `指纹：${item.request_key}`].join('\n'))].join('\n')
}

export function SourceRequestDetails({ source, opened, onClose }: { source: ScriptSourceDocument; opened: boolean; onClose: () => void }) {
  const [details, setDetails] = useState<import('./ScriptSourceRequestRecovery').SourceRequestRecovery | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!opened) return
    let current = true
    setLoading(true); setDetails(null); setError('')
    void api<import('./ScriptSourceRequestRecovery').SourceRequestRecovery>(`/projects/${source.project_id}/script/source/analysis/request-recovery`)
      .then(value => {
        if (!current) return
        if (value.analysis_id !== source.analysis?.id || value.source_updated_at !== source.updated_at) throw new Error('原稿或分析已变化，请关闭并重新打开当前请求详情。')
        setDetails(value)
      }).catch(issue => { if (current) setError(issue instanceof Error ? issue.message : '无法读取请求详情') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [opened, source.project_id, source.updated_at, source.analysis?.id, refresh])
  return <section hidden={!opened} aria-label="原稿分析请求详情">
    <p>已保存结果保留。这里只展示请求记录，不会重新发送。系统无法自动查询提供商最终状态。</p>
    {loading && <p role="status">正在读取请求记录…</p>}
    {error && <p role="alert">{error}</p>}
    {details && <WorkspaceDisclosure label="诊断信息">
      <code className="sd-request-diagnostic">{requestDiagnostic(details)}</code>
      <CopyButton value={requestDiagnostic(details)}>{({ copied, copy }) => <Button variant="subtle" size="compact-xs" onClick={copy}>{copied ? '已复制诊断' : '复制诊断信息'}</Button>}</CopyButton>
    </WorkspaceDisclosure>}
    <div className="sd-source-dialog-actions"><Button variant="default" loading={loading} onClick={() => setRefresh(value => value + 1)}>刷新请求详情</Button><Button onClick={onClose}>关闭</Button></div>
  </section>
}

export function ScriptSourcePreview({ source, sourceOnly = false, defaultTab = 'current', onReviewFeedback, reviewFeedbackSubmitting = false, reviewFeedbackUnavailable }: {
  source: ScriptSourceDocument; sourceOnly?: boolean; defaultTab?: 'current' | 'map' | 'story'; onReviewFeedback?: (feedback: string) => Promise<boolean>; reviewFeedbackSubmitting?: boolean; reviewFeedbackUnavailable?: string
}) {
  const analysis = sourceOnly ? null : source.analysis
  const [original, setOriginal] = useState<ScriptSourceDocument | null>(null)
  const [originalError, setOriginalError] = useState(false)
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [reviewFeedbackError, setReviewFeedbackError] = useState(false)
  const reviewFeedbackLock = useRef(false)
  const reviewFeedbackSource = useRef('')
  reviewFeedbackSource.current = `${source.project_id}:${source.updated_at}`
  useEffect(() => { setReviewFeedback(''); setReviewFeedbackError(false) }, [source.project_id, source.updated_at])
  useEffect(() => {
    let active = true
    setOriginal(null); setOriginalError(false)
    if (source.revision) void api<ScriptSourceDocument | null>(`/projects/${source.project_id}/script/source/original`)
      .then(value => { if (active) { setOriginal(value); setOriginalError(!value) } })
      .catch(() => { if (active) setOriginalError(true) })
    return () => { active = false }
  }, [source.project_id, source.updated_at, source.revision])
  return <><Tabs defaultValue={defaultTab} className="sd-source-preview-tabs">
    <Tabs.List><Tabs.Tab value="current">{source.revision ? '当前有效稿' : '原剧本'}</Tabs.Tab>{!!source.revision && <Tabs.Tab value="original">上传原稿</Tabs.Tab>}{!sourceOnly && <><Tabs.Tab value="map" disabled={!analysis?.sections.length}>剧本地图</Tabs.Tab><Tabs.Tab value="story" disabled={!analysis?.story}>全剧信息</Tabs.Tab></>}</Tabs.List>
    <Tabs.Panel value="current"><SourcePreviewContent source={source} /></Tabs.Panel>
    {!!source.revision && <Tabs.Panel value="original"><p className="sd-source-preview-hint">上传时的原稿保留供追溯，后续创作使用当前有效稿。</p>{originalError
      ? <div className="sd-source-preview-body">读取上传原稿失败，请重新打开文稿预览。</div>
      : original ? <SourcePreviewContent source={original} /> : <div className="sd-source-preview-body">正在读取上传原稿…</div>}</Tabs.Panel>}
    {!sourceOnly && <><Tabs.Panel value="map"><div className="sd-source-map">
      <p className="sd-source-preview-hint">{analysis?.status === 'ready' ? '以下是 AI 整理的检索资料，可展开原文核对。' : '分析仍在进行，以下只显示已完成部分。'}正式创作以原文和你的要求为准。</p>
      {analysis?.sections.map((section, index) => <section className="sd-source-map-section" key={`${section.offset}:${index}`}>
        <h3>{section.title}{section.continues_previous ? ' · 承接上一段剧情' : ''}</h3><p>{section.summary}</p>
        {!!section.characters.length && <div className="sd-source-map-characters"><strong>人物</strong>{section.characters.map((character, characterIndex) => <p key={characterIndex}><b>{character.name}</b> · {character.description}<small>{character.evidence.occurrence ? '身份/事实依据' : '原文'}：“{character.evidence.quote}”</small><SourceEvidenceLinks evidence={character.evidence} /></p>)}</div>}
        {!!section.events.length && <div className="sd-source-map-events"><strong>主要事件</strong>{section.events.map((event, eventIndex) => <p key={eventIndex}>{event.summary}<small>原文：“{event.evidence.quote}”</small><SourceEvidenceLinks evidence={event.evidence} /></p>)}</div>}
        <WorkspaceDisclosure label="查看这段原文"><div className="sd-source-map-original">{source.content.slice(section.offset, section.offset + section.length)}</div></WorkspaceDisclosure>
      </section>)}
    </div></Tabs.Panel>
    <Tabs.Panel value="story"><div className="sd-source-map">
      {analysis?.story && <>
        <p className="sd-source-preview-hint">以下信息来自当前有效稿的全剧整合，可按所列剧情段落回查原文；不代表新创作决定。</p>
        <section className="sd-source-map-section"><h3>全剧主线</h3><p>{analysis.story.summary}</p></section>
        <section className="sd-source-map-section"><h3>背景设定与规则</h3>{analysis.story.settings?.length ? analysis.story.settings.map((item, index) => <p key={index}>{item.description}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>) : <p>未单独提取设定时，以原文及已保存的故事资料为准，无需重复分析。</p>}</section>
        <section className="sd-source-map-section"><h3>人物与身份</h3>{analysis.story.characters.map((item, index) => <p key={index}><b>{item.name}</b>{item.aliases.length ? `（${item.aliases.join('、')}）` : ''} · {item.description}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}</section>
        <section className="sd-source-map-section"><h3>事件与因果</h3>{analysis.story.timeline.map((item, index) => <p key={index}>{item.summary}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}</section>
        <section className="sd-source-map-section"><h3>伏笔与回收</h3>{analysis.story.threads.length ? analysis.story.threads.map((item, index) => <p key={index}>{item.setup}<small>{item.payoff || '原稿未明确回收'} · 剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>) : <p>原稿未识别到明确的伏笔与回收。</p>}</section>
        <section className="sd-source-map-section"><h3>结局与最终状态</h3><p>{analysis.story.ending.summary}</p></section>
        {!!analysis.story.uncertainties.length && <section className="sd-source-map-section"><h3>需核对的信息</h3>{analysis.story.uncertainties.map((item, index) => <p key={index}>{item.description}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}<p>这些原稿未明确的信息会保留供回查，不启动质量审核或阻止制作；创作以原文和你的要求为准。</p></section>}
      </>}
    </div></Tabs.Panel>
  </>}
  </Tabs>
    {!sourceOnly && onReviewFeedback && <form className="sd-source-map-section" onSubmit={async event => {
      event.preventDefault()
      const feedback = reviewFeedback.trim()
      if (!feedback || reviewFeedbackLock.current || reviewFeedbackSubmitting || reviewFeedbackUnavailable) return
      const submittedSource = reviewFeedbackSource.current
      reviewFeedbackLock.current = true
      setReviewFeedbackError(false)
      try {
        const submitted = await onReviewFeedback(feedback)
        if (reviewFeedbackSource.current !== submittedSource) return
        if (submitted) setReviewFeedback(current => current.trim() === feedback ? '' : current)
        else setReviewFeedbackError(true)
      } catch {
        if (reviewFeedbackSource.current === submittedSource) setReviewFeedbackError(true)
      } finally { reviewFeedbackLock.current = false }
    }}>
      <Textarea label="反馈分析问题" value={reviewFeedback} onChange={event => { setReviewFeedback(event.currentTarget.value); setReviewFeedbackError(false) }}
        description="指出有问题的分析内容及对应原文。系统将独立核实，反馈不会直接成为事实或修改原稿。"
        placeholder="例如：时间线把大纲中的规划事件当成正文已发生，请对照原文标题和具体段落重新核实。"
        autosize minRows={3} maxRows={8} maxLength={6000} disabled={reviewFeedbackSubmitting}
        error={reviewFeedbackError ? '反馈未提交，输入已保留。请核对当前文稿、模型和分析状态后重试。' : undefined} />
      <div className="sd-source-dialog-actions"><small>{reviewFeedbackUnavailable || `${reviewFeedback.length}/6000`}</small>
        <Button type="submit" variant="default" loading={reviewFeedbackSubmitting} disabled={!reviewFeedback.trim() || !!reviewFeedbackUnavailable}>提交并重新核对</Button>
      </div>
    </form>}
  </>
}

function SourceEvidenceLinks({ evidence }: { evidence: ScriptSourceEvidence }) {
  return <>
    {evidence.occurrence && <small>本章出场：“{evidence.occurrence.quote}”</small>}
    {!!evidence.supporting?.length && <span>{evidence.supporting.length} 处辅助证据（完整原文中保留）</span>}
  </>
}
