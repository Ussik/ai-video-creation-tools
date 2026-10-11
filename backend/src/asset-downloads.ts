import type { FastifyInstance } from 'fastify'
import { createReadStream, type ReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { PassThrough } from 'node:stream'
import { ZipFile } from 'yazl'
import { z } from 'zod'
import { newId, one, required, type Asset, type Project } from './db.js'

const id = z.string().min(1).max(120)
const selection = z.object({ asset_ids: z.array(id).min(1).max(1000) }).strict()
const params = z.object({ id, downloadId: id })
type DownloadFile = { asset: Asset; size: number; mtime: Date }
type PreparedDownload = { projectId: string; assetIds: string[]; filename: string; expires: number }
function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }

function safeFilename(value: string, fallback: string): string {
  let name = (value.split(/[\\/]/).pop() || '').replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/, '')
  if (!name) return fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  const extension = extname(name).slice(0, 20)
  return name.length > 180 ? name.slice(0, 180 - extension.length) + extension : name
}
function attachment(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${filename.endsWith('.zip') ? 'assets.zip' : 'asset' + extname(filename).replace(/[^.a-z0-9]/gi, '')}"; filename*=UTF-8''${encoded}`
}

async function downloadFiles(projectId: string, assetIds: string[]): Promise<DownloadFile[]> {
  required<Project>('projects', projectId)
  const files: DownloadFile[] = []
  for (const assetId of assetIds) {
    const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=?', assetId, projectId)
    if (!asset) fail('选中的素材不存在或不属于当前项目，请刷新后重试', 404)
    try {
      const file = await open(asset.path, 'r')
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new Error('Not a file')
        files.push({ asset, size: info.size, mtime: info.mtime })
      } finally { await file.close() }
    } catch { fail(`素材文件不存在或无法读取：${asset.filename}`, 404) }
  }
  return files
}

export function registerAssetDownloadRoutes(app: FastifyInstance): void {
  // Short-lived descriptors let the browser stream the attachment directly,
  // without buffering videos in JavaScript or placing every ID in a long URL.
  const prepared = new Map<string, PreparedDownload>()
  app.addHook('onClose', async () => { prepared.clear() })
  app.post('/api/projects/:id/asset-downloads', async request => {
    const { id: projectId } = z.object({ id }).parse(request.params)
    const { asset_ids } = selection.parse(request.body)
    const assetIds = [...new Set(asset_ids)]
    const files = await downloadFiles(projectId, assetIds)
    const project = required<Project>('projects', projectId)
    const filename = files.length === 1 ? safeFilename(files[0]!.asset.filename, 'asset')
      : `${safeFilename(project.name, 'project')}-素材-${files.length}.zip`
    const now = Date.now()
    for (const [key, download] of prepared) if (download.expires <= now) prepared.delete(key)
    while (prepared.size >= 100) prepared.delete(prepared.keys().next().value!)
    const downloadId = newId()
    prepared.set(downloadId, { projectId, assetIds, filename, expires: now + 10 * 60_000 })
    return { url: `/api/projects/${encodeURIComponent(projectId)}/asset-downloads/${downloadId}`, filename, count: files.length }
  })
  app.get('/api/projects/:id/asset-downloads/:downloadId', async (request, reply) => {
    const { id: projectId, downloadId } = params.parse(request.params)
    const download = prepared.get(downloadId)
    if (!download || download.projectId !== projectId || download.expires <= Date.now()) fail('下载链接已失效，请重新点击下载', 404)
    const files = await downloadFiles(projectId, download.assetIds)
    reply.header('Content-Disposition', attachment(download.filename)).header('Cache-Control', 'no-store')
    if (files.length === 1) {
      reply.type('application/octet-stream').header('Content-Length', files[0]!.size)
      if (request.method === 'HEAD') return reply.send()
      return reply.send(createReadStream(files[0]!.asset.path))
    }
    reply.type('application/zip')
    if (request.method === 'HEAD') return reply.send()
    const zip = new ZipFile(), names = new Set<string>(), inputs = new Set<ReadStream>()
    // yazl exposes a PassThrough; its declarations use the older, broader
    // NodeJS.ReadableStream type and omit the size callback argument.
    const output = zip.outputStream as PassThrough
    zip.on('error', error => output.destroy(error))
    output.on('close', () => { for (const input of inputs) input.destroy() })
    reply.raw.on('close', () => output.destroy())
    for (const { asset, size, mtime } of files) {
      const original = safeFilename(asset.filename, `${asset.id}.bin`), extension = extname(original)
      let name = original, suffix = 2
      while (names.has(name.toLowerCase())) name = `${original.slice(0, original.length - extension.length)} (${suffix++})${extension}`
      names.add(name.toLowerCase())
      zip.addReadStreamLazy(name, { compress: false, size, mtime }, callback => {
        if (output.destroyed) { zip.emit('error', new Error('下载已取消')); return }
        const input = createReadStream(asset.path)
        inputs.add(input); input.once('close', () => inputs.delete(input))
        callback(null, input)
      })
    }
    zip.end({ forceZip64Format: false, comment: '' }, (size?: number) => { if (size !== undefined && size >= 0) reply.header('Content-Length', size) })
    return reply.send(output)
  })
}
