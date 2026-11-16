import { sourceTransferredPlan } from './script-source-page-transfer.js'
import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourcePartOutputCheckpoint } from '@video-studio/shared/script/script-source-document'
import { sourceCheckpointLeaf, sourceCheckpointResponseFact } from '@video-studio/shared/script/script-source-request-recovery'
import { sourceStoryResume } from './script-source-story-progress.js'
import { hasUsableSourceQuality, sourceQualitySummary, sourceQualityInputHash } from './script-source-quality.js'
import { sourceQualityRepairProgress } from './script-source-quality-repair.js'
import { validateSourceStory } from './script-source-story.js'
import { scriptSourcePassages, sourceAnalysisPipelineVersion, sourceMapSchema, sourceWorkPlan,
  validateSourceCoverage, type SourcePassage } from './script-source-map.js'

/** Version 5 already read the full source. Changing output granularity does not
 * invalidate its completed, evidence-checked map or a saved map awaiting repair. */
export function prepareSourceWork(content: string, state: ScriptSourceAnalysis): SourcePassage[] {
  const passages = scriptSourcePassages(content), plan = sourceTransferredPlan(sourceWorkPlan(passages, state.map_output_policy === 'dense-v1'), state, passages)
  const supported = state.pipeline_version === sourceAnalysisPipelineVersion || state.pipeline_version === 5
  if (supported) {
    try {
      const complete = state.total_chunks > 0 && state.completed_chunks === state.total_chunks
      if (complete) {
        validateSourceCoverage(content, state.sections)
        if (state.story) {
          try { validateSourceStory(state, state.story, { content }) }
          catch { state.story = undefined; state.story_work = undefined; state.story_candidate = undefined; state.story_response_run_ids = undefined; state.quality = undefined; state.quality_work = undefined; state.quality_repair = undefined }
        }
        state.work = plan
        state.completed_chunks = plan.length; state.total_chunks = plan.length
        state.completed_characters = content.length; state.pipeline_version = sourceAnalysisPipelineVersion
        state.phase = state.status === 'ready' && (state.analysis_mode === 'extract' || hasUsableSourceQuality(state)) ? 'ready' : 'synthesis'
        return passages
      }
      const work = state.work
      const matchesPlan = state.pipeline_version === sourceAnalysisPipelineVersion && work?.length === plan.length &&
        work.every((item, index) => item.offset === plan[index]!.offset && item.length === plan[index]!.length && item.depth === 0)
      const savedWholeMap = work?.length === 1 && work[0]!.offset === 0 && work[0]!.length === content.length &&
        work[0]!.depth === 0 && !!work[0]!.result && state.completed_chunks === 0
      if ((matchesPlan || savedWholeMap) && Number.isSafeInteger(state.completed_chunks) &&
        state.completed_chunks >= 0 && state.completed_chunks < work!.length) {
        const end = state.completed_chunks ? work![state.completed_chunks - 1]!.offset + work![state.completed_chunks - 1]!.length : 0
        validateSourceCoverage(content.slice(0, end), state.sections, content)
        const current = work![state.completed_chunks]!
        if (current.result) {
          // Schema-valid candidates may still need guarded boundary/evidence
          // repair. Keep them private; only appended sections count as coverage.
          try { sourceMapSchema.parse(current.result) }
          catch {
            if (!matchesPlan) throw new Error('旧版全文目录检查点无效')
            delete current.result
          }
        }
        state.total_chunks = work!.length; state.completed_characters = end
        state.pipeline_version = sourceAnalysisPipelineVersion; state.phase = 'reading'
        state.story = undefined; state.story_work = undefined; state.story_candidate = undefined; state.story_response_run_ids = undefined; state.quality_repair = undefined
        return passages
      }
    } catch { /* Invalid intermediate results are rebuilt, never published. */ }
  }
  if (state.revision_reuse?.status === 'pending') state.revision_reuse.status = 'discarded'
  state.sections = []; state.story = undefined; state.story_work = undefined; state.story_candidate = undefined; state.story_response_run_ids = undefined; state.synthesis = undefined; state.quality = undefined; state.quality_work = undefined; state.quality_rebuild_for = undefined; state.quality_repair = undefined
  state.work = plan; state.completed_chunks = 0; state.completed_characters = 0
  state.total_chunks = plan.length; state.pipeline_version = sourceAnalysisPipelineVersion; state.phase = 'reading'
  return passages
}

function sourceQualityPhaseResume(phase: 'quality_repair' | 'quality_review', checkpoint: ScriptSourcePartOutputCheckpoint | undefined,
  prefix: string, blocked: boolean): NonNullable<ScriptSourceAnalysis['resume']> {
  const facts = sourceCheckpointResponseFact(checkpoint), { saved, response } = facts
  const unknown = facts.initial_unknown || facts.correction_unknown
  // A complete local answer may be checked while an unrelated old request
  // retains its protection. Neither this metadata nor local replay grants a
  // new dispatch or treats a started request without its answer as complete.
  if (saved && !unknown) return { available: true, action: 'revalidate',
    next: { phase, response, model_required: false },
    message: prefix + '当前完整回答已保存；先在本地重新校验，不调用模型，也不刷新已使用的纠正额度。' }
  if (unknown || blocked) return { available: false, blocked: true, action: 'reconcile_request',
    next: { phase, response, model_required: false },
    message: prefix + '有请求的最终结果尚未确认；先检查已保存回答与请求状态，并核对提供商记录，不会自动重新发送。' }
  return { available: true, action: 'continue', next: { phase, response, model_required: true },
    message: prefix + '当前步骤尚无完整回答；明确继续后会调用所选模型并产生用量。' }
}

/** Withdrawal notes are part of a post-repair review's actual input. Use its
 * saved binding only while the workflow still describes this exact analysis
 * and completed repair set. This is display metadata, never a dispatch grant. */
function sourceQualityReviewCheckpoint(state: ScriptSourceAnalysis): ScriptSourcePartOutputCheckpoint | undefined {
  const currentHash = sourceQualityInputHash(state), grant = state.ordinary_story_dispatch
  const workflow = grant?.quality_workflow, review = state.quality, work = state.quality_work
  const currentRecheck = grant?.run_id === state.id && workflow?.phase === 'review' && review?.status === 'issues' &&
    state.quality_rebuild_for !== review.input_hash && workflow.review_hash === review.input_hash &&
    workflow.findings_hash === createHash('sha256').update(JSON.stringify(review.findings)).digest('hex') &&
    workflow.current_hash === currentHash && workflow.finding_index === review.findings.length &&
    workflow.finding_index === sourceQualityRepairProgress(state) && !!workflow.review_input_hash
  const reviewInputHash = currentRecheck ? workflow.review_input_hash : currentHash
  return work?.input_hash === reviewInputHash ? work?.output_checkpoint : undefined
}

/** The recovery dialog and resume label inspect the same current checkpoint.
 * Selection proves a location, never a remote delivery outcome or permission. */
export function sourceAnalysisRecoveryCheckpoints(state: ScriptSourceAnalysis): Array<{
  checkpoint?: ScriptSourcePartOutputCheckpoint; binding?: string; phase: 'initial' | 'correction'
}> {
  let checkpoint: ScriptSourcePartOutputCheckpoint | undefined, binding: string | undefined
  if (state.story) {
    const repairing = state.quality?.status === 'issues' && state.quality_rebuild_for !== state.quality.input_hash &&
      (sourceQualityRepairProgress(state) ?? 0) < state.quality.findings.length
    if (repairing) {
      checkpoint = state.quality_repair_batch?.checkpoint || state.quality_repair_output?.checkpoint
      const selectedBinding = state.quality_repair_batch?.binding || state.quality_repair_output?.binding
      binding = typeof selectedBinding === 'string' ? selectedBinding : selectedBinding ? createHash('sha256').update(JSON.stringify(selectedBinding)).digest('hex') : undefined
    } else checkpoint = sourceQualityReviewCheckpoint(state)
  } else {
    const pending = state.story_work?.tasks.filter(task => task.result === undefined) || []
    const candidate = state.work?.[state.completed_chunks]?.output_checkpoint || state.story_candidate?.output_checkpoint
    if (!candidate && pending.length) return pending.map(task => {
      const value = task.output_candidate?.checkpoint || task.output_checkpoint
      const checkpoint = sourceCheckpointLeaf(value && !('steps' in value) ? value : undefined)
      return { checkpoint, binding: task.output_candidate?.context_hash,
        phase: sourceCheckpointResponseFact(checkpoint).correction_unknown ? 'correction' as const : 'initial' as const }
    })
    checkpoint = candidate && !('steps' in candidate) ? candidate : undefined
  }
  checkpoint = sourceCheckpointLeaf(checkpoint)
  return [{ checkpoint, binding, phase: sourceCheckpointResponseFact(checkpoint).correction_unknown ? 'correction' : 'initial' }]
}

export function sourceAnalysisRecoveryCheckpoint(state: ScriptSourceAnalysis) {
  const facts = sourceAnalysisRecoveryCheckpoints(state)
  return facts.find(value => sourceCheckpointResponseFact(value.checkpoint).response === 'unknown_response') ||
    facts.find(value => sourceCheckpointResponseFact(value.checkpoint).saved) || facts[0]!
}

export function sourceAnalysisResume(state: ScriptSourceAnalysis, blocked = false): NonNullable<ScriptSourceAnalysis['resume']> {
  const pageCount = (checkpoint: { steps: Record<string, { value: unknown }> } | undefined) => Object.values(checkpoint?.steps || {}).reduce((count, step) => {
    const value = step.value as { items?: unknown[] } | null
    return count + (Array.isArray(value?.items) ? value.items.length : 0)
  }, 0)
  if (state.analysis_mode === 'extract') {
    if (state.status === 'ready') return { available: true, message: '原文索引和全剧资料已保存，可复用；无需质量审核通过。' }
    if (blocked) return { available: false, blocked: true, action: 'reconcile_request', message: '上次分析请求结果尚未确认，已保留资料；先核对提供商记录与原请求，不能直接重发。' }
    if (state.story) return { available: true, action: 'revalidate', message: '全剧资料已保存，可在本地完成技术校验，不进入质量审核。' }
    const story = sourceStoryResume(state)
    if (story) return story
    if (state.story_candidate?.result || state.story_candidate?.output_checkpoint?.raw) return { available: true, action: 'continue',
      message: '完整目录和全剧整合候选已保存；继续仅处理未完成的人物资料与技术校验，不进行质量审核。' }
    const checkpoint = state.work?.[state.completed_chunks]?.output_checkpoint
    const items = pageCount(checkpoint?.pages) || checkpoint?.seed?.sections.length || 0
    if (items) return { available: true, action: 'continue',
      message: `已保存 ${state.completed_chunks}/${state.total_chunks} 页目录（${state.sections.length} 段）及当前页 ${items} 个完整条目；继续后补齐当前页，再校验边界与原文证据，不进行质量审核。` }
    return { available: true, action: 'continue', message: state.completed_chunks ? '已保存的原文索引将复用，只处理未完成的分析。' : '继续读取原稿并整理资料，不进行质量审核。' }
  }
  const quality = sourceQualitySummary(state)
  if (quality.stop_reason) return { available: false, action: 'blocked', message: quality.message || '当前质量处理需要先核对具体意见；已有回答和分析已保留，不会原样重复生成。' }
  const review = state.quality, repair = state.quality_repair
  const boundRepair = !!state.story && review?.status === 'issues' && !!review.findings.length && !!repair &&
    repair.review_hash === review.input_hash && repair.findings_hash === createHash('sha256').update(JSON.stringify(review.findings)).digest('hex') &&
    repair.current_hash === sourceQualityInputHash(state) && Number.isSafeInteger(repair.completed_findings) &&
    repair.completed_findings >= 0 && repair.completed_findings <= review.findings.length
  // A historical counter cannot turn withdrawn into an explicit retain
  // decision. Preserve all saved bytes and unknown-request markers; this is
  // display metadata only and must not advertise a new paid continuation.
  if (boundRepair && repair.withdrawals?.length) return { available: false, blocked: true, action: 'blocked',
    message: '历史withdrawn只作为旧处理记录保留，不能自动解释为保留分析或核对通过；请先核对具体意见。已有回答、分析及未知请求保护均已保留，本轮不会新增请求。' }
  if (state.controlled_recovery?.closed_at && ['paused', 'failed'].includes(state.status) && state.local_validation?.model_required) return {
    available: false, blocked: true, action: 'reconcile_request',
    message: '上一轮处理已停止，已保存结果继续保留；请恢复以核对剩余范围及是否需要新的模型用量确认，当前不会自动发送模型请求。' }
  const repairProgress = sourceQualityRepairProgress(state)
  if (repairProgress !== null && repair?.decisions?.some(decision =>
    decision.finding_index === repairProgress && decision.decision === 'requires_full_rebuild')) return {
    available: false, blocked: true, action: 'blocked',
    message: '无法安全局部处理的重建决定已保存；请先确认新的处理范围。原始分析、回答及未知请求保护均已保留，继续操作不会自动重建或新增请求。' }
  if (state.status === 'ready' && hasUsableSourceQuality(state)) return { available: true, message: quality.access === 'scoped' ? '目录和全剧信息已保存；相关待定信息只限制对应章节，其他明确范围可继续创作。' : quality.advisory ? '目录和全剧信息可使用；普通待定信息已保留为提示。' : '目录、全剧信息和独立质量核对已完成。' }
  if (state.story && state.quality?.status === 'issues' && state.quality_rebuild_for !== state.quality.input_hash) {
    const completed = sourceQualityRepairProgress(state) ?? 0, total = state.quality.findings.length
    const prefix = completed >= total
      ? '目录、全剧信息及问题处理记录已保存；继续后完成全文独立质量核对。'
      : `目录和全剧信息已保存${completed ? `，已处理 ${completed}/${total} 项意见` : ''}；继续后处理未完成的核对意见，再做全文独立核对。`
    return completed >= total ? sourceQualityPhaseResume('quality_review', sourceQualityReviewCheckpoint(state), prefix, blocked)
      : sourceQualityPhaseResume('quality_repair', state.quality_repair_batch?.checkpoint || state.quality_repair_output?.checkpoint, prefix, blocked)
  }
  if (blocked && !state.story) return { available: false, blocked: true, action: 'reconcile_request', message: '已完成的分析已保留。上次请求的最终结果尚未确认；先检查已保存回答与请求状态，并核对提供商记录，当前不会自动重新生成。' }
  const storyResume = sourceStoryResume(state)
  if (storyResume) return storyResume
  const qualityItems = pageCount(state.quality_work?.checkpoint)
  if (state.story) {
    if (hasUsableSourceQuality(state)) return { available: true, message: '目录、全剧信息和独立质量核对已完成。' }
    return sourceQualityPhaseResume('quality_review', sourceQualityReviewCheckpoint(state),
      qualityItems ? `目录、全剧信息及 ${qualityItems} 项完整核对结果已保存；继续后只处理剩余核对结果。`
        : '目录和全剧信息已保存；继续后完成独立质量核对。', blocked)
  }
  const savedCorrection = state.work?.[state.completed_chunks]?.output_checkpoint || state.story_candidate?.output_checkpoint
  if (savedCorrection?.correction) return { available: true,
    message: '完整候选和已完成的纠正回答已保存；继续会先在本地重新校验，不重新购买整批纠正。仍有问题时保留有效操作并显示具体失败项。' }
  if (savedCorrection && 'correction_started' in savedCorrection && savedCorrection.correction_started) return { available: false, blocked: true,
    message: '纠正请求已开始但尚无完整回答，已保留请求保护；继续不会重新发送，请先核对请求最终结果。' }
  if (state.story_candidate?.result || state.story_candidate?.output_checkpoint?.raw) return { available: true,
    message: '完整目录和全剧整合候选已保存；继续后校验并修补未完成的人物信息，再独立核对。' }
  const tasks = state.story_work?.tasks || [], completed = tasks.filter(task => task.result !== undefined).length
  const partialItems = tasks.reduce((count, task) => count + pageCount(task.output_checkpoint), 0)
  if (partialItems) return { available: true, message: `目录、${completed} 项全剧整合任务及 ${partialItems} 个完整条目已保存；继续后处理未完成条目，再独立核对。` }
  if (completed) return { available: true,
    message: `目录及 ${completed}/${tasks.length} 项全剧整合结果已保存；继续后处理未完成项，再独立核对。` }
  if (state.total_chunks > 0 && state.completed_chunks === state.total_chunks) return { available: true,
    message: `已保存完整目录（${state.sections.length} 段）；继续后整理全剧信息，再独立核对。` }
  const mapCheckpoint = state.work?.[state.completed_chunks]?.output_checkpoint
  const mapItems = pageCount(mapCheckpoint?.pages) || mapCheckpoint?.seed?.sections.length || 0
  if (mapItems) return { available: true,
    message: `已保存 ${state.completed_chunks}/${state.total_chunks} 页目录（${state.sections.length} 段）及当前页 ${mapItems} 个完整条目；继续后补齐当前页，再校验边界与原文证据。` }
  const savedMap = !!state.work?.[state.completed_chunks]?.result || !!state.work?.[state.completed_chunks]?.output_checkpoint?.raw
  if (state.completed_chunks > 0 || savedMap) return { available: true,
    message: `已保存 ${state.completed_chunks}/${state.total_chunks} 页目录（${state.sections.length} 段）${savedMap ? '及当前页待校验或修复的完整候选' : ''}；继续后从未完成处处理。` }
  return { available: false, message: '原稿已保留，尚无校验通过的分析结果；重试将从目录开始。' }
}

export function sourceAnalysisStepLabel(state: ScriptSourceAnalysis) {
  if (state.progress?.stage === 'repairing' && state.story) return '分析问题修补'
  if (state.story) return '独立质量核对'
  if (state.phase === 'synthesis') return '全剧整合'
  return `目录第 ${Math.min(state.completed_chunks + 1, state.total_chunks || 1)}/${state.total_chunks || 1} 页${state.progress?.stage === 'repairing' ? '证据修复' : '生成'}`
}
