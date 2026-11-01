import type { Asset, Job, Model, ProjectDetail, Provider, Shot } from '../../shared/api/api'
import { generationRecoveryModality } from '@video-studio/shared/jobs/generation-recovery'
import { jobRecoveryPresentation } from './job-recovery'

export type TaskKind = 'image' | 'video' | 'speech' | 'export' | 'text' | 'unknown'
export type TaskStatusFilter = 'all' | 'active' | 'failed' | 'succeeded'
export type TaskRecord = {
  job: Job
  kind: TaskKind
  label: string
  model?: Model
  provider?: Provider
  shot?: Shot
  result?: Asset
  context: string
  search: string
  needsBillingCheck: boolean
  recovery: ReturnType<typeof jobRecoveryPresentation>
}

export const taskKindLabels: Record<TaskKind, string> = {
  image: '图片生成', video: '视频生成', speech: '配音生成', export: '成片导出', text: '文本生成', unknown: '生成任务',
}

export function isTaskActive(job: Job) {
  return job.status === 'queued' || job.status === 'running'
}

export function projectTaskRecords(detail: ProjectDetail, models: Model[], providers: Provider[]): TaskRecord[] {
  const modelsById = new Map(models.map(model => [model.id, model]))
  const providersById = new Map(providers.map(provider => [provider.id, provider]))
  const shotsById = new Map(detail.shots.map(shot => [shot.id, shot]))
  const assetsById = new Map(detail.assets.map(asset => [asset.id, asset]))
  return detail.jobs.map(job => {
    let request: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(job.request)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) request = parsed as Record<string, unknown>
    } catch { /* Older task records may have an unreadable request. */ }
    const model = modelsById.get(job.model_id || '')
    const provider = providersById.get(model?.provider_id || '')
    const shot = shotsById.get(job.shot_id || '')
    const result = assetsById.get(job.result_asset_id || '')
    const speech = Boolean(request.tts)
    const recoveryModality = generationRecoveryModality(job, model?.modality)
    const kind: TaskKind = job.job_type === 'export' ? 'export' : speech ? 'speech'
      : recoveryModality === 'video' ? 'video' : recoveryModality === 'image' ? 'image'
        : result?.kind === 'image' ? 'image' : result?.kind === 'video' ? 'video'
          : job.recovery_available && job.recovery_action === undefined ? 'image'
          : model?.modality === 'text' || result?.kind === 'text' ? 'text' : 'unknown'
    const label = taskKindLabels[kind]
    const context = [typeof request.voice_name === 'string' ? request.voice_name : '', shot?.title || detail.name].filter(Boolean).join(' · ')
    const recovery = jobRecoveryPresentation(job, model?.modality)
    const needsBillingCheck = recovery?.action === 'verify' || job.status === 'failed' && !recovery
      && job.job_type === 'generation' && (kind === 'image' || kind === 'video' || kind === 'unknown')
    return { job, kind, label, model, provider, shot, result, context, needsBillingCheck, recovery,
      search: [label, model?.name, provider?.name, context, job.id, job.external_id, job.error, result?.filename, recovery?.label]
        .filter(Boolean).join(' ').toLocaleLowerCase() }
  })
}

export function filterTaskRecords(records: TaskRecord[], status: TaskStatusFilter, kind: 'all' | TaskKind, query: string) {
  const keyword = query.trim().toLocaleLowerCase()
  return records.filter(record => (status === 'all' || (status === 'active' ? isTaskActive(record.job) : record.job.status === status)) &&
    (kind === 'all' || record.kind === kind) && (!keyword || record.search.includes(keyword)))
}
