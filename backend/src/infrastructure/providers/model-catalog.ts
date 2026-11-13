import type { Provider } from '../database/db.js'
import type { TextCapabilityDiscovery } from '@video-studio/shared/models/text-capabilities'
import { decryptKey } from '../security/secrets.js'
import { discoverCatalogCapabilities, type CatalogCapabilityContext } from './model-catalog-capabilities.js'

export interface ModelCatalogConfig {
  path: string
  list_path: string
  id_path: string
  name_path: string
  modality_path: string
}

export interface CatalogModel {
  remote_id: string
  name: string
  modality_hint: 'text' | 'image' | 'video' | null
  capabilities?: TextCapabilityDiscovery
}

const maxResponseBytes = 2 * 1024 * 1024
const maxModels = 1000

function catalogError(message: string, statusCode = 502): Error {
  return Object.assign(new Error(message), { statusCode })
}

function connectionError(error: unknown, url: string): Error {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return catalogError(`模型列表接口请求超时：${url}`)
  }
  const cause = error instanceof Error && 'cause' in error ? error.cause : null
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return catalogError(`无法解析模型列表接口域名：${new URL(url).hostname}（${code}）`)
  }
  return catalogError(`无法连接模型列表接口：${url}${code ? `（${code}）` : ''}`)
}

function relativeCatalogUrl(base: string, path: string): string {
  let baseUrl: URL
  try { baseUrl = new URL(base) } catch { throw catalogError('提供商 API 地址无效', 422) }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw catalogError('提供商 API 地址必须是不含凭据或查询参数的 HTTP 地址', 422)
  }
  if (!path || path.startsWith('/') || path.includes('\\') || /[?#]/.test(path) ||
    path.split('/').some(segment => segment === '.' || segment === '..' || /%2e|%2f|%5c/i.test(segment))) {
    throw catalogError('获取模型路径必须是相对于 API 地址的路径', 422)
  }
  const url = new URL(`${base.replace(/\/+$/, '')}/${path}`)
  if (url.origin !== baseUrl.origin || url.pathname !== `${baseUrl.pathname.replace(/\/+$/, '')}/${path}`) {
    throw catalogError('获取模型路径超出了提供商 API 地址', 422)
  }
  return url.toString()
}

function atPath(value: unknown, path: string): unknown {
  if (!path) return value
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, value)
}

function modalityHint(value: unknown): CatalogModel['modality_hint'] {
  const values = Array.isArray(value) ? value : [value]
  const found = new Set<'text' | 'image' | 'video'>()
  for (const item of values) {
    if (typeof item !== 'string') continue
    const normalized = item.trim().toLowerCase()
    if (normalized === 'text' || normalized === 'image' || normalized === 'video') found.add(normalized)
  }
  return found.size === 1 ? ([...found][0] ?? null) : null
}

function explicitModality(entry: unknown, configuredPath?: string): CatalogModel['modality_hint'] {
  if (configuredPath) return modalityHint(atPath(entry, configuredPath))
  for (const field of ['modalities', 'output_modalities', 'input_modalities', 'type']) {
    const hint = modalityHint(atPath(entry, field))
    if (hint) return hint
  }
  return null
}

export function parseCatalog(payload: unknown, config: ModelCatalogConfig, context?: CatalogCapabilityContext): CatalogModel[] {
  const list = atPath(payload, config.list_path)
  if (!Array.isArray(list)) throw catalogError(`获取模型响应中的 ${config.list_path || '根节点'} 不是数组`)
  if (list.length > maxModels) throw catalogError(`获取模型响应超过 ${maxModels} 项，请缩小目录范围`)
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const entry of list) {
    const rawId = atPath(entry, config.id_path)
    if (typeof rawId !== 'string' || !rawId.trim()) continue
    const remoteId = rawId.trim()
    if (seen.has(remoteId)) continue
    seen.add(remoteId)
    const rawName = config.name_path ? atPath(entry, config.name_path) : undefined
    const hint = explicitModality(entry, config.modality_path)
    const capabilities = context && hint !== 'image' && hint !== 'video' ? discoverCatalogCapabilities(entry, remoteId, context) : undefined
    models.push({
      remote_id: remoteId,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : remoteId,
      modality_hint: hint,
      ...(capabilities ? { capabilities } : {}),
    })
  }
  return models
}

export async function fetchModelCatalog(provider: Provider, config: ModelCatalogConfig, apiKeyOverride?: string): Promise<CatalogModel[]> {
  const url = relativeCatalogUrl(provider.base_url, config.path)
  const key = apiKeyOverride ?? decryptKey(provider.key_ciphertext)
  const customAuth = provider.auth_header && (provider.auth_header.toLowerCase() !== 'authorization' || (provider.auth_prefix ?? 'Bearer ') !== 'Bearer ')
  const nativeMessages = provider.protocol === 'anthropic_messages'
  const header = nativeMessages && !customAuth ? 'x-api-key' : provider.auth_header || 'Authorization'
  const prefix = nativeMessages && !customAuth ? '' : provider.auth_prefix ?? 'Bearer '
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || /[\r\n]/.test(prefix)) {
    throw catalogError('提供商鉴权配置无效', 422)
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...(nativeMessages ? { 'anthropic-version': '2023-06-01' } : {}), ...(key ? { [header]: `${prefix}${key}` } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw connectionError(error, url)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw catalogError(`模型列表接口返回 HTTP ${response.status} 跳转：${url}，请填写最终 API 根地址`, 422)
  }
  if (!response.ok) {
    await response.body?.cancel()
    const hint = response.status === 401 || response.status === 403 ? '，请检查 API 密钥' :
      response.status === 404 ? '，请检查 API 地址是否为接口根地址' : ''
    throw catalogError(`模型列表接口 ${url} 返回 HTTP ${response.status}${hint}`)
  }
  const length = Number(response.headers.get('content-length'))
  if (length > maxResponseBytes) {
    await response.body?.cancel()
    throw catalogError('获取模型响应超过 2 MB')
  }
  if (!response.body) throw catalogError('获取模型接口没有返回内容')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > maxResponseBytes) throw catalogError('获取模型响应超过 2 MB')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error
    throw catalogError('读取模型列表失败')
  }
  let payload: unknown
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch {
    const isHtml = response.headers.get('content-type')?.includes('text/html')
    throw catalogError(isHtml
      ? `模型列表接口返回网页而非 JSON：${url}，请填写 API 根地址`
      : `模型列表接口没有返回有效 JSON：${url}`)
  }
  return parseCatalog(payload, config, provider.protocol ? {
    base_url: provider.base_url, protocol: provider.protocol, fetched_at: new Date().toISOString(),
  } : undefined)
}
