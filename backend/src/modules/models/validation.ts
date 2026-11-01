import type { Model } from '../../infrastructure/database/db.js'
import { invalid } from '../../infrastructure/http/request.js'
import { documentedImageConfigError } from '@video-studio/shared/models/documented-images-api'
import { textContextConfigError } from '@video-studio/shared/models/text-context-settings'
import { imageAnalysisConfigError } from '@video-studio/shared/models/image-analysis-settings'
import { videoInputConfigError } from '@video-studio/shared/models/video-analysis-settings'

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
  if (settings.image_analysis !== undefined) {
    if (mod !== 'image') invalid('image_analysis 图片反推配置仅适用于图片模型')
    const issue = imageAnalysisConfigError(settings)
    if (issue) invalid(issue)
  }
  const keys = mod === 'video' ? ['create_path', 'get_path', 'request_template'] : ['request_path', 'request_template']
  for (const key of keys) if (settings[key] === undefined || settings[key] === null || settings[key] === '') invalid(`模型配置缺少 ${key}`)
  if (mod === 'video' && !String(settings.get_path).includes('{id}')) invalid('get_path 必须包含 {id}')
  if (mod === 'text' && !settings.text_path && !Array.isArray(settings.text_paths)) invalid('文本模型需配置 text_path 或 text_paths')
  if (mod === 'text' && settings.structured_output_mode !== undefined && !['prompt', 'json_object', 'json_schema'].includes(String(settings.structured_output_mode))) invalid('结构化输出模式必须为 prompt、json_object 或 json_schema')
  if (mod === 'text' && settings.supports_vision !== undefined && typeof settings.supports_vision !== 'boolean') invalid('supports_vision 必须为布尔值')
  if (mod === 'text' && settings.supports_video !== undefined && typeof settings.supports_video !== 'boolean') invalid('supports_video 必须为布尔值')
  if (settings.video_input_format !== undefined && mod !== 'text') invalid('video_input_format 视频理解配置仅适用于文本模型')
  if (mod === 'text') {
    const issue = videoInputConfigError(settings)
    if (issue) invalid(issue)
  }
  if (mod === 'text' && settings.strict_tool_arguments !== undefined && typeof settings.strict_tool_arguments !== 'boolean') invalid('strict_tool_arguments 必须为布尔值')
  if (mod === 'text') {
    const issue = textContextConfigError(settings)
    if (issue) invalid(issue)
  }
  if (mod === 'image' && !settings.image_base64_path && !settings.image_url_path) invalid('图片模型需配置 image_base64_path 或 image_url_path')
  if (mod === 'image') {
    const issue = documentedImageConfigError(settings)
    if (issue) invalid(issue)
    if (settings.request_timeout_seconds !== undefined && (typeof settings.request_timeout_seconds !== 'number'
      || !Number.isInteger(settings.request_timeout_seconds) || settings.request_timeout_seconds < 30 || settings.request_timeout_seconds > 1800)) invalid('图片请求超时必须为 30 到 1800 秒的整数')
    if (settings.image_reference_transport !== undefined && !['json', 'multipart'].includes(String(settings.image_reference_transport))) invalid('参考图传递方式必须为 json 或 multipart')
    if (settings.image_reference_path !== undefined && (typeof settings.image_reference_path !== 'string' || !settings.image_reference_path.trim()
      || /^https?:\/\//i.test(settings.image_reference_path))) invalid('参考图请求路径必须是非空相对路径')
    if (settings.compress_reference_images !== undefined && typeof settings.compress_reference_images !== 'boolean') invalid('参考图压缩设置必须为布尔值')
    if (settings.image_size_mode !== undefined && !['auto', 'pixels', 'ratio'].includes(String(settings.image_size_mode))) invalid('图片尺寸传递方式必须为 auto、pixels 或 ratio')
    if (settings.image_size_mode === 'pixels' && (!Array.isArray(settings.resolutions) || !settings.resolutions.length
      || settings.resolutions.some(size => typeof size !== 'string' || !/^[1-9]\d*x[1-9]\d*$/.test(size)))) invalid('请配置平台支持的图片像素尺寸，例如 1280x720')
  }
  if (settings.api_base_url !== undefined) {
    if (typeof settings.api_base_url !== 'string') invalid('api_base_url 必须是 HTTP 或 HTTPS 地址')
    checkBaseUrl(settings.api_base_url)
  }
  if (mod === 'image' && settings.image_task_base_url !== undefined) {
    if (typeof settings.image_task_base_url !== 'string') invalid('任务查询 API 地址必须是 HTTP 或 HTTPS 地址')
    checkBaseUrl(settings.image_task_base_url)
  }
  if (mod === 'image' && settings.async_image === true) {
    if (typeof settings.get_path !== 'string' || !settings.get_path.includes('{id}')) invalid('异步图片模型的 get_path 必须包含 {id}')
    if (typeof settings.id_path !== 'string' || !settings.id_path) invalid('异步图片模型需配置 id_path')
  }
}
