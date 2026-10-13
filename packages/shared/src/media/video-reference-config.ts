/** Shared video reference contract; capability comes from configured templates, never a model name. */
type Settings = Record<string, unknown>
const officialRoles = new Set(['first_frame', 'last_frame', 'reference_image'])
const referenceModes = ['first_frame', 'first_last_frame', 'reference', 'edit', 'extend']

function object(value: unknown): Settings {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Settings : {}
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
}
function uses(value: unknown, variable: string): boolean {
  return strings(value).some(item => item === `{{${variable}}}`)
}
function effectiveTemplate(settings: Settings, mode: string): unknown {
  return object(settings.request_templates)[mode] ?? settings.request_template ?? {}
}
function consumedTemplate(settings: Settings, mode: string): unknown[] {
  const request = effectiveTemplate(settings, mode)
  return uses(request, 'content') ? [request, settings.content_template] : [request]
}
function configuredRoles(settings: Settings, mode: string): unknown[] {
  const roles = object(settings.reference_roles)[mode]
  return Array.isArray(roles) ? roles : []
}
function literalRoles(template: unknown): string[] {
  if (Array.isArray(template)) return template.flatMap(literalRoles)
  if (!template || typeof template !== 'object') return []
  return Object.entries(template).flatMap(([key, value]) => key === 'role' && typeof value === 'string' && !value.includes('{{') ? [value] : literalRoles(value))
}
function activeRoles(settings: Settings, mode: string, count: number): unknown[] {
  const templates = consumedTemplate(settings, mode)
  if (uses(templates, 'image_references')) {
    const reference = settings.image_reference_template
    if (strings(reference).some(value => value.includes('{{role}}'))) {
      const roles = configuredRoles(settings, mode)
      return Array.from({ length: count }, (_, index) => roles[Math.min(index, roles.length - 1)])
    }
    const roles = literalRoles(reference)
    return Array.from({ length: count }, () => roles).flat()
  }
  return literalRoles(templates)
}

/** True only for an explicitly declared reference mode with a working multiple-image template. */
export function supportsVideoMultiReference(settings?: Settings): boolean {
  if (!settings || !Array.isArray(settings.supported_modes) || !settings.supported_modes.includes('reference')) return false
  const templates = consumedTemplate(settings, 'reference')
  if (!uses(templates, 'images') && !uses(templates, 'image_references')) return false
  return videoReferenceConfigError(settings, 2, 'reference') === null
}

/** The composition image occupies a slot in the same budget as all other images. */
export function videoReferenceImageLimit(settings: Settings = {}): number {
  const configured = settings.max_reference_images
  const limit = typeof configured === 'number' && Number.isInteger(configured) && configured >= 1 && configured <= 10 ? configured : 10
  return Math.min(limit, settings.video_reference_profile === 'seedance_2_0' ? 9 : 10)
}

export function videoReferenceConfigError(settings: Settings | undefined, count: number, mode = 'reference'): string | null {
  settings ??= {}
  const modes = Array.isArray(settings.supported_modes) ? settings.supported_modes : ['text']
  if (!modes.includes(mode)) return '该模型没有配置所选视频模式，请在模型设置中明确配置 supported_modes'
  if (!Number.isInteger(count) || count < 0) return '视频参考图片数量无效'
  const configuredLimit = settings.max_reference_images
  if (configuredLimit !== undefined && (typeof configuredLimit !== 'number' || !Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 10)) return '视频模型的 max_reference_images 必须为 1 到 10 的整数'
  const limit = videoReferenceImageLimit(settings)
  if (count > limit) return `当前视频模型一次最多使用 ${limit} 张参考图片（包含分镜图）`
  if (mode === 'text' && count) return '文生视频模式不能传入图片，请切换到首帧或多图参考模式'
  if (mode === 'first_frame' && count !== 1) return '首帧模式需要一张参考图片'
  if (mode === 'first_last_frame' && count !== 2) return '首尾帧模式需要两张参考图片'
  if (!count) return null
  if (!referenceModes.includes(mode)) return '当前视频模式不能传入参考图片'
  const templates = consumedTemplate(settings, mode)
  const usesMany = uses(templates, 'images') || uses(templates, 'image_references')
  if (!usesMany && !uses(templates, 'image')) return '当前视频模型的本地请求模板未配置参考图字段，请补齐图片传递配置；这不代表模型本身不支持参考图'
  if (!usesMany && count > 1) return '当前视频模型请求模板只配置了一张参考图，请配置多参考图模板后使用'
  if (uses(templates, 'image_references')) {
    if (!settings.image_reference_template || !uses(settings.image_reference_template, 'image')) return '当前视频模型的参考图片模板未传递 {{image}}'
    if (strings(settings.image_reference_template).some(value => value.includes('{{role}}'))) {
      const roles = configuredRoles(settings, mode)
      if (!roles.length || roles.length !== 1 && roles.length < count) return '当前视频模式的参考图角色配置不足'
    }
  }
  const roles = activeRoles(settings, mode, count)
  const officialContract = settings.video_reference_profile === 'seedance_2_0' || roles.some(role => typeof role === 'string' && officialRoles.has(role))
  if (roles.some(role => typeof role !== 'string' || !role || officialContract && !officialRoles.has(role))) return officialContract
    ? '当前官方视频参考图角色只能为 first_frame、last_frame 或 reference_image' : '视频参考图角色必须是非空字符串'
  if (officialContract) {
    if (roles.includes('reference_image') && (roles.includes('first_frame') || roles.includes('last_frame'))) return '首帧、首尾帧与多图参考模式互斥，不能混用 first_frame / last_frame 和 reference_image'
    if (roles.length && mode === 'first_frame' && (roles.length !== 1 || roles[0] !== 'first_frame')) return '首帧模式必须使用 first_frame 参考图角色'
    if (roles.length && mode === 'first_last_frame' && (roles.length !== 2 || roles[0] !== 'first_frame' || roles[1] !== 'last_frame')) return '首尾帧模式必须按顺序使用 first_frame、last_frame 参考图角色'
    if (roles.length && mode === 'reference' && roles.some(role => role !== 'reference_image')) return '多图参考模式只能使用 reference_image 参考图角色'
  }
  if (settings.video_reference_profile === 'seedance_2_0' && roles.length !== count) return 'Seedance 2.0 必须为每张参考图片配置对应的官方参考图角色'
  return null
}

export type VideoReferenceImageInfo = { bytes: number; width: number; height: number }
/** Seedance media limits are enabled by the explicit profile setting only. */
export function videoReferenceMediaError(settings: Settings, images: VideoReferenceImageInfo[], requestBytes?: number): string | null {
  if (settings.video_reference_profile !== 'seedance_2_0') return null
  if (images.length > 9) return 'Seedance 2.0 最多支持 9 张参考图片（包含分镜图）'
  for (const [index, image] of images.entries()) {
    if (image.bytes >= 30 * 1024 * 1024) return `参考图 ${index + 1} 必须小于 30 MB`
    if (image.width < 300 || image.height < 300 || image.width > 6000 || image.height > 6000) return `参考图 ${index + 1} 的宽高必须在 300 到 6000 像素之间`
    const ratio = image.width / image.height
    if (ratio < 0.4 || ratio > 2.5) return `参考图 ${index + 1} 的宽高比必须在 0.4 到 2.5 之间`
  }
  if (requestBytes !== undefined && requestBytes > 64 * 1024 * 1024) return 'Seedance 2.0 请求超过 64 MB（含 Base64 参考图片），请减少图片或压缩后重新提交'
  return null
}
