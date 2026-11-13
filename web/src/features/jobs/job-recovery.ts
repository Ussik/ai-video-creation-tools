import { generationRecoveryAction, type GenerationRecoveryAction, type GenerationRecoveryJob } from '@video-studio/shared/jobs/generation-recovery'

const recoveryPresentation = {
  local: { label: '接管已保存成果', guidance: '复核已保存的本地成果并完成入库，不请求模型重新生成。',
    canvas: '本地成果已保留，可在任务记录接管', notice: '本地成果接管已入队' },
  prepare: { label: '继续未派发任务', guidance: '已确认未派发生成请求，先继续准备；准备通过后沿用原任务派发。',
    canvas: '原任务尚未派发，可在任务记录继续准备', notice: '原任务继续准备已入队' },
  verify: { label: '待核对', guidance: '原任务可能已被接收或计费，请先核对提供商任务记录与账单；重新生成会创建新的任务。',
    canvas: '原任务待核对，请查看任务记录', notice: '' },
  query: { label: '继续查询', guidance: '继续查询已有任务，沿用原提示词和参数，不创建新的生成任务。',
    canvas: '原任务可继续查询，请查看任务记录', notice: '原任务继续查询已入队' },
  download: { label: '恢复下载', guidance: '继续下载已有结果，沿用原任务，不重新生成。',
    canvas: '结果下载未完成，可在任务记录恢复下载', notice: '下载恢复任务已入队' },
} satisfies Record<Exclude<GenerationRecoveryAction, null>, { label: string; guidance: string; canvas: string; notice: string }>

export function jobRecoveryPresentation(job: GenerationRecoveryJob, modelModality?: string) {
  const action = generationRecoveryAction(job, modelModality)
  return action ? { action, ...recoveryPresentation[action] } : null
}
