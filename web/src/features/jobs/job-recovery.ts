import { generationRecoveryAction, type GenerationRecoveryAction, type GenerationRecoveryJob } from '@video-studio/shared/jobs/generation-recovery'

const recoveryPresentation = {
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
