/** Defaults selected by the user, not inferred model capabilities. */
export function videoModelConfigError(settings: Record<string, unknown>): string | null {
  for (const [key, listKey, label] of [['default_ratio', 'ratios', '默认视频画幅'], ['default_resolution', 'resolutions', '默认视频分辨率']] as const) {
    const value = settings[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return `${label}必须为非空选项`
    if (value !== undefined && Array.isArray(settings[listKey]) && !(settings[listKey] as unknown[]).includes(value)) return `${label}必须包含在可选列表中`
  }
  if (settings.default_duration !== undefined) {
    const value = settings.default_duration
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 120) return '默认视频时长必须为 1 到 120 秒的整数'
    if (typeof settings.min_duration === 'number' && value < settings.min_duration
      || typeof settings.max_duration === 'number' && value > settings.max_duration) return '默认视频时长必须在模型支持的时长范围内'
  }
  return null
}

export function videoDefaultDuration(settings?: Record<string, unknown>): number {
  return typeof settings?.default_duration === 'number' && Number.isSafeInteger(settings.default_duration)
    && settings.default_duration >= 1 && settings.default_duration <= 120 ? settings.default_duration : 5
}

export function videoDefaultRatio(settings: Record<string, unknown> | undefined, ratios: string[], fallback = '16:9'): string {
  const configured = settings?.default_ratio
  return typeof configured === 'string' && ratios.includes(configured) ? configured : ratios.includes(fallback) ? fallback : ratios[0] || fallback
}
