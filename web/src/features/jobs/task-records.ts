import type { Asset, Job, Model, ProjectDetail, Provider, Shot } from '../../shared/api/api'

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
    const kind: TaskKind = job.job_type === 'export' ? 'export' : speech ? 'speech'
      : model?.modality === 'image' || job.recovery_available || result?.kind === 'image' ? 'image'
        : model?.modality === 'video' || result?.kind === 'video' ? 'video'
          : model?.modality === 'text' || result?.kind === 'text' ? 'text' : 'unknown'
    const label = taskKindLabels[kind]
    const context = [typeof request.voice_name === 'string' ? request.voice_name : '', shot?.title || detail.name].filter(Boolean).join(' · ')
    const needsBillingCheck = job.status === 'failed' && !job.recovery_available && !job.task_resume_available &&
      (kind === 'image' || job.job_type === 'generation' && !model && !speech)
    return { job, kind, label, model, provider, shot, result, context, needsBillingCheck,
      search: [label, model?.name, provider?.name, context, job.id, job.external_id, job.error, result?.filename]
        .filter(Boolean).join(' ').toLocaleLowerCase() }
  })
}

export function filterTaskRecords(records: TaskRecord[], status: TaskStatusFilter, kind: 'all' | TaskKind, query: string) {
  const keyword = query.trim().toLocaleLowerCase()
  return records.filter(record => (status === 'all' || (status === 'active' ? isTaskActive(record.job) : record.job.status === status)) &&
    (kind === 'all' || record.kind === kind) && (!keyword || record.search.includes(keyword)))
}
