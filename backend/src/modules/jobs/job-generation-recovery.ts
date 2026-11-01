import { isContentPolicyRejection } from '@video-studio/shared/jobs/prompt-optimization'
import type { GenerationRecoveryAction, GenerationRecoveryModality } from '@video-studio/shared/jobs/generation-recovery'
import { db, now, one, run, type Job, type Model, type Provider } from '../../infrastructure/database/db.js'
import { submissionRequestHash } from './resource-submissions.js'

type Attempt = { modality: GenerationRecoveryModality; model_signature: string; provider_signature: string }
export const validExternalTaskId = (value: string | null) => typeof value === 'string' && !!value.trim()
  && !['undefined', 'null'].includes(value.trim())

function signatures(model: Model, provider: Provider) {
  return { model_signature: submissionRequestHash({ id: model.id, provider_id: model.provider_id, remote_id: model.remote_id,
    modality: model.modality, protocol: model.protocol, settings: JSON.parse(model.settings) }),
  provider_signature: submissionRequestHash({ id: provider.id, adapter: provider.adapter, base_url: provider.base_url,
    auth_header: provider.auth_header, auth_prefix: provider.auth_prefix }) }
}

export function generationAttempt(jobId: string) {
  return one<Attempt>('SELECT modality,model_signature,provider_signature FROM job_generation_attempts WHERE job_id=?', jobId)
}

function matchesAttempt(attempt: Attempt, model: Model, provider: Provider) {
  try {
    const current = signatures(model, provider)
    return attempt.modality === model.modality && attempt.model_signature === current.model_signature
      && attempt.provider_signature === current.provider_signature
  } catch { return false }
}

export function generationRecoveryInfo(job: Job, model?: Model) {
  const attempt = generationAttempt(job.id)
  const image = Boolean(one('SELECT 1 FROM job_image_recovery WHERE job_id=?', job.id))
  const video = Boolean(one('SELECT 1 FROM job_video_recovery WHERE job_id=?', job.id))
  const modality: GenerationRecoveryModality | null = video ? 'video' : image ? 'image' : attempt?.modality
    || (model?.modality === 'image' || model?.modality === 'video' ? model.modality : null)
  const provider = model ? one<Provider>('SELECT * FROM providers WHERE id=?', model.provider_id) : undefined
  let query = false
  try {
    query = validExternalTaskId(job.external_id) && !!model?.enabled && !model.archived && !!provider?.enabled
      && !provider.archived && provider.adapter === 'http'
      && (!attempt || matchesAttempt(attempt, model, provider))
      && (model.modality === 'video' || model.modality === 'image'
        && JSON.parse(model.settings).async_image === true && !isContentPolicyRejection(job.error))
  } catch { /* Broken configuration cannot authorize a new provider request. */ }
  let action: GenerationRecoveryAction | null = null
  let speech = false
  try { speech = !!JSON.parse(job.request).tts } catch { /* Keep malformed requests out of media recovery. */ }
  if (job.status === 'failed' && job.job_type === 'generation' && !speech) {
    action = image || video ? 'download' : query ? 'query'
      : modality || !model || job.external_id !== null && job.external_id !== undefined ? 'verify' : null
  }
  return { recovery_available: image || video, task_resume_available: query,
    recovery_action: action, recovery_modality: modality }
}

/** Freeze execution identity once. A persisted attempt without a task ID must never POST again. */
export function prepareGenerationExecution(job: Job, model: Model, provider: Provider) {
  db.transaction(() => {
    const attempt = generationAttempt(job.id)
    if (attempt && !matchesAttempt(attempt, model, provider)) {
      throw new Error('原任务的模型或提供商配置已变化，已停止恢复。请还原原配置后继续查询，或核对厂商记录；不会重新提交生成。')
    }
    if (job.external_id !== null && job.external_id !== undefined) {
      if (!validExternalTaskId(job.external_id) || !(model.modality === 'video'
        || model.modality === 'image' && JSON.parse(model.settings).async_image === true)) {
        throw new Error('原任务编号或查询配置不可用，请先核对厂商记录；不会重新提交生成。')
      }
    } else if (attempt) {
      throw new Error('任务曾开始执行，但没有可确认的厂商任务编号或结果链接。厂商可能已计费，请先核对厂商记录；不会重新提交生成。')
    }
    if (!attempt && (model.modality === 'image' || model.modality === 'video')) {
      const fingerprint = signatures(model, provider)
      run('INSERT INTO job_generation_attempts (job_id,modality,model_signature,provider_signature,started_at) VALUES (?,?,?,?,?)',
        job.id, model.modality, fingerprint.model_signature, fingerprint.provider_signature, now())
    }
  }).immediate()
}
