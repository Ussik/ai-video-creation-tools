import { createHash } from 'node:crypto'
import type { MediaAsset } from './providers.js'
import type { MediaInputManifest, MediaInputRejection } from '@video-studio/shared/media/provider-inputs'
export type { MediaInputManifest, MediaInputRejection } from '@video-studio/shared/media/provider-inputs'
export function mediaInputManifest(body: unknown, images: readonly string[], references: readonly MediaAsset[], serializedBody?: string): MediaInputManifest {
  const known = new Map<string, string[]>()
  images.forEach((image, index) => { const id = references[index]?.id; if (id) known.set(image, [...new Set([...(known.get(image) || []), id])]) })
  const entries: MediaInputManifest['entries'] = []
  const visit = (value: unknown, field_path: string) => {
    if (typeof value === 'string') {
      const asset_ids = known.get(value)
      if (asset_ids) {
        const match = field_path.match(/(?:^|\.)content\[(\d+)\]/)
        entries.push({ field_path, ...(match ? { content_index: Number(match[1]) } : {}), asset_ids,
          digest: createHash('sha256').update(value).digest('hex'), encoded_bytes: Buffer.byteLength(value) })
      }
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${field_path}[${index}]`))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, field_path ? `${field_path}.${key}` : key)
  }
  visit(body, '')
  const raw = serializedBody ?? JSON.stringify(body), hashes = new Set(entries.map(entry => entry.digest))
  return { body_hash: createHash('sha256').update(raw).digest('hex'), request_bytes: Buffer.byteLength(raw),
    encoded_image_bytes: entries.reduce((sum, entry) => sum + entry.encoded_bytes, 0), duplicate_image_occurrences: entries.length - hashes.size, entries }
}
export function mediaInputRejection(raw: string, response: Response, manifest?: MediaInputManifest): MediaInputRejection {
  let code: string | undefined, message = ''
  try { const value = JSON.parse(raw); const error = value.error || value; code = error.code ?? error.Code; const detail = error.message ?? error.Message; message = typeof detail === 'string' ? detail : '' } catch { /* No payload-derived guesses. */ }
  const indices = [...new Set([...message.matchAll(/\bcontent\[(\d+)\]/g)].map(match => Number(match[1])))].slice(0, 64)
  const inputs = manifest?.entries.filter(entry => entry.content_index !== undefined && indices.includes(entry.content_index)) || []
  let bodyId: unknown
  try { const value = JSON.parse(raw); bodyId = value.request_id ?? value.RequestId ?? value.error?.request_id } catch { /* Headers remain available. */ }
  const id = response.headers.get('x-request-id') || response.headers.get('request-id') || (typeof bodyId === 'string' ? bodyId : undefined)
  return { status: 'provider_rejected', ...(typeof code === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(code) ? { upstream_code: code } : {}),
    ...(id && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id) ? { provider_request_id: id } : {}), content_indices: indices, inputs,
    mapping_status: !inputs.length ? 'unmapped' : indices.every(index => inputs.some(input => input.content_index === index)) ? 'matched' : 'partial' }
}
