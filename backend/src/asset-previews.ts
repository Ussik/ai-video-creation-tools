import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { extractVideoFrame } from './render.js'

type PreviewAsset = { id: string; path: string; kind: string }
type Preview = { bytes: Buffer; etag: string }

/** Disk-backed previews avoid decoding full media in each unselected card. */
export function createAssetPreviewCache(extractFrame = extractVideoFrame) {
  const pending = new Map<string, Promise<Preview>>()
  const waiting: Array<() => void> = []
  let running = 0
  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (running < 2) running++
    else await new Promise<void>(resolve => waiting.push(resolve))
    try { return await work() } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }

  return async (asset: PreviewAsset, size: number, directory: string): Promise<Preview> => {
    if (!['image', 'video'].includes(asset.kind)) throw new Error('仅图片或视频支持预览')
    if (![320, 640, 960].includes(size)) throw new Error('预览尺寸无效')
    const source = await stat(asset.path)
    const key = createHash('sha256').update(JSON.stringify(['v1', asset.id, asset.kind, asset.path, source.size, source.mtimeMs, size])).digest('hex')
    const etag = `"${key}"`
    const path = join(directory, `${key}.webp`)
    try { return { bytes: await readFile(path), etag } } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const existing = pending.get(path)
    if (existing) return existing
    const task = limited(async () => {
      // A queued request may find a preview produced by an earlier batch.
      try { return { bytes: await readFile(path), etag } } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Read current bytes so libvips' filename cache cannot reuse an overwritten source.
      const input = asset.kind === 'video' ? await extractFrame(asset.path, 0) : await readFile(asset.path)
      const bytes = await sharp(input).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 3 }).toBuffer()
      await mkdir(directory, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try { await writeFile(temporary, bytes); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
      return { bytes, etag }
    })
    pending.set(path, task)
    try { return await task } finally { pending.delete(path) }
  }
}

export const getAssetPreview = createAssetPreviewCache()
