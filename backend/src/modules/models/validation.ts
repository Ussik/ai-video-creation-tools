import type { Model } from '../../infrastructure/database/db.js'
import { invalid } from '../../infrastructure/http/request.js'

export function checkBaseUrl(value: string): void {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return
  } catch { /* Handled below. */ }
  invalid('厂商 Base URL 必须是 HTTP 或 HTTPS 地址')
}

export function checkProtocol(mod: Model['modality'], kind: Model['protocol']): void {
  if ((mod === 'text' && ['responses', 'chat_completions'].includes(kind)) ||
    (mod === 'image' && kind === 'image_generations') ||
    (mod === 'video' && kind === 'async_video')) return
  invalid('模型类型与接口协议不匹配')
}

export function validateSettings(mod: Model['modality'], settings: Record<string, unknown>): void {
  const keys = mod === 'video' ? ['create_path', 'get_path', 'request_template'] : ['request_path', 'request_template']
  for (const key of keys) if (settings[key] === undefined || settings[key] === null || settings[key] === '') invalid(`模型配置缺少 ${key}`)
  if (mod === 'video' && !String(settings.get_path).includes('{id}')) invalid('get_path 必须包含 {id}')
  if (mod === 'text' && !settings.text_path && !Array.isArray(settings.text_paths)) invalid('文本模型需配置 text_path 或 text_paths')
  if (mod === 'text' && settings.structured_output_mode !== undefined && !['prompt', 'json_object', 'json_schema'].includes(String(settings.structured_output_mode))) invalid('结构化输出模式必须为 prompt、json_object 或 json_schema')
  if (mod === 'text' && settings.strict_tool_arguments !== undefined && typeof settings.strict_tool_arguments !== 'boolean') invalid('strict_tool_arguments 必须为布尔值')
  if (mod === 'image' && !settings.image_base64_path && !settings.image_url_path) invalid('图片模型需配置 image_base64_path 或 image_url_path')
  if (settings.api_base_url !== undefined) {
    if (typeof settings.api_base_url !== 'string') invalid('api_base_url 必须是 HTTP 或 HTTPS 地址')
    checkBaseUrl(settings.api_base_url)
  }
  if (mod === 'image' && settings.async_image === true) {
    if (typeof settings.get_path !== 'string' || !settings.get_path.includes('{id}')) invalid('异步图片模型的 get_path 必须包含 {id}')
    if (typeof settings.id_path !== 'string' || !settings.id_path) invalid('异步图片模型需配置 id_path')
  }
}
