import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceCheckpointLeaf, sourceCheckpointResponseFact } from '@video-studio/shared/script/script-source-request-recovery'
import { hasSourceStoryCorrectionContinuation, isUnstartedSourceStoryTask } from './script-source-ordinary-dispatch.js'
export const sourceStoryReplayVersion = 3
const labels: Record<string, string> = { overview: '全剧概览与结局', characters: '人物与身份', characters_merge: '人物归并',
  timeline: '事件与因果', threads: '伏笔与回收', uncertainties: '不确定事项' }

/** Public metadata only: never publish complete answers, prompts or hashes. */
export function sourceStoryProgress(state: ScriptSourceAnalysis): ScriptSourceAnalysis['story_progress'] {
  if (state.story || !state.story_work?.tasks.length) return
  const tasks = state.story_work.tasks
  return { completed: tasks.filter(task => task.result !== undefined).length, total: tasks.length, protected_keys: tasks.filter(task => task.output_candidate?.checkpoint.correction_started && !task.output_candidate.checkpoint.correction).map(task => task.key),
    pending: tasks.filter(task => task.result === undefined).map(task => {
      const cp = sourceCheckpointLeaf(task.output_candidate?.checkpoint)
      const fact = sourceCheckpointResponseFact(cp)
      const status = fact.response === 'unknown_response' ? 'unknown_response' : cp?.correction ? 'correction_exhausted'
        : fact.saved ? 'saved_response' : 'pending'
      const batch = /^\w+:(\d+)$/.exec(task.key)
      const dependencyBlocked = /^characters:[1-9]\d*$/.test(task.key) && !task.failure && !task.output_candidate &&
        tasks.some(parent => ['overview', 'characters:0'].includes(parent.key) && parent.result === undefined)
      const dependencyMessage = task.execution?.status === 'blocked' ? task.execution.message : dependencyBlocked
        ? '前置人物发现尚未完成，本批尚未派发；前置结果可用后继续处理' : undefined
      return { key: task.key, label: labels[task.key.split(':')[0]!] || '全剧整合', status,
        ...(batch ? { scope_label: `批次 ${Number(batch[1]) + 1}` } : {}),
        ...(task.failure ? { message: task.failure.message } : dependencyMessage ? { message: dependencyMessage } : {}) }
    }) }
}

export function sourceStoryResume(state: ScriptSourceAnalysis): ScriptSourceAnalysis['resume'] {
  const progress = sourceStoryProgress(state)
  if (!progress?.pending.length) return
  const pending = state.story_work!.tasks.filter(task => task.result === undefined)
  const statusLabels = { unknown_response: '请求结果未知', correction_exhausted: '完整纠正回答格式或引用未通过', saved_response: '完整回答待本地校验', pending: '尚未完成' }
  const prefix = `目录及 ${progress.completed}/${progress.total} 项全剧整合结果已保存；剩余：${progress.pending.map(item => `${item.label}（${item.key}：${statusLabels[item.status]}）`).join('、')}。`
  // A local pass already scanned all complete siblings. Missing, genuinely
  // unstarted tasks now need explicit normal generation, not another replay.
  if (state.analysis_mode === 'extract' && state.local_validation?.model_required && pending.every(isUnstartedSourceStoryTask)) return {
    available: true, action: 'continue', message: prefix + '本地保存回答已校验完成；继续只生成尚未派发的内容，会调用模型并产生用量，已保存结果直接复用。',
  }
  // An upgrade may revalidate old bytes or look up exact completed ledger
  // responses once. A failed replay records its version, so no-op continuation
  // is not offered indefinitely as if it could replenish a correction.
  if (pending.some(task => hasSourceStoryCorrectionContinuation(state, task)) &&
    pending.every(task => isUnstartedSourceStoryTask(task) || hasSourceStoryCorrectionContinuation(state, task))) return {
    available: true, action: 'revalidate', message: prefix + '当前新任务的完整回答已保存；先在本地重新校验和复用现有回答，不发送模型请求，也不消费其尚未派发的首次纠正。',
  }
  if (pending.some(task => task.failure?.code === 'source_request_sibling_pending') && pending.every(isUnstartedSourceStoryTask)) return {
    available: true, action: 'continue', message: prefix + '可明确继续尚未派发的新任务；新任务使用独立普通授权，旧请求及其专属恢复许可保持不变。',
  }
  if (pending.some(task => task.failure?.code === 'source_request_sibling_pending' && !hasSourceStoryCorrectionContinuation(state, task))) return { available: false, blocked: true, action: 'reconcile_request',
    message: prefix + '其他子任务的请求仍待核对；已保存回答可复用，但其恢复许可不能用于当前子任务。' }
  if (pending.some(task => sourceCheckpointResponseFact(task.output_candidate?.checkpoint).response === 'unknown_response')) return { available: false, blocked: true, action: 'reconcile_request',
    message: prefix + '有请求已开始但尚无完整回答，请核对对应请求；其他子任务不能使用它的恢复许可。' }
  if (pending.some(task => task.failure && task.output_candidate?.replay_version !== sourceStoryReplayVersion)) return {
    available: true, action: 'revalidate', message: prefix + '可先重新校验已保存回答并查找精确完成记录；不会刷新纠正额度或转用其他任务的恢复许可。',
  }
  if (pending.some(task => task.output_candidate?.checkpoint.correction)) return { available: false, action: 'blocked',
    message: prefix + '完整原回答和纠正回答均已保留，但仍未通过校验；本提案纠正额度已使用，继续不会自动重新购买整批生成。请核对具体格式或证据问题。' }
  if (pending.some(task => sourceCheckpointResponseFact(task.output_candidate?.checkpoint).saved)) return { available: true, action: 'revalidate',
    message: prefix + '完整回答已保存；先在本地重新校验，不调用模型，也不刷新已使用的纠正额度。' }
  return { available: true, action: 'continue', message: prefix + (state.analysis_mode === 'extract' ? '继续仅处理未完成的资料整合，不进行质量审核。' : '继续仅处理未完成项，再独立核对。') }
}
