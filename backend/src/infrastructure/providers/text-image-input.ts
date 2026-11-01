import type { GenerationModel } from './providers.js'

export interface TextImageInput {
  /** Already decoded, bounded local pixels, never an arbitrary remote URL. */
  data_url: string
  detail?: 'low' | 'high' | 'auto'
}

export function withTextImageInput(body: unknown, images: readonly TextImageInput[] | undefined,
  protocol: GenerationModel['protocol'], settings: Record<string, unknown>): unknown {
  if (!images?.length) return body
  if (settings.supports_vision !== true) throw new Error('当前文本模型未启用图片理解，请选择支持图片理解的模型')
  if (protocol !== 'responses' && protocol !== 'chat_completions') throw new Error('图片理解仅支持 Responses 或 Chat Completions 协议')
  if (images.length > 8 || images.some(image => !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.data_url)
    || image.data_url.length > 6 * 1024 * 1024)) throw new Error('图片理解输入必须是有效且不超过 4 MB 的本地图片')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('图片理解请求模板必须为 JSON 对象')
  const request = body as Record<string, unknown>, key = protocol === 'responses' ? 'input' : 'messages'
  const value = request[key]
  const messages: unknown[] = typeof value === 'string' && protocol === 'responses' ? [{ role: 'user', content: value }]
    : Array.isArray(value) ? [...value] : []
  if (!messages.length) throw new Error(`图片理解请求模板需配置 ${key} 字段`)
  let selected = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user') { selected = index; break }
  }
  const parts = images.map(image => protocol === 'responses'
    ? { type: 'input_image', image_url: image.data_url, detail: image.detail || 'high' }
    : { type: 'image_url', image_url: { url: image.data_url, detail: image.detail || 'high' } })
  if (selected < 0) messages.push({ role: 'user', content: parts })
  else {
    const message = messages[selected] as Record<string, unknown>
    const content = typeof message.content === 'string'
      ? [{ type: protocol === 'responses' ? 'input_text' : 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : []
    messages[selected] = { ...message, content: [...content, ...parts] }
  }
  return { ...request, [key]: messages }
}

/** Base64 bytes are not text tokens. Keep all textual context in the capacity
 * check and reserve a bounded allowance per resized visual input instead. This
 * is an estimate; exact vision token accounting varies by provider. */
export function textImageCapacityBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(textImageCapacityBody)
  if (!body || typeof body !== 'object') return body
  const item = body as Record<string, unknown>
  if (item.type === 'input_image' && typeof item.image_url === 'string' && item.image_url.startsWith('data:image/')) {
    return { ...item, image_url: '[local image pixels]' }
  }
  if (item.type === 'image_url' && item.image_url && typeof item.image_url === 'object') {
    const image = item.image_url as Record<string, unknown>
    if (typeof image.url === 'string' && image.url.startsWith('data:image/')) return { ...item, image_url: { ...image, url: '[local image pixels]' } }
  }
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, textImageCapacityBody(value)]))
}
