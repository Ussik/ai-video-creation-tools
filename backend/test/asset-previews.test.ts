import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'canvas-asset-previews-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { createAssetPreviewCache } = await import('../src/asset-previews.js')
const { buildApp } = await import('../src/server.js')
const { db, mediaDir, newId, now, run } = await import('../src/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
const svg = (color: string, width = 1600, height = 900) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`)

test('bounded previews reuse disk cache, invalidate changed files and never alter originals', async () => {
  const path = join(testData, 'large-image.svg'), directory = join(testData, 'image-cache')
  const original = svg('red'); await writeFile(path, original)
  const get = createAssetPreviewCache()
  const asset = { id: 'image', path, kind: 'image' }
  const first = await get(asset, 640, directory)
  const metadata = await sharp(first.bytes).metadata()
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 640); assert.equal(metadata.height, 360)
  assert.deepEqual(await readFile(path), original)
  const repeated = await Promise.all(Array.from({ length: 8 }, () => get(asset, 640, directory)))
  assert.ok(repeated.every(preview => preview.etag === first.etag && preview.bytes.equals(first.bytes)))
  assert.equal((await readdir(directory)).length, 1)
  await writeFile(path, svg('blue', 1200, 600))
  const changed = await get(asset, 640, directory)
  assert.notEqual(changed.etag, first.etag); assert.ok(!changed.bytes.equals(first.bytes))
})

test('concurrent video poster requests extract once per asset and cap simultaneous media work', async () => {
  let calls = 0, running = 0, maximum = 0
  const get = createAssetPreviewCache(async () => {
    calls++; running++; maximum = Math.max(maximum, running)
    await new Promise(resolve => setTimeout(resolve, 15)); running--
    return svg('green')
  })
  const path = join(testData, 'stub-video'), directory = join(testData, 'video-cache')
  await writeFile(path, 'video-input')
  const assets = Array.from({ length: 5 }, (_, index) => ({ id: `video-${index}`, path, kind: 'video' }))
  const results = await Promise.all(assets.flatMap(asset => Array.from({ length: 4 }, () => get(asset, 320, directory))))
  assert.equal(calls, 5); assert.ok(maximum <= 2); assert.equal(results.length, 20)
  await get(assets[0]!, 320, directory); assert.equal(calls, 5, 'disk hit does not decode video again')
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0)
})

test('preview endpoint handles image/video, revalidation, invalid inputs and deleted assets', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '预览验证' } })).json<{ id: string }>()
  async function asset(kind: string, path: string) {
    const id = newId()
    run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, 'uploaded', NULL, NULL, NULL, ?)`, id, project.id, kind, 'preview', path, now())
    return id
  }
  const imagePath = join(testData, 'http-image.svg'); await writeFile(imagePath, svg('yellow'))
  const imageId = await asset('image', imagePath)
  const response = await app.inject(`/api/assets/${imageId}/preview?size=640`)
  assert.equal(response.statusCode, 200); assert.match(String(response.headers['content-type']), /image\/webp/)
  const cached = await app.inject({ url: `/api/assets/${imageId}/preview?size=640`, headers: { 'if-none-match': String(response.headers.etag) } })
  assert.equal(cached.statusCode, 304); assert.equal(cached.rawPayload.length, 0)
  assert.equal((await app.inject(`/api/assets/${imageId}/preview?size=20000`)).statusCode, 422)
  const audioId = await asset('audio', imagePath)
  assert.equal((await app.inject(`/api/assets/${audioId}/preview`)).statusCode, 422)
  const videoPath = join(testData, 'poster.mp4')
  await promisify(execFile)(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:d=0.2', '-pix_fmt', 'yuv420p', videoPath])
  const videoId = await asset('video', videoPath)
  const poster = await app.inject(`/api/assets/${videoId}/preview?size=320`)
  assert.equal(poster.statusCode, 200, poster.body.slice(0, 200))
  assert.equal((await sharp(poster.rawPayload).metadata()).width, 96, 'small media is not enlarged')
  run('DELETE FROM assets WHERE id=?', imageId)
  assert.equal((await app.inject(`/api/assets/${imageId}/preview`)).statusCode, 404, 'orphaned cache cannot expose a deleted asset')
  assert.ok((await readdir(join(mediaDir, project.id, '.previews'))).length > 0)
})
