export type GeminiImageAnalysisConfig = {
  enabled: boolean
  protocol: 'gemini_generate_content'
  api_base_url?: string
  remote_id?: string
  request_path?: string
}

type Settings = Record<string, unknown>

function settingsObject(value: unknown): Settings | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Settings : null
  } catch { return null }
}

/** This capability is explicit: an Images API model name is not evidence that
 * its provider exposes an image-to-text endpoint. */
export function imageAnalysisConfigError(settings: unknown): string | null {
  const parsed = settingsObject(settings)
  if (!parsed) return '模型配置必须为 JSON 对象'
  if (parsed.image_analysis === undefined) return null
  const config = settingsObject(parsed.image_analysis)
  if (!config || typeof parsed.image_analysis !== 'object') return 'image_analysis 图片反推配置必须为 JSON 对象'
  if (typeof config.enabled !== 'boolean') return 'image_analysis.enabled 必须为布尔值'
  if (config.protocol !== 'gemini_generate_content') return '图片反推协议必须为 gemini_generate_content'
  const fields = ['enabled', 'protocol', 'api_base_url', 'remote_id', 'request_path']
  if (Object.keys(config).some(key => !fields.includes(key))) return 'image_analysis 图片反推配置包含未知字段'
  for (const key of ['api_base_url', 'remote_id', 'request_path']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !(config[key] as string).trim())) return `image_analysis.${key} 必须为非空字符串`
  }
  if (typeof config.api_base_url === 'string') {
    try {
      const url = new URL(config.api_base_url.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { return '图片反推 API 地址必须是不含凭据、查询参数或片段的 HTTP 或 HTTPS 地址' }
  }
  if (typeof config.request_path === 'string') {
    const path = config.request_path.trim()
    if (path.startsWith('/') || path.includes('\\') || /[?#\s]/.test(path) || /^[a-z][a-z\d+.-]*:\/\//i.test(path)
      || path.split('/').some(segment => segment === '.' || segment === '..' || /%2e|%2f|%5c/i.test(segment))
      || /[{}]/.test(path.replaceAll('{model}', ''))) return '图片反推请求路径必须为有效相对路径，可使用 {model} 占位符'
  }
  return null
}

export function geminiImageAnalysisConfig(settings: unknown): GeminiImageAnalysisConfig | null {
  if (imageAnalysisConfigError(settings)) return null
  const value = settingsObject(settings)?.image_analysis
  const config = settingsObject(value)
  if (config?.enabled !== true) return null
  return {
    enabled: true, protocol: 'gemini_generate_content',
    ...(typeof config.api_base_url === 'string' ? { api_base_url: config.api_base_url.trim() } : {}),
    ...(typeof config.remote_id === 'string' ? { remote_id: config.remote_id.trim() } : {}),
    request_path: typeof config.request_path === 'string' ? config.request_path.trim() : 'models/{model}:generateContent',
  }
}

export function supportsImagePromptAnalysis(model: { modality: string; protocol?: string; settings: unknown }): boolean {
  const settings = settingsObject(model.settings)
  if (!settings) return false
  if (model.modality === 'text') return settings.supports_vision === true
    && (model.protocol === 'responses' || model.protocol === 'chat_completions')
  return model.modality === 'image' && geminiImageAnalysisConfig(settings) !== null
}
