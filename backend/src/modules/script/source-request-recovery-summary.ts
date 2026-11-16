import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceRecoverySummary, SourceRequestRecoveryProgress } from '@video-studio/shared/script/script-source-request-recovery'
import { sourceStoryProgress } from './script-source-story-progress.js'

/** Presentation only. It cannot create an allowance or establish delivery facts. */
export function sourceRecoverySummary(state: ScriptSourceAnalysis, recovery?: SourceRequestRecoveryProgress, unknownRequests = 0): SourceRecoverySummary {
  const story = sourceStoryProgress(state)
  const saved = state.story_work?.tasks.filter(task => task.result !== undefined).length ?? state.completed_chunks
  const pending = story?.pending.map(({ label, scope_label, status }) => ({ label, scope_label, status })) ||
    (state.status === 'ready' ? [] : [{ label: state.phase === 'synthesis' ? '全剧整合' : '原文地图', status: 'pending' }])
  const reason = state.status === 'ready' ? '已复用本地结果，原稿分析完成。'
    : recovery?.outcome === 'risk_required' ? '部分请求未收到完整结果，继续前需确认可能产生的重复费用。'
      : recovery?.outcome === 'running' ? recovery.phase === 'local_recovery' ? '正在检查并复用本地保存结果，不发送模型请求。' : '正在处理未完成的分析。'
        : unknownRequests > 1 ? '仍有多笔请求未收到完整结果，当前不能一次重新发送；已保存结果保留。'
          : state.local_validation?.model_required && !pending.some(item => item.status === 'unknown_response')
          ? '已复用本地结果，剩余资料尚未生成。'
          : pending.some(item => item.status === 'unknown_response') ? '部分请求仍未收到完整结果，当前没有安全的重发范围，请先核对提供商记录。'
            : state.failure?.stage === 'format' ? '已保存回答尚未通过格式校验，请查看具体问题；完成项会保留。'
              : state.failure?.stage === 'evidence' ? '部分原文引用尚未通过校验，请查看具体问题；完成项会保留。'
          : '目前没有可用的继续范围。已保存结果保留，可查看诊断或取得完整回答后重新检查。'
  return { saved_count: saved, pending_items: pending, reason }
}
