import { isContentPolicyRejection, jobPromptRequest } from './prompt-optimization.js'

export type GenerationRecoveryAction = 'verify' | 'query' | 'download' | 'local' | 'prepare' | null
export type GenerationRecoveryModality = 'image' | 'video' | 'audio' | null
export type GenerationRecoveryJob = {
  job_type: string
  status: string
  request?: string
  error?: string | null
  recovery_action?: GenerationRecoveryAction
  recovery_modality?: GenerationRecoveryModality
  recovery_available?: boolean
  task_resume_available?: boolean
}

/** Public recovery metadata describes the saved task, even if its model changed. */
export function generationRecoveryModality(job: GenerationRecoveryJob, modelModality?: string): GenerationRecoveryModality {
  if (job.recovery_modality === 'image' || job.recovery_modality === 'video' || job.recovery_modality === 'audio') return job.recovery_modality
  return modelModality === 'image' || modelModality === 'video' || modelModality === 'audio' ? modelModality : null
}

/** Presentation policy only. The server verifies the persisted task and checkpoint before resuming. */
export function generationRecoveryAction(job: GenerationRecoveryJob, modelModality?: string): GenerationRecoveryAction {
  if (job.job_type !== 'generation' || job.status !== 'failed') return null
  const speech = !!jobPromptRequest(job.request || '{}').tts
  if (speech) return job.recovery_action === 'local' || job.recovery_action === 'prepare' ? job.recovery_action : null
  // null is authoritative for the new API; only an absent field uses legacy flags.
  if (job.recovery_action !== undefined) return job.recovery_action === 'verify' || job.recovery_action === 'query'
    || job.recovery_action === 'download' || job.recovery_action === 'local' || job.recovery_action === 'prepare' ? job.recovery_action : null
  if (job.recovery_available) return 'download'
  if (isContentPolicyRejection(job.error) && (generationRecoveryModality(job, modelModality) || !modelModality)) return 'verify'
  if (job.task_resume_available) return 'query'
  if (generationRecoveryModality(job, modelModality) || !modelModality) return 'verify'
  return null
}
