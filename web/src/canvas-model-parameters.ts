import type { Model } from './api'

/** Show a setting only when the configured provider body consumes it. */
export function usesModelParameter(model: Model | undefined, field: string): boolean {
  if (!model) return false
  const templates = [model.settings.request_template, model.settings.request_templates, model.settings.content_template]
  return templates.some(template => JSON.stringify(template || {}).includes(`{{${field}}}`))
}

export function imageParameterOptions(model: Model | undefined, field: 'quality' | 'clarity' | 'background'): string[] {
  if (!usesModelParameter(model, field)) return []
  const key = field === 'quality' ? 'qualities' : field === 'clarity' ? 'clarities' : 'backgrounds'
  const configured = model?.settings[`image_${key}`] ?? model?.settings[key]
  return Array.isArray(configured) ? [...new Set(configured.filter((value): value is string => typeof value === 'string' && !!value.trim()))] : []
}

export function resolutionRatio(resolution: string): string | null {
  const match = /^(\d+)x(\d+)$/.exec(resolution)
  if (!match) return null
  const width = Number(match[1]), height = Number(match[2])
  if (!width || !height) return null
  let a = width, b = height
  while (b) { const remainder = a % b; a = b; b = remainder }
  return `${width / a}:${height / a}`
}

export function modelDefaultResolution(model: Model | undefined, resolutions: string[]): string {
  const configured = model?.settings.default_resolution
  return typeof configured === 'string' && resolutions.includes(configured) ? configured : resolutions[0] || ''
}

export function generationCost(model: Model, request: { resolution?: string | null; duration: number }, count = 1): string | null {
  const settings = model.settings.pricing
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const pricing = settings as Record<string, unknown>
  const rates = pricing.per_second_by_resolution
  const resolutionRate = rates && typeof rates === 'object' && !Array.isArray(rates)
    ? (rates as Record<string, unknown>)[request.resolution || ''] : undefined
  const rate = typeof resolutionRate === 'number' ? resolutionRate : pricing.per_second
  const unit = model.modality === 'video' && typeof rate === 'number' ? rate * request.duration
    : model.modality === 'image' && typeof pricing.per_image === 'number' ? pricing.per_image
      : typeof pricing.per_generation === 'number' ? pricing.per_generation : null
  if (unit === null || !Number.isFinite(unit) || unit < 0) return null
  const amount = unit * Math.max(1, Math.min(4, Math.trunc(count) || 1))
  return `${typeof pricing.currency === 'string' ? pricing.currency : '¥'}${Number(amount.toFixed(4))}`
}
