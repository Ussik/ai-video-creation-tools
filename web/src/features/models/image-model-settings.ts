import { resolutionRatio } from '../canvas/canvas-model-parameters'

type Settings = Record<string, unknown>
export type ImageReferenceMode = 'none' | 'single' | 'multiple'
export type ImageSizeMode = 'ratio' | 'pixels' | 'auto'

function isRecord(value: unknown): value is Settings {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function templates(settings: Settings): Settings[] {
  const result: Settings[] = []
  if (isRecord(settings.request_template)) result.push(settings.request_template)
  if (isRecord(settings.request_templates)) {
    for (const template of Object.values(settings.request_templates)) {
      if (isRecord(template)) result.push(template)
    }
  }
  return result
}

function bindingFields(settings: Settings, variables: string[]): string[] {
  return [...new Set(templates(settings).flatMap(template => Object.entries(template)
    .filter(([, value]) => typeof value === 'string' && variables.includes(value))
    .map(([key]) => key)))]
}

export function imageRequestForm(settings: Settings) {
  const requests = templates(settings)
  const refs = bindingFields(settings, ['{{image}}', '{{images}}'])
  const ratios = bindingFields(settings, ['{{ratio}}', '{{size}}'])
  const validOverrides = settings.request_templates === undefined || isRecord(settings.request_templates)
    && Object.values(settings.request_templates).every(isRecord)
  const editable = isRecord(settings.request_template) && validOverrides && requests.every(template => {
    // Nested image/content templates need their original advanced configuration.
    const direct = Object.fromEntries(Object.entries(template).filter(([, value]) => typeof value === 'string'))
    const indirect = Object.fromEntries(Object.entries(template).filter(([, value]) => typeof value !== 'string'))
    return direct.model === '{{model}}' && direct.prompt === '{{prompt}}'
      && !JSON.stringify(indirect).includes('{{')
      && !Object.values(direct).some(value => /\{\{(?:content|image_references)\}\}/.test(value as string)
        || /\{\{(?:image|images|ratio|size)\}\}/.test(value as string) && !['{{image}}', '{{images}}', '{{ratio}}', '{{size}}'].includes(value as string))
      && Object.values(direct).filter(value => value === '{{image}}' || value === '{{images}}').length <= 1
      && Object.values(direct).filter(value => value === '{{ratio}}' || value === '{{size}}').length <= 1
  }) && refs.length <= 1 && ratios.length <= 1
  const values = requests.flatMap(template => Object.values(template))
  const mode: ImageReferenceMode = values.includes('{{images}}') ? 'multiple' : values.includes('{{image}}') ? 'single' : 'none'
  const sizeMode: ImageSizeMode = settings.image_size_mode === 'auto' ? 'auto'
    : values.includes('{{size}}') ? 'pixels' : 'ratio'
  return { editable, mode, sizeMode, referenceField: refs[0] || (settings.image_reference_transport === 'multipart' ? 'image[]' : 'image'), ratioField: ratios[0] || 'ratio',
    preset: !editable ? 'custom' : settings.image_reference_transport === 'multipart' ? 'images_api'
      : ['images_api', 'images_reference', 'gpt_image'].includes(String(settings.image_api_profile)) ? 'images_reference' : 'generic' }
}

export function changeImageAsync(settings: Settings, enabled: boolean): Settings {
  if (!imageRequestForm(settings).editable) throw new Error('此模型使用自定义请求结构，请在高级配置中调整')
  function change(template: Settings): Settings {
    const result = { ...template }
    if (enabled) result.async = true
    else delete result.async
    return result
  }
  const result: Settings = { ...settings, async_image: enabled,
    ...(isRecord(settings.request_template) ? { request_template: change(settings.request_template) } : {}),
    ...(isRecord(settings.request_templates) ? { request_templates: Object.fromEntries(Object.entries(settings.request_templates)
      .map(([mode, template]) => [mode, isRecord(template) ? change(template) : template])) } : {}) }
  if (enabled) Object.assign(result, {
    get_path: settings.get_path || 'tasks/{id}', id_path: settings.id_path || 'task_id',
    status_path: settings.status_path || 'status', error_path: settings.error_path || 'error.message',
    success_statuses: settings.success_statuses ?? ['completed'],
    failure_statuses: settings.failure_statuses ?? ['failed', 'cancelled', 'canceled', 'expired'],
    poll_seconds: settings.poll_seconds ?? 5,
  })
  return result
}

/** Update direct bindings in both the default request and mode overrides, retaining other parameters. */
export function changeImageBinding(settings: Settings, kind: 'reference' | 'ratio', field: string, mode: ImageReferenceMode = 'multiple'): Settings {
  if (!imageRequestForm(settings).editable) throw new Error('此模型使用自定义请求结构，请在高级配置中调整')
  const placeholders = kind === 'ratio' ? ['{{ratio}}', '{{size}}'] : ['{{image}}', '{{images}}']
  const variable = kind === 'ratio' ? imageRequestForm(settings).sizeMode === 'ratio' ? '{{ratio}}' : '{{size}}'
    : mode === 'single' ? '{{image}}' : '{{images}}'
  function change(template: Settings): Settings {
    const result = Object.fromEntries(Object.entries(template).filter(([, value]) => !placeholders.includes(String(value))))
    if (kind === 'ratio' || mode !== 'none') {
      if (Object.hasOwn(result, field)) throw new Error(`参数 ${field} 已用于其他配置，请选择其他字段`)
      result[field] = variable
    }
    return result
  }
  return {
    ...settings,
    ...(isRecord(settings.request_template) ? { request_template: change(settings.request_template) } : {}),
    ...(isRecord(settings.request_templates) ? { request_templates: Object.fromEntries(Object.entries(settings.request_templates)
      .map(([key, template]) => [key, isRecord(template) ? change(template) : template])) } : {}),
  }
}

export function changeImageSizeMode(settings: Settings, mode: ImageSizeMode): Settings {
  const form = imageRequestForm(settings)
  const resolutions = Array.isArray(settings.resolutions) ? settings.resolutions.filter((item): item is string => typeof item === 'string' && /^\d+x\d+$/.test(item)) : []
  const next: Settings = { ...settings, image_size_mode: mode,
    ...(mode === 'auto' ? { default_resolution: 'auto' }
      : mode === 'pixels' ? { resolutions: resolutions.length ? resolutions : ['1024x1024', '1536x1024', '1024x1536'],
        default_resolution: resolutions.includes(String(settings.default_resolution)) ? settings.default_resolution : resolutions[0] || '1024x1024' } : {}) }
  const variable = mode === 'ratio' ? '{{ratio}}' : '{{size}}'
  const field = mode !== 'ratio' && ['ratio', 'aspectRatio'].includes(form.ratioField) ? 'size' : form.ratioField
  function change(template: Settings): Settings {
    const result = Object.fromEntries(Object.entries(template).filter(([, value]) => !['{{ratio}}', '{{size}}'].includes(String(value))))
    if (Object.hasOwn(result, field)) throw new Error(`参数 ${field} 已用于其他配置`)
    return { ...result, [field]: variable }
  }
  if (!form.editable) throw new Error('此模型使用自定义请求结构，请在高级配置中调整')
  const sized = mode === 'pixels' ? changeImageResolutions(next, next.resolutions as string[]) : next
  return { ...sized, request_template: change(settings.request_template as Settings),
    ...(isRecord(settings.request_templates) ? { request_templates: Object.fromEntries(Object.entries(settings.request_templates).map(([key, value]) => [key, change(value as Settings)])) } : {}) }
}

export function changeImageResolutions(settings: Settings, resolutions: string[]): Settings {
  const ratios = [...new Set(resolutions.map(resolutionRatio).filter((ratio): ratio is string => !!ratio))]
  return { ...settings, resolutions, ratios, default_ratio: ratios.includes(String(settings.default_ratio)) ? settings.default_ratio : ratios[0],
    default_resolution: resolutions.includes(String(settings.default_resolution)) ? settings.default_resolution : resolutions[0] }
}

export function genericImageSettings(existing: Settings, defaultRatios: string[]): Settings {
  const obsolete = new Set(['request_templates', 'mode_variables',
    'content_template', 'image_reference_template', 'reference_roles', 'image_api_profile', 'image_reference_transport', 'image_size_mode'])
  const retained = Object.fromEntries(Object.entries(existing).filter(([key]) => !obsolete.has(key)))
  return { ...retained, request_path: existing.request_path || 'images/generations',
    request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}', ...(existing.async_image === true ? { async: true } : {}) },
    image_base64_path: existing.image_base64_path ?? 'data.0.b64_json', image_url_path: existing.image_url_path ?? 'data.0.url',
    ratios: existing.ratios ?? defaultRatios, default_ratio: existing.default_ratio ?? '1:1' }
}
