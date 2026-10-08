export function imageReferenceConfigError(settings: Record<string, unknown>, count: number, mode = 'reference'): string | null {
  if (!count) return null
  if (count > 10) return '一次生成最多使用 10 张参考图'
  const templates = settings.request_templates as Record<string, unknown> | undefined
  const request = JSON.stringify(templates?.[mode] ?? settings.request_template ?? {})
  const template = request.includes('{{content}}') ? `${request}${JSON.stringify(settings.content_template || {})}` : request
  const usesMany = template.includes('{{images}}') || template.includes('{{image_references}}')
  if (!usesMany && !template.includes('{{image}}')) return '当前模型的本地请求模板未配置参考图字段，请在模型设置中补齐图片传递配置，或选择已配置的模型；这不代表模型本身不支持参考图'
  if (!usesMany && count > 1) return '当前模型请求模板只配置了一张参考图，请减少参考图或选择已配置多参考图的模型'
  if (template.includes('{{image_references}}') && !settings.image_reference_template) return '当前模型尚未配置参考图片模板'
  if (settings.image_reference_template) {
    const roles = (settings.reference_roles as Record<string, unknown> | undefined)?.[mode]
    if (!Array.isArray(roles) || !roles.length || roles.length !== 1 && roles.length < count) return '当前模式的参考图角色配置不足'
  }
  return null
}
