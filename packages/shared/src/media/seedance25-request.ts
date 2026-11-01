type Settings = Record<string, unknown>
type VideoRequest = {
  mode?: string
  duration?: number
  ratio?: string
  resolution?: string | null
  reference_video_url?: string | null
  generate_audio?: boolean
  draft?: boolean
}

const ratios = new Set(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])
const adaptiveModes = new Set(['first_frame', 'first_last_frame', 'edit', 'extend'])

/** Keep previews and submission dimensions aligned with the explicitly selected API profile. */
export function normalizeSeedance25Request<T extends VideoRequest>(settings: Settings, request: T): T {
  if (settings.video_reference_profile !== 'seedance_2_5') return request
  return {
    ...request,
    ...(adaptiveModes.has(request.mode ?? 'text') ? { ratio: 'adaptive' } : {}),
    ...(request.draft ? { resolution: '480p' } : {}),
  }
}

/** These are API constraints, so inherited template defaults cannot replace them. */
export function seedance25RequestVariables(settings: Settings, request: VideoRequest): Settings {
  if (settings.video_reference_profile !== 'seedance_2_5') return {}
  const mode = request.mode ?? 'text'
  return {
    ...(adaptiveModes.has(mode) ? { ratio: 'adaptive' } : {}),
    ...(mode === 'edit' ? { duration: -1 } : {}),
    omni_reference_task_type: ['reference', 'edit', 'extend'].includes(mode) ? mode : null,
    ...(request.draft ? { resolution: '480p' } : {}),
    generate_audio: request.generate_audio ?? true,
    draft: request.draft ? true : null,
  }
}

export function seedance25RequestError(settings: Settings, request: VideoRequest): string | null {
  if (settings.video_reference_profile !== 'seedance_2_5') return null
  const normalized = normalizeSeedance25Request(settings, request)
  const resolution = normalized.resolution ?? settings.default_resolution ?? settings.resolution ?? '480p'
  if (!['480p', '720p', '1080p'].includes(String(resolution))) return 'Seedance 2.5 仅支持 480p、720p 或 1080p 清晰度'
  if (!ratios.has(normalized.ratio ?? '16:9')) return 'Seedance 2.5 不支持所选画幅'
  const duration = request.duration ?? 5
  if (request.mode !== 'edit' && (!Number.isInteger(duration) || duration < 4 || duration > 30)) return 'Seedance 2.5 时长必须为 4 到 30 秒'
  if (request.reference_video_url && !['reference', 'edit', 'extend'].includes(request.mode ?? 'text')) return 'Seedance 2.5 首帧、首尾帧与全模态参考互斥，参考视频仅可用于参考、编辑或延长模式'
  if (['edit', 'extend'].includes(request.mode ?? '') && !request.reference_video_url) return 'Seedance 2.5 编辑或延长需要参考视频地址'
  return null
}
