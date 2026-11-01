import type { GenerationModel } from './providers.js'
import { supportsDoubaoVideoAnalysis, videoInputConfigError } from '@video-studio/shared/models/video-analysis-settings'

/** Native video input is an explicit provider capability, independent of model name. */
export interface TextVideoInput { data_url: string; duration_ms: number; fps?: number }
export function withTextVideoInput(body: unknown, video: TextVideoInput | undefined,
  protocol: GenerationModel['protocol'], settings: Record<string, unknown>): unknown {
  if (!video) return body
  const issue = videoInputConfigError(settings)
  if (issue) throw new Error(issue)
  const doubao = supportsDoubaoVideoAnalysis({ modality: 'text', protocol, settings })
  if (!doubao && (settings.supports_video !== true || protocol !== 'chat_completions' || settings.video_input_format === 'doubao_ark')) {
    throw new Error('整段视频理解需要已确认支持 video_url 的 Chat Completions 模型，或配置豆包视频理解格式')
  }
  const prefix = 'data:video/mp4;base64,', encoded = video.data_url.startsWith(prefix) ? video.data_url.slice(prefix.length) : ''
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const bytes = encoded.length / 4 * 3 - padding
  if (!Number.isSafeInteger(video.duration_ms) || video.duration_ms <= 0 || video.duration_ms > (doubao ? 180_000 : 60_000)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0 || bytes <= 0
    || (doubao ? bytes >= 50 * 1024 * 1024 || video.data_url.length >= 64 * 1024 * 1024 : bytes > 25 * 1024 * 1024)) {
    throw new Error(doubao ? '豆包视频理解输入必须为小于 50 MB、最长 180 秒的本地 MP4，Base64 请求需小于 64 MB'
      : '视频理解输入必须是不超过 25 MB、60 秒的本地 MP4 视频')
  }
  if (video.fps !== undefined && (!doubao || !Number.isFinite(video.fps) || video.fps < 0.2 || video.fps > 5)) throw new Error('豆包视频采样率必须为 0.2 到 5 FPS')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('视频理解请求模板必须为 JSON 对象')
  const request = body as Record<string, unknown>
  const key = protocol === 'responses' ? 'input' : 'messages'
  const source = request[key]
  const messages: unknown[] = protocol === 'responses' && typeof source === 'string' ? [{ role: 'user', content: source }]
    : Array.isArray(source) ? [...source] : []
  if (!messages.length) throw new Error(`视频理解请求模板需配置 ${key} 消息数组`)
  let selected = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && typeof messages[i] === 'object' && (messages[i] as Record<string, unknown>).role === 'user') { selected = i; break }
  }
  const part = protocol === 'responses' ? { type: 'input_video', video_url: video.data_url, ...(video.fps !== undefined ? { fps: video.fps } : {}) }
    : { type: 'video_url', video_url: { url: video.data_url, ...(video.fps !== undefined ? { fps: video.fps } : {}) } }
  if (selected < 0) messages.push({ role: 'user', content: [part] })
  else {
    const message = messages[selected] as Record<string, unknown>
    const content = typeof message.content === 'string' ? [{ type: protocol === 'responses' ? 'input_text' : 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : []
    messages[selected] = { ...message, content: [...content, part] }
  }
  const result = { ...request, [key]: messages }
  if (doubao && new TextEncoder().encode(JSON.stringify(result)).length >= 64 * 1024 * 1024) throw new Error('豆包视频理解请求体需小于 64 MB，请缩小视频片段或降低分辨率')
  return result
}
/** Keep video bytes out of text-token estimates and diagnostic snapshots. */
export function textVideoCapacityBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(textVideoCapacityBody)
  if (!body || typeof body !== 'object') return body
  const item = body as Record<string, unknown>
  if (item.type === 'input_video' && typeof item.video_url === 'string' && item.video_url.startsWith('data:video/')) {
    return { ...item, video_url: '[local video bytes]' }
  }
  if (item.type === 'video_url' && item.video_url && typeof item.video_url === 'object') {
    const video = item.video_url as Record<string, unknown>
    if (typeof video.url === 'string' && video.url.startsWith('data:video/')) return { ...item, video_url: { ...video, url: '[local video bytes]' } }
  }
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, textVideoCapacityBody(value)]))
}
