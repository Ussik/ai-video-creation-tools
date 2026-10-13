import { readFile, stat } from 'node:fs/promises'
import sharp from 'sharp'
import type { MediaAsset } from './providers.js'

type PreparedImage = { bytes: Buffer; mime: string; dataUrl: string }

/** Prepare upload copies only. Stored assets and video references are untouched. */
export async function prepareImageReferences(assets: MediaAsset[], compress = true): Promise<PreparedImage[]> {
  return Promise.all(assets.map(async (asset, index) => {
    if (asset.kind !== 'image') throw new Error('参考素材必须是图片')
    const file = await stat(asset.path)
    if (file.size > 20 * 1024 * 1024) throw new Error(`参考图 ${index + 1} 超过 20 MB，请使用较小的图片`)
    const metadata = await sharp(asset.path).metadata()
    const mimeByFormat: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
    let mime = mimeByFormat[metadata.format || '']
    if (!mime) throw new Error(`参考图 ${index + 1} 格式不支持，请使用 PNG、JPEG 或 WebP 图片`)
    let bytes: Buffer = await readFile(asset.path)
    if (compress && (bytes.length > 1024 * 1024 || Math.max(metadata.width || 0, metadata.height || 0) > 2048)) {
      const pipeline = sharp(bytes).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      const optimized = await (metadata.hasAlpha ? pipeline.webp({ lossless: true }) : pipeline.jpeg({ quality: 90, mozjpeg: true })).toBuffer()
      if (optimized.length < bytes.length) {
        bytes = optimized
        mime = metadata.hasAlpha ? 'image/webp' : 'image/jpeg'
      }
    }
    return { bytes, mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  }))
}

/** File bindings stay in the request template, so shared reference checks see them too. */
export function imageMultipartBody(payload: unknown, images: PreparedImage[]): FormData {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文件上传请求模板必须是对象')
  const form = new FormData(), sent = new Set<string>()
  const byDataUrl = new Map(images.map((image, index) => [image.dataUrl, { ...image, index }]))
  for (const [field, value] of Object.entries(payload)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || item === undefined) continue
      const image = typeof item === 'string' ? byDataUrl.get(item) : undefined
      if (image) {
        sent.add(image.dataUrl)
        form.append(field, new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `reference-${image.index + 1}.${image.mime.split('/')[1]}`)
      } else {
        form.append(field, typeof item === 'object' ? JSON.stringify(item) : String(item))
      }
    }
  }
  if (images.some(image => !sent.has(image.dataUrl))) throw new Error('文件上传请求未传递全部参考图，请将参考图参数直接绑定到 {{images}}')
  return form
}
