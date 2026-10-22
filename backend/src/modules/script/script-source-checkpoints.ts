import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { hasPassedSourceQuality } from './script-source-quality.js'
import { sourceQualityRepairProgress } from './script-source-quality-repair.js'
import { validateSourceStory } from './script-source-story.js'
import { scriptSourcePassages, sourceAnalysisPipelineVersion, sourceMapSchema, sourceSectionRanges, sourceWorkPlan,
  validateSourceCoverage, workPassages, type SourcePassage } from './script-source-map.js'

/** Version 5 already read the full source. Changing output granularity does not
 * invalidate its completed, evidence-checked map or a saved map awaiting repair. */
export function prepareSourceWork(content: string, state: ScriptSourceAnalysis): SourcePassage[] {
  const passages = scriptSourcePassages(content), plan = sourceWorkPlan(passages)
  const supported = state.pipeline_version === sourceAnalysisPipelineVersion || state.pipeline_version === 5
  if (supported) {
    try {
      const complete = state.total_chunks > 0 && state.completed_chunks === state.total_chunks
      if (complete) {
        validateSourceCoverage(content, state.sections)
        if (state.story) {
          try { validateSourceStory(state, state.story) }
          catch { state.story = undefined; state.story_work = undefined; state.quality = undefined; state.quality_repair = undefined }
        }
        state.work = plan
        state.completed_chunks = plan.length; state.total_chunks = plan.length
        state.completed_characters = content.length; state.pipeline_version = sourceAnalysisPipelineVersion
        state.phase = state.status === 'ready' && hasPassedSourceQuality(state) ? 'ready' : 'synthesis'
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
        validateSourceCoverage(content.slice(0, end), state.sections)
        const current = work![state.completed_chunks]!
        if (current.result) {
          // Raw maps can have evidence awaiting precise repair, but must have
          // real ordered boundaries before being offered as a checkpoint.
          try { sourceSectionRanges(sourceMapSchema.parse(current.result), workPassages(passages, current)) }
          catch {
            if (!matchesPlan) throw new Error('旧版全文目录检查点无效')
            delete current.result
          }
        }
        state.total_chunks = work!.length; state.completed_characters = end
        state.pipeline_version = sourceAnalysisPipelineVersion; state.phase = 'reading'
        state.story = undefined; state.story_work = undefined; state.quality_repair = undefined
        return passages
      }
    } catch { /* Invalid intermediate results are rebuilt, never published. */ }
  }
  if (state.revision_reuse?.status === 'pending') state.revision_reuse.status = 'discarded'
  state.sections = []; state.story = undefined; state.story_work = undefined; state.synthesis = undefined; state.quality = undefined; state.quality_rebuild_for = undefined; state.quality_repair = undefined
  state.work = plan; state.completed_chunks = 0; state.completed_characters = 0
  state.total_chunks = plan.length; state.pipeline_version = sourceAnalysisPipelineVersion; state.phase = 'reading'
  return passages
}

export function sourceAnalysisResume(state: ScriptSourceAnalysis): NonNullable<ScriptSourceAnalysis['resume']> {
  if (state.story && state.quality?.status === 'issues' && state.quality_rebuild_for !== state.quality.input_hash) {
    const completed = sourceQualityRepairProgress(state) ?? 0, total = state.quality.findings.length
    return { available: true, message: completed >= total
      ? '目录、全剧信息及问题修补结果已保存；继续后完成全文独立质量核对。'
      : `目录和全剧信息已保存${completed ? `，已修补 ${completed}/${total} 项问题` : ''}；继续后逐项修补未完成的问题，再做全文独立核对。` }
  }
  if (state.story) return { available: true, message: '目录和全剧信息已保存；继续后完成独立质量核对。' }
  const tasks = state.story_work?.tasks || [], completed = tasks.filter(task => task.result !== undefined).length
  if (completed) return { available: true,
    message: `目录及 ${completed}/${tasks.length} 项全剧整合结果已保存；继续后处理未完成项，再独立核对。` }
  if (state.total_chunks > 0 && state.completed_chunks === state.total_chunks) return { available: true,
    message: `已保存完整目录（${state.sections.length} 段）；继续后整理全剧信息，再独立核对。` }
  const savedMap = !!state.work?.[state.completed_chunks]?.result
  if (state.completed_chunks > 0 || savedMap) return { available: true,
    message: `已保存 ${state.completed_chunks}/${state.total_chunks} 页目录（${state.sections.length} 段）${savedMap ? '及当前页待修复目录' : ''}；继续后从未完成处处理。` }
  return { available: false, message: '原稿已保留，尚无校验通过的分析结果；重试将从目录开始。' }
}

export function sourceAnalysisStepLabel(state: ScriptSourceAnalysis) {
  if (state.progress?.stage === 'repairing' && state.story) return '分析问题修补'
  if (state.story) return '独立质量核对'
  if (state.phase === 'synthesis') return '全剧整合'
  return `目录第 ${Math.min(state.completed_chunks + 1, state.total_chunks || 1)}/${state.total_chunks || 1} 页${state.progress?.stage === 'repairing' ? '证据修复' : '生成'}`
}
