import type { Job, Model, Provider } from '../../shared/api/api'
import type { VideoReviewReport } from '@video-studio/shared/media/video-review'
import { supportsDoubaoVideoAnalysis } from '@video-studio/shared/models/video-analysis-settings'

export interface VideoReviewModelOption { id: string; label: string; inputMode: VideoReviewReport['input_mode']; is_default?: boolean }

export function videoReviewModels(models: Model[], providers: Provider[]): VideoReviewModelOption[] {
  return models.flatMap(model => {
    if (model.modality !== 'text' || !model.enabled || !providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter === 'http')) return []
    const nativeVideo = supportsDoubaoVideoAnalysis(model) || model.settings.supports_video === true && model.protocol === 'chat_completions'
    if (!nativeVideo && !(model.settings.supports_vision === true && ['responses', 'chat_completions'].includes(model.protocol))) return []
    return [{ id: model.id, label: `${model.name} · ${nativeVideo ? '视频理解' : '画面抽样'}`, inputMode: nativeVideo ? 'native_video' as const : 'sampled_frames' as const,
      ...(model.is_default ? { is_default: true } : {}) }]
  })
}

export function videoReviewTime(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs))
  return `${Math.floor(total / 60_000)}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}.${String(Math.floor(total % 1000 / 100)).padStart(1, '0')}`
}

export function videoGenerationDurationMs(assetId: string, jobs: Pick<Job, 'result_asset_id' | 'request'>[]): number | undefined {
  const job = jobs.find(item => item.result_asset_id === assetId)
  if (!job) return undefined
  try {
    const request = JSON.parse(job.request) as { duration?: unknown }
    return typeof request?.duration === 'number' && Number.isFinite(request.duration) && request.duration > 0 ? Math.round(request.duration * 1000) : undefined
  } catch { return undefined }
}
