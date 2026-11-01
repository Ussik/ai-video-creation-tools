import type { Model } from '../../shared/api/api'

export const imageRatios = ['1:1', '1:2', '2:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21']
const imageOptions = {
  quality: ['low', 'standard', 'high', 'ultra', 'extreme'],
  clarity: ['1K', '2K', '4K'],
  background: ['auto', 'preserve', 'transparent'],
}
type ImageParameter = keyof typeof imageOptions

export function usesModelParameter(model: Model | undefined, field: string, mode?: string): boolean {
  if (!model) return false
  const templates = mode
    ? [(model.settings.request_templates as Record<string, unknown> | undefined)?.[mode] ?? model.settings.request_template, model.settings.content_template]
    : [model.settings.request_template, model.settings.request_templates, model.settings.content_template]
  return templates.some(template => JSON.stringify(template || {}).includes(`{{${field}}}`))
}

export function imageParameterOptions(model: Model | undefined, field: ImageParameter): string[] {
  if (model && model.modality !== 'image') return []
  const key = field === 'quality' ? 'qualities' : field === 'clarity' ? 'clarities' : 'backgrounds'
  const configured = model?.settings[`image_${key}`] ?? model?.settings[key]
  const options = Array.isArray(configured)
    ? [...new Set(configured.filter((value): value is string => typeof value === 'string' && !!value.trim()))] : []
  const choices = options.length ? options : [...imageOptions[field]]
  if (field === 'clarity' && !usesModelParameter(model, 'clarity')
    && (usesModelParameter(model, 'resolution') || usesModelParameter(model, 'size'))) {
    const resolutions = model?.settings.resolutions
    const levels = Array.isArray(resolutions) ? resolutions.filter((value): value is string => typeof value === 'string' && /^(1|2|4)k$/i.test(value)) : []
    if (levels.length) {
      const supported = choices.filter(value => levels.some(level => level.toUpperCase() === value.toUpperCase()))
      return supported.length ? supported : levels.map(level => level.toUpperCase())
    }
  }
  return choices
}

export function imageParameterValue(model: Model | undefined, field: ImageParameter, selected?: string | null): string {
  const options = imageParameterOptions(model, field)
  const configured = model?.settings[`default_${field}`]
  const preferred = field === 'quality' ? options.includes('standard') ? 'standard' : 'medium' : field === 'clarity' ? '2K' : 'auto'
  if (options.includes(selected || '')) return selected!
  if (selected && field !== 'background') {
    const supported = (field === 'quality' ? ['extreme', 'ultra', 'high', 'standard', 'medium', 'low'] : ['4K', '2K', '1K'])
      .find(value => options.includes(value))
    if (supported) return supported
  }
  return typeof configured === 'string' && options.includes(configured)
    ? configured : options.includes(preferred) ? preferred : options[0] || ''
}

/** New canvas images prefer the highest supported quality; saved node values win at the call site. */
export function imageGenerationDefaults(model?: Model) {
  const preferred = (field: ImageParameter, values: string[]) => {
    const options = imageParameterOptions(model, field)
    return imageParameterValue(model, field, values.find(value => options.includes(value)))
  }
  const resolutions = Array.isArray(model?.settings.resolutions)
    ? model.settings.resolutions.filter((value): value is string => typeof value === 'string') : ['1K', '2K', '4K']
  const defaultResolution = modelDefaultResolution(model, resolutions)
  const fixedSizes = model?.settings.image_size_mode !== 'auto' && !usesModelParameter(model, 'ratio')
    ? imageSizeChoices(resolutions) : []
  const configuredRatios = Array.isArray(model?.settings.ratios)
    ? model.settings.ratios.filter((value): value is string => typeof value === 'string' && !!value.trim()) : []
  const ratios = configuredRatios.length ? configuredRatios : fixedSizes.length ? [...new Set(fixedSizes.map(size => size.ratio))] : imageRatios
  const ratio = ratios.includes('16:9') ? '16:9' : ratios.find(value => value === resolutionRatio(defaultResolution)) || ratios[0] || '16:9'
  const clarity = preferred('clarity', ['4K', '2K', '1K'])
  const fixedSize = fixedSizes.filter(size => size.ratio === ratio)
    .sort((a, b) => Number.parseInt(b.clarity) - Number.parseInt(a.clarity))[0]
  return {
    ratio,
    resolution: model?.settings.image_size_mode === 'auto' ? 'auto' : fixedSize?.resolution || defaultResolution || null,
    clarity: fixedSize?.clarity || clarity,
    quality: preferred('quality', ['extreme', 'ultra', 'high', 'standard', 'medium', 'low']),
    background: imageParameterValue(model, 'background', 'auto'),
    candidate_count: 1,
  }
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

export function imageSizeChoices(resolutions: string[]): Array<{ resolution: string; ratio: string; clarity: string }> {
  return [...new Set(resolutions)].flatMap(resolution => {
    const dimensions = /^(\d{1,7})x(\d{1,7})$/.exec(resolution)
    const ratio = dimensions ? resolutionRatio(resolution) : null
    if (!dimensions || !ratio) return []
    // Clarity follows the longer edge, so a 3840x2160 image remains 4K in
    // either orientation; the provider still receives the exact dimensions.
    const scale = Math.max(Number(dimensions[1]), Number(dimensions[2])) / 1024
    const level = [1, 2, 4].reduce((closest, candidate) => Math.abs(candidate - scale) < Math.abs(closest - scale) ? candidate : closest)
    return [{ resolution, ratio, clarity: `${level}K` }]
  })
}

/** Older nodes may have saved their clarity only as a resolution value. */
export function imageResolutionClarity(resolution?: string | null): string | undefined {
  if (!resolution) return undefined
  return /^(1|2|4)k$/i.test(resolution) ? resolution.toUpperCase() : imageSizeChoices([resolution])[0]?.clarity
}

export function selectImageSize(resolutions: string[], currentResolution: string, selection: { ratio?: string; clarity?: string }) {
  const choices = imageSizeChoices(resolutions)
  const current = choices.find(choice => choice.resolution === currentResolution)
  const matches = choices.filter(choice => (!selection.ratio || choice.ratio === selection.ratio)
    && (!selection.clarity || choice.clarity === selection.clarity))
  return matches.find(choice => selection.ratio ? choice.clarity === current?.clarity : choice.ratio === current?.ratio)
    || matches[0] || null
}

/** A requested aspect ratio must map to an exact size or a native ratio parameter. */
export function imageRequestResolution(model: Model, currentResolution: string, selection: { ratio: string; clarity: string; mode?: string }): string {
  if (model.settings.image_size_mode === 'auto') return 'auto'
  const resolutions = Array.isArray(model.settings.resolutions)
    ? model.settings.resolutions.filter((value): value is string => typeof value === 'string') : []
  const current = !resolutions.length || resolutions.includes(currentResolution) ? currentResolution : modelDefaultResolution(model, resolutions)
  const mode = selection.mode || 'text'
  if (usesModelParameter(model, 'ratio', mode)) {
    // A native ratio API does not need a pixel-size field. Keep a resolution
    // only when the same template explicitly exposes one as well.
    if (!usesModelParameter(model, 'resolution', mode) && !usesModelParameter(model, 'size', mode)) return ''
    return resolutions.includes(selection.clarity) ? selection.clarity : current
  }
  if (!resolutions.length) return resolutionRatio(current) === selection.ratio ? current : ''
  const exact = selectImageSize(resolutions, current, selection) || selectImageSize(resolutions, current, { ratio: selection.ratio })
  return exact?.resolution || ''
}

export function imageRatioError(model: Model, resolution: string, ratio: string, mode = 'text'): string | null {
  if (model.settings.image_size_mode === 'auto') return null
  if (usesModelParameter(model, 'ratio', mode)) return null
  const usesSize = usesModelParameter(model, 'size', mode) || usesModelParameter(model, 'resolution', mode)
  if (usesSize && resolutionRatio(resolution) === ratio) return null
  return `当前模型配置无法提交 ${ratio} 画幅，请在模型设置中配置对应的图片尺寸或原生比例参数。`
}

const qualityRequirements: Record<string, string> = {
  low: '低画质，简化细节',
  standard: '标准画质，清楚呈现主体与构图',
  medium: '标准画质，清楚呈现主体与构图',
  high: '高画质，精细纹理与光影',
  ultra: '超高画质，更丰富的微小细节与材质层次',
  extreme: '极致画质，尽可能精确的细节、纹理与光影表现',
}
const backgroundRequirements: Record<string, string> = {
  auto: '自动选择适合画面的背景',
  preserve: '保留原有场景背景；有参考图时保留参考图的背景',
  keep: '保留原有场景背景；有参考图时保留参考图的背景',
  transparent: '透明背景，仅保留主体，不要绘制棋盘格或实色背景',
}

export function imagePreferencePrompt(model: Model, prompt: string, request: {
  ratio: string; resolution: string | null; quality: string | null; clarity: string | null; background: string | null
}, mode = 'text'): string {
  if (model.modality !== 'image') return prompt
  const requirements: string[] = []
  const nativeSize = imageSizeChoices([request.resolution || ''])[0]
  const usesSize = usesModelParameter(model, 'size', mode) || usesModelParameter(model, 'resolution', mode)
  // A mapped field does not establish that a provider honors it. Keep the
  // whole-image layout requirement in the prompt as well as the API parameters.
  if (request.ratio) {
    const [width, height] = request.ratio.split(':').map(Number)
    const orientation = width > 0 && height > 0 ? width < height ? '，竖版' : width > height ? '，横版' : '，方形' : ''
    requirements.push(`画面比例：${request.ratio}（宽:高${orientation}）。整张输出图片使用此比例，按此画幅安排全部内容，不要改成其他比例。`)
  }
  if (request.clarity && !usesModelParameter(model, 'clarity', mode) && (!usesSize || nativeSize?.clarity !== request.clarity)
    && !(usesSize && request.resolution === request.clarity)) requirements.push(`清晰度要求：${request.clarity}`)
  if (request.quality && !usesModelParameter(model, 'quality', mode)) requirements.push(`画质要求：${qualityRequirements[request.quality] || request.quality}`)
  if (request.background && !usesModelParameter(model, 'background', mode)) requirements.push(`背景要求：${backgroundRequirements[request.background] || request.background}`)
  return requirements.length ? `${prompt}\n\n【图片生成要求】\n${requirements.join('\n')}\n【图片生成要求结束】` : prompt
}

export function modelDefaultResolution(model: Model | undefined, resolutions: string[]): string {
  if (model?.modality === 'video' && model.settings.video_reference_profile === 'seedance_2_5') {
    const configured = model.settings.default_resolution
    return typeof configured === 'string' && resolutions.includes(configured) ? configured
      : resolutions.find(value => value.toLowerCase() === '720p') || resolutions[0] || ''
  }
  if (model?.modality === 'video') {
    const defaultVideoResolution = resolutions.find(value => value.toLowerCase() === '480p')
    if (defaultVideoResolution) return defaultVideoResolution
  }
  if (!model || model.modality === 'image') {
    const fourK = resolutions.find(value => value.toUpperCase() === '4K')
    if (fourK) return fourK
    const fourKSizes = imageSizeChoices(resolutions).filter(size => size.clarity === '4K')
    if (fourKSizes.length) return (fourKSizes.find(size => size.ratio === '16:9') || fourKSizes[0]).resolution
    const nextClarity = ['2K', '1K'].flatMap(clarity => resolutions.filter(value => value.toUpperCase() === clarity))[0]
    if (nextClarity) return nextClarity
  }
  const configured = model?.settings.default_resolution
  return typeof configured === 'string' && resolutions.includes(configured) ? configured : resolutions[0] || ''
}

/** These restrictions belong to the selected official preset, never a guessed model name. */
export function videoParameterPolicy(model: Model | undefined, mode: string, draft = false) {
  const seedance25 = model?.modality === 'video' && model.settings.video_reference_profile === 'seedance_2_5'
  return {
    ratioFollowsSource: seedance25 && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode),
    durationFollowsSource: seedance25 && mode === 'edit',
    draftResolution: seedance25 && draft ? '480p' : undefined,
  }
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
