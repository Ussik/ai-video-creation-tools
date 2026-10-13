type Settings = Record<string, unknown>
export const documentedImageProfile = 'images_tasks'
export const documentedImageRatios = ['1:1', '1:2', '2:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21']

/** The draw service submits under /draw/v1 and polls under /v1 on the same host. */
export function documentedImageEndpoints(baseUrl: string): { submit: string; tasks: string } {
  if (!baseUrl.trim()) return { submit: '', tasks: '' }
  try {
    const url = new URL(baseUrl.trim())
    const prefix = url.pathname.replace(/\/+$/, '').replace(/\/images\/(?:generations|edits)$/, '')
      .replace(/\/(?:draw\/)?v1$/, '')
    return { submit: `${url.origin}${prefix}/draw/v1`, tasks: `${url.origin}${prefix}/v1` }
  } catch { return { submit: baseUrl, tasks: baseUrl } }
}

/** Build only the fields documented by the linked Images generation/edit contracts. */
export function documentedImageSettings(existing: Settings = {}, providerBaseUrl = ''): Settings {
  const obsolete = new Set(['mode_variables', 'content_template', 'image_reference_template', 'reference_roles',
    'request_template', 'request_templates', 'image_base64_path', 'size', 'default_resolution', 'resolutions',
    'image_clarities', 'default_clarity'])
  const retained = Object.fromEntries(Object.entries(existing).filter(([key]) => !obsolete.has(key)))
  const pixels = existing.image_size_mode === 'pixels'
  const sizes = Array.isArray(existing.resolutions) ? existing.resolutions.filter((value): value is string => typeof value === 'string' && /^[1-9]\d*x[1-9]\d*$/.test(value)) : []
  const resolutions = sizes.length ? sizes : ['1024x1024', '1280x720', '720x1280']
  const referencePath = existing.image_reference_path === 'images/generations' ? 'images/generations' : 'images/edits'
  const multipart = referencePath === 'images/edits' && existing.image_reference_transport === 'multipart'
  const field = multipart ? 'image' : existing.image_reference_field === 'images' ? 'images' : 'image'
  const clarity = existing.image_clarity_parameter === true
  const request = { model: '{{model}}', prompt: '{{prompt}}', n: 1, size: pixels ? '{{size}}' : '{{ratio}}',
    ...(clarity ? { imageSize: '{{clarity}}' } : {}), [field]: '{{images}}', async: true }
  const address = String(existing.api_base_url || providerBaseUrl)
  const endpoints = documentedImageEndpoints(address)
  return { ...retained, image_api_profile: documentedImageProfile,
    ...(endpoints.submit ? { api_base_url: endpoints.submit } : {}),
    ...(existing.image_task_base_url || endpoints.tasks ? { image_task_base_url: existing.image_task_base_url || endpoints.tasks } : {}),
    request_path: 'images/generations', image_reference_path: referencePath,
    image_reference_transport: multipart ? 'multipart' : 'json', image_reference_field: field,
    image_size_mode: pixels ? 'pixels' : 'ratio',
    ...(pixels ? { resolutions, default_resolution: resolutions.includes(String(existing.default_resolution)) ? existing.default_resolution : resolutions[0] } : {}),
    image_clarity_parameter: clarity,
    ...(clarity ? { image_clarities: ['1K', '2K', '4K'], default_clarity: ['1K', '2K', '4K'].includes(String(existing.default_clarity)) ? existing.default_clarity : '2K' } : {}),
    async_image: true, request_template: request, request_templates: { text: { ...request }, reference: { ...request }, edit: { ...request } },
    get_path: 'tasks/{id}', id_path: 'task_id', status_path: 'status', error_path: 'error.message',
    success_statuses: ['completed'], failure_statuses: ['failed', 'expired', 'canceled', 'cancelled'],
    image_url_path: 'data.0.url', poll_seconds: existing.poll_seconds ?? 5,
    request_timeout_seconds: existing.request_timeout_seconds ?? 600,
    compress_reference_images: existing.compress_reference_images ?? true,
    ratios: existing.ratios ?? documentedImageRatios, default_ratio: existing.default_ratio ?? '1:1' }
}

export function documentedImageConfigError(settings: Settings): string | null {
  if (settings.image_api_profile !== documentedImageProfile) return null
  if (settings.async_image !== true) return 'Images 异步接口必须启用任务查询'
  if (settings.request_path !== 'images/generations' || !['images/edits', 'images/generations'].includes(String(settings.image_reference_path))) return 'Images 请求路径应为 images/generations 或 images/edits'
  if (settings.get_path !== 'tasks/{id}' || settings.id_path !== 'task_id') return 'Images 任务查询应使用 tasks/{id} 与 task_id'
  if (typeof settings.image_task_base_url === 'string') {
    try {
      if (/\/draw\/v1\/?$/.test(new URL(settings.image_task_base_url).pathname)) return '任务查询地址不应包含 /draw/v1，请使用站点的 /v1 地址'
    } catch { return '任务查询 API 地址必须是 HTTP 或 HTTPS 地址' }
  }
  if (!['ratio', 'pixels'].includes(String(settings.image_size_mode))) return '此图片接口的 size 应为比例或像素尺寸，不支持 auto'
  if (settings.image_reference_transport === 'multipart' && settings.image_reference_path !== 'images/edits') return '文件上传参考图应使用 images/edits'
  if (settings.image_reference_transport === 'multipart' && settings.image_reference_field !== 'image') return '文件上传应重复使用 image 字段'
  if (!['image', 'images'].includes(String(settings.image_reference_field))) return 'JSON 参考图字段应为 image 或 images 数组'
  if (settings.image_url_path !== 'data.0.url' || settings.image_base64_path) return '此接口的结果为 data[].url 图片地址'
  if (typeof settings.image_clarity_parameter !== 'boolean') return '清晰度参数支持设置必须为布尔值'
  if (settings.image_clarity_parameter && !['1K', '2K', '4K'].includes(String(settings.default_clarity))) return 'imageSize 默认清晰度应为 1K、2K 或 4K'
  const expected = { model: '{{model}}', prompt: '{{prompt}}', n: 1,
    size: settings.image_size_mode === 'pixels' ? '{{size}}' : '{{ratio}}',
    ...(settings.image_clarity_parameter ? { imageSize: '{{clarity}}' } : {}),
    [String(settings.image_reference_field)]: '{{images}}', async: true }
  const overrides = settings.request_templates
  if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) return '图片请求模板必须为对象'
  const templates = [settings.request_template, ...Object.values((overrides as Settings | undefined) ?? {})]
  if (templates.some(template => !template || typeof template !== 'object' || Array.isArray(template)
    || Object.keys(template).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => (template as Settings)[key] !== value))) return '图片请求模板应使用文档规定的字段并携带 async: true，请重新应用 Images API · 异步任务配置'
  if (typeof settings.poll_seconds !== 'number' || !Number.isFinite(settings.poll_seconds) || settings.poll_seconds < 1 || settings.poll_seconds > 60) return '任务查询间隔应为 1 到 60 秒'
  return null
}
