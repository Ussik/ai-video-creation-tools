import type { BusinessTaskRecord, BusinessTaskKind } from '@video-studio/shared/jobs/business-tasks'
import type { Asset, Job, Model, ProjectDetail, Provider, Shot } from '../../shared/api/api'
import { generationRecoveryModality } from '@video-studio/shared/jobs/generation-recovery'
import { canOptimizeImagePrompt, isContentPolicyRejection } from '@video-studio/shared/jobs/prompt-optimization'
import { jobRecoveryPresentation } from './job-recovery'

export type TaskKind = 'image' | 'video' | 'speech' | 'export' | 'text' | 'unknown' | BusinessTaskKind
export type TaskStatusFilter = 'all' | 'active' | 'failed' | 'succeeded' | 'interrupted'
export type TaskRecord = {
  job: Job
  business?: BusinessTaskRecord
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
  image: '图片生成', video: '视频生成', speech: '配音生成', export: '成片导出', text: '文本生成', unknown: '生成任务', storyboard: '分镜规划', reference: '参考整理', script: '剧本创作', analysis: '内容分析', prompt: '提示词优化',
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
    const label = shot?.title ? `${shot.title} · ${taskKindLabels[kind]}` : taskKindLabels[kind]
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
  return records.filter(record => (status === 'all' || taskRecordStatus(record) === status) &&
    (kind === 'all' || record.kind === kind) && (!keyword || record.search.includes(keyword)))
}

/** UI projection only; no synthetic model request, recovery allowance or database job is created. */
export function businessTaskRecords(tasks: BusinessTaskRecord[], jobs: Job[]): TaskRecord[] {
  const existing = new Set(jobs.map(job => job.id))
  return tasks.filter(task => !task.job_ids.some(id => existing.has(id))).map(task => ({
    business: task, kind: task.kind, label: task.title, context: task.scope.label, needsBillingCheck: false, recovery: null,
    job: { id: task.id, project_id: task.project_id, shot_id: null, model_id: null, job_type: 'generation', request: '{}',
      status: task.status === 'running' ? 'running' : task.status === 'succeeded' ? 'succeeded' : 'failed',
      external_id: null, result_asset_id: null, error: task.status === 'failed' || task.status === 'interrupted' ? task.summary : null,
      created_at: task.created_at, updated_at: task.updated_at, recovery_available: false } as Job,
    search: [task.title, task.scope.label, task.summary, task.id].join(' ').toLocaleLowerCase(),
  }))
}

/** A record belongs to exactly one status; an active query is still active. */
export function taskRecordStatus(record: TaskRecord): Exclude<TaskStatusFilter, 'all'> {
  if (record.business) return record.business.status === 'running' ? 'active' : record.business.status
  if (isTaskActive(record.job)) return 'active'
  if (record.job.status === 'succeeded') return 'succeeded'
  return record.recovery?.action === 'verify' && !isContentPolicyRejection(record.job.error) ? 'interrupted' : 'failed'
}
export function taskRecordCounts(records: TaskRecord[]) {
  const counts = { all: records.length, active: 0, failed: 0, succeeded: 0, interrupted: 0 }
  for (const record of records) counts[taskRecordStatus(record)]++
  return counts
}

/** Original errors remain in details and search; list copy never exposes contracts or paths. */
export function shortTaskMessage(message: string, fallback: string): string {
  const text = message.trim()
  if (!text) return fallback
  if (/content.policy|内容审核|内容安全/i.test(text)) return '内容被服务拒绝，请调整提示词或参考图'
  if (/timeout|timed.out|超时/i.test(text)) return '请求超时，请查看原任务'
  if (/ECONN|disconnect|连接中断|断连|网络/i.test(text)) return '连接中断，请查看原任务'
  if (/schema|contract|invalid.business|契约|字段|格式|证据引用/i.test(text)) return '返回内容不符合要求，请查看详情'
  if (/quota|insufficient|余额|配额/i.test(text)) return '服务额度不足，请查看详情'
  if (text.length > 64 || /[A-Za-z_]{3,}|[{}\[\]]|\/(Users|private|tmp|src|backend|web)\//.test(text)) return fallback
  return text
}
export function taskRecordSummary(record: TaskRecord): string {
  const status = taskRecordStatus(record)
  if (record.business) {
    const summary = record.business.summary
    if (status === 'succeeded' && /^(已完成[，。]?|已完成，请回原功能查看结果|已完成，请回原任务查看结果)$/.test(summary)) return '可回原任务查看结果'
    return shortTaskMessage(summary, status === 'failed' ? '处理未完成，请查看详情' : status === 'interrupted' ? '处理已中断，请回原任务核对' : '回原任务查看进度')
  }
  if (status === 'active') return record.job.status === 'queued' ? '等待执行' : record.recovery?.action === 'verify' ? '正在查询原任务' : '正在处理'
  if (status === 'succeeded') return record.result?.filename || '结果不可用'
  if (status === 'interrupted' || record.needsBillingCheck && !record.recovery) return '请先核对提供商任务记录与账单'
  if (canOptimizeImagePrompt(record.job, record.model?.modality)) return '内容审核拒绝，可调整提示词和参考图'
  if (record.recovery?.action === 'local') return '本地成果已保留，不请求模型重新生成'
  if (record.recovery?.action === 'prepare') return '已确认未派发，可继续准备原任务'
  if (record.recovery?.action === 'download') return '已有结果可恢复下载'
  if (record.recovery?.action === 'query') return '可继续查询已有任务'
  return shortTaskMessage(record.job.error || '', '处理未完成，请查看详情')
}
export function taskRecordSubtitle(record: TaskRecord): string {
  const compact = (value: string) => value.replace(/\s+/g, '')
  const scope = compact(record.label).includes(compact(record.context)) ? '' : record.context
  const model = record.business ? '' : record.kind === 'speech' ? '豆包 TTS 2.0' : record.model?.name || ''
  return [...new Set([scope, model, taskRecordSummary(record)].filter(Boolean))].join(' · ')
}
